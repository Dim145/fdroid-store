from __future__ import annotations

import re
import tempfile
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession, get_current_user, get_current_uploader, get_uploader_for_app
from app.core.download_token import DEFAULT_TTL_SECONDS, sign_download_token
from app.core.logging import get_logger
from app.core.rate_limit import limiter
from app.fdroid.apk_parser import ApkMetadata, ApkParseError, parse_apk
from app.models.apk import Apk, ApkStatus, ReproducibilityStatus
from app.models.apk_sbom import ApkCve, ApkSbom, ApkSbomStatus
from app.models.app import App, AppStatus, AppVisibility
from app.models.package_signer import PackageSignerPin
from app.models.repo_config import RepoConfig
from app.models.user import User, UserRole
from app.schemas.apk_proxy import (
    ProxyApkInspect,
    ProxyInspectRequest,
)
from app.schemas.app import (
    ApkInspect,
    ApkRead,
    ApkUpdate,
    CveFinding,
    GithubApkInspect,
    GithubInspectRequest,
    ReproducibilityFromUrl,
    ReproducibilitySet,
    SbomRead,
)
from app.services.audit import write_event
from app.services.queue import enqueue_cve_scan, enqueue_reindex
from app.storage import get_storage

router = APIRouter()
log = get_logger(__name__)

# Loose BCP47: 2-3 letter primary subtag optionally followed by a region or
# script subtag. Matches the shape used by the app localizations endpoint.
_LOCALE_RE = re.compile(r"^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,4})?$")


# --------------------------------------------------------------------------
# Helpers (also used by /apps/with-apk)
# --------------------------------------------------------------------------
async def save_upload_to_temp(upload: UploadFile, *, max_bytes: int) -> Path:
    """Stream an UploadFile to a NamedTemporaryFile, refusing anything past
    ``max_bytes``. Caller cleans up. The cap is fed from
    ``RepoConfig.upload_max_apk_mb`` and is admin-configurable from the UI.
    A partial file written before the cap-hit is unlinked before raising,
    so a flood of oversized uploads doesn't fill the tmpfs (CWE-770).
    """
    if not upload.filename or not upload.filename.lower().endswith(".apk"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Expected an .apk file",
        )
    total = 0
    path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".apk", delete=False) as tmp:
            path = Path(tmp.name)
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail=(
                            f"APK exceeds the configured {max_bytes} byte limit"
                        ),
                    )
                tmp.write(chunk)
    except Exception:
        if path is not None:
            path.unlink(missing_ok=True)
        raise
    return path


async def _apk_size_cap_bytes(db) -> int:
    """Look up the admin-set cap from RepoConfig."""
    config = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
    mb = config.upload_max_apk_mb if config else 200
    return mb * 1024 * 1024


async def _maybe_scan_upload(db, *, tmp_path) -> None:
    """Run clamd against the uploaded APK if the operator opted in.

    Three branches:
      * env knob unset → no-op (feature disabled at deployment)
      * admin toggled scan_on_upload off → no-op
      * scanner returns INFECTED → 422 with the signature name, refuse
        the upload before any DB write
    A scanner *error* (unreachable, timeout) is treated as a hard fail —
    blocking is safer than silently letting a maybe-malicious APK through
    when the operator explicitly asked for synchronous scanning.
    """
    from app.core.config import settings as _settings

    if not _settings.clamav_available:
        return
    config = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
    if config is None or not config.clamav_scan_on_upload:
        return
    from app.services.clamav import scan_path

    result = await scan_path(tmp_path)
    if result.clean:
        return
    if result.signature:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Malware detected: {result.signature}",
        )
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=f"Malware scanner unavailable: {result.error}",
    )


async def parse_or_400(path: Path) -> ApkMetadata:
    try:
        return await parse_apk(path)
    except ApkParseError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid APK: {exc}",
        ) from exc


async def attach_apk_to_app(
    db,
    *,
    app: App,
    tmp_path: Path,
    meta: ApkMetadata,
    uploader: User,
) -> Apk:
    """Validate + persist a parsed APK against an existing App."""
    if meta.package_name != app.package_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"APK package {meta.package_name!r} does not match app "
                f"{app.package_name!r}"
            ),
        )
    if app.locked_signer_sha256 and app.locked_signer_sha256 != meta.signer_sha256:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="APK signer does not match the signer of previously published APKs",
        )
    # C1: cross-App signer pin. ``App.locked_signer_sha256`` lived on the App
    # row, so deleting the app dropped the pin and let a different user
    # re-register the same package with a different signing certificate.
    # ``package_signers`` is a separate table keyed on package_name only —
    # it survives App deletion and locks the signer permanently per Android
    # package name (the same trust contract F-Droid clients enforce).
    pin = (
        await db.execute(
            select(PackageSignerPin).where(PackageSignerPin.package_name == app.package_name)
        )
    ).scalar_one_or_none()
    if pin is not None and pin.signer_sha256 != meta.signer_sha256:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "This package was previously published with a different signing certificate. "
                "Use the original keystore or pick a new package name."
            ),
        )
    dup = (await db.execute(select(Apk).where(Apk.sha256 == meta.sha256))).scalar_one_or_none()
    if dup is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"This APK is already uploaded (id={dup.id})",
        )
    if any(a.version_code == meta.version_code for a in app.apks):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"versionCode {meta.version_code} already exists for this app",
        )

    storage = get_storage()
    target_name = f"{app.package_name}_{meta.version_code}.apk"
    storage_key = f"apks/{app.package_name}/{target_name}"
    with tmp_path.open("rb") as fh:
        await storage.put(
            storage_key, fh, content_type="application/vnd.android.package-archive"
        )

    # Auto-extract icon from the APK (unless the admin set a custom one).
    # We always store the latest extracted icon at icons/<pkg>.png so the
    # index always references a fresh hash for each version.
    if meta.icon_data and not app.icon_is_custom:
        try:
            import io as _io
            from PIL import Image as _Image
            with _Image.open(_io.BytesIO(meta.icon_data)) as raw:
                img = raw.convert("RGBA")
                img.thumbnail((512, 512), _Image.LANCZOS)
                buf = _io.BytesIO()
                img.save(buf, format="PNG", optimize=True)
                png_bytes = buf.getvalue()
            icon_key = f"icons/{app.package_name}.png"
            await storage.put(icon_key, png_bytes, content_type="image/png")
            app.icon_path = icon_key
        except Exception as exc:  # noqa: BLE001
            log.warning("could not store extracted icon", app=app.package_name, error=str(exc))

    # Admin uploads auto-publish; regular user uploads await review.
    initial_status = (
        ApkStatus.PUBLISHED if uploader.role == UserRole.ADMIN else ApkStatus.PENDING_REVIEW
    )
    apk = Apk(
        app_id=app.id,
        storage_key=storage_key,
        file_name=target_name,
        size_bytes=meta.size_bytes,
        sha256=meta.sha256,
        version_code=meta.version_code,
        version_name=meta.version_name,
        min_sdk=meta.min_sdk,
        target_sdk=meta.target_sdk,
        max_sdk=meta.max_sdk,
        signer_sha256=meta.signer_sha256,
        permissions=meta.permissions,
        features=meta.features,
        native_code=meta.native_code,
        locales=meta.locales,
        status=initial_status,
        uploaded_by_id=uploader.id,
        published_at=datetime.now(UTC) if initial_status == ApkStatus.PUBLISHED else None,
    )
    db.add(apk)
    if initial_status == ApkStatus.PUBLISHED:
        if app.locked_signer_sha256 is None:
            app.locked_signer_sha256 = meta.signer_sha256
        # Also lock the signer in the cross-App pin table so the same
        # package name can't be re-registered with a different signer if
        # this App is ever deleted (C1).
        if pin is None:
            db.add(
                PackageSignerPin(
                    package_name=app.package_name,
                    signer_sha256=meta.signer_sha256,
                    locked_by_app_id=app.id,
                    first_locked_at=datetime.now(UTC),
                )
            )
        # Auto-bump the suggested version only when the owner hasn't pinned
        # one. With a manual pin the F-Droid client keeps offering the chosen
        # version even after a new (possibly regressed) upload.
        if not app.suggested_version_is_manual:
            app.suggested_version_code = max(app.suggested_version_code or 0, meta.version_code)
            app.suggested_version_name = meta.version_name
        app.status = AppStatus.PUBLISHED
        app.last_published_at = datetime.now(UTC)

    await db.flush()
    log.info(
        "apk attached",
        apk_id=str(apk.id),
        app=app.package_name,
        version_code=apk.version_code,
        status=apk.status.value,
    )
    # Schedule a CVE scan for the newly-attached binary. The worker
    # short-circuits when the feature toggle is off, so this is safe
    # to call unconditionally — keeps the enqueue logic local to the
    # "we just created an APK" call sites.
    await enqueue_cve_scan(apk.id)
    return apk


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@router.post("/inspect", response_model=ApkInspect)
@limiter.limit("10/minute")
async def inspect_apk(
    request: Request,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
    file: UploadFile = File(...),
) -> ApkInspect:
    """Parse an APK and return its metadata. Stages the bytes for the
    follow-up create / add-APK step so the SPA doesn't re-upload the
    file once the user confirms — see the staging-token design note in
    ``app/core/download_token.py``.

    Rate-limited (``10/min``) + quota-pre-checked: this endpoint persists
    bytes under ``staging/<sha>.apk``, so without these gates an
    authenticated user could fill the storage backend by repeatedly
    staging different APKs without ever confirming.
    """
    tmp_path = await save_upload_to_temp(file, max_bytes=await _apk_size_cap_bytes(db))
    try:
        # Pre-flight quota gate — same call the confirm step makes, so a
        # user who would fail the final upload can't sneak past by
        # staging dozens of files first. The temp file is already on
        # disk; we check before committing it to durable storage.
        from app.services.quotas import ensure_can_upload_apk as _ensure_quota
        await _ensure_quota(db, user, incoming_size_bytes=tmp_path.stat().st_size)
        meta = await parse_or_400(tmp_path)
        # Run the lightweight DEX/class-name scan to suggest anti-feature
        # chips. Failures here are non-fatal — inspect just returns the
        # metadata it has and an empty suggestions dict.
        try:
            from app.fdroid.anti_feature_scan import scan_apk, summarise

            detected = summarise(scan_apk(tmp_path))
        except Exception:  # noqa: BLE001
            detected = {}
        # Stage the bytes under ``staging/<sha256>.apk`` so the create
        # flow can redeem without a second upload. SHA-256-keyed → two
        # callers staging the same APK overwrite each other harmlessly.
        # If staging fails (S3 outage, local disk full), the caller
        # falls back to the legacy double-upload flow.
        staging_token: str | None = None
        try:
            from app.core.download_token import sign_staging_token

            storage = get_storage()
            staging_key = f"staging/{meta.sha256}.apk"
            with tmp_path.open("rb") as fh:
                await storage.put(
                    staging_key, fh,
                    content_type="application/vnd.android.package-archive",
                )
            staging_token = sign_staging_token(meta.sha256, user.id)
        except Exception as exc:  # noqa: BLE001
            log.warning("apk staging failed; falling back to re-upload flow", error=str(exc))
        return ApkInspect(
            package_name=meta.package_name,
            app_name=meta.app_name,
            version_code=meta.version_code,
            version_name=meta.version_name,
            min_sdk=meta.min_sdk,
            target_sdk=meta.target_sdk,
            sha256=meta.sha256,
            size_bytes=meta.size_bytes,
            signer_sha256=meta.signer_sha256,
            permissions=meta.permissions,
            native_code=meta.native_code,
            has_icon=bool(meta.icon_data),
            detected_anti_features=detected,
            staging_token=staging_token,
        )
    finally:
        tmp_path.unlink(missing_ok=True)


async def _materialise_staged_apk(
    staging_token: str, *, user_id: uuid.UUID,
) -> tuple[Path, str]:
    """Validate a staging token and stream the staged blob to a fresh tmp file.

    Returns ``(tmp_path, content_hash)``. Caller MUST unlink ``tmp_path``
    in a ``finally`` block. Raises 401/410 on invalid / expired tokens.
    """
    from app.core.download_token import verify_staging_token

    content_hash = verify_staging_token(staging_token, user_id)
    if content_hash is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired staging token",
        )
    storage = get_storage()
    staging_key = f"staging/{content_hash}.apk"
    # Stream from storage to a tmp file — never load the whole APK into
    # memory. We deliberately skip the ``exists()`` pre-check: a concurrent
    # ``_discard_staged_apk`` between the check and the open would surface
    # as a 500 (FileNotFoundError / NoSuchKey from inside aiofiles or
    # aiobotocore) instead of a clean 410. Trying the open directly and
    # mapping the not-found shape is race-free.
    tmp_file = tempfile.NamedTemporaryFile(prefix="fdroid-staged-", suffix=".apk", delete=False)
    tmp_path = Path(tmp_file.name)
    tmp_file.close()
    try:
        stream = await storage.open_stream(staging_key)
        with tmp_path.open("wb") as fh:
            async for chunk in stream:
                fh.write(chunk)
    except FileNotFoundError as exc:
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="Staged APK is gone; please re-upload",
        ) from exc
    except Exception as exc:  # noqa: BLE001
        tmp_path.unlink(missing_ok=True)
        # aiobotocore raises ``ClientError`` with code ``NoSuchKey`` for
        # an S3 backend that lost the staging blob — same outcome as a
        # local FNF: tell the caller to retry from scratch.
        if "NoSuchKey" in str(exc) or "Not Found" in str(exc):
            raise HTTPException(
                status_code=status.HTTP_410_GONE,
                detail="Staged APK is gone; please re-upload",
            ) from exc
        raise
    return tmp_path, content_hash


async def _discard_staged_apk(content_hash: str) -> None:
    """Best-effort cleanup of a redeemed staging blob."""
    try:
        await get_storage().delete(f"staging/{content_hash}.apk")
    except Exception as exc:  # noqa: BLE001
        log.warning("staging cleanup failed", content_hash=content_hash, error=str(exc))


@router.post("/inspect-github", response_model=GithubApkInspect)
@limiter.limit("10/minute")
async def inspect_github(
    request: Request,
    payload: GithubInspectRequest,
    user: Annotated[User, Depends(get_current_uploader)],
) -> GithubApkInspect:
    """Resolve the latest matching release on a GitHub repo, download
    the APK, parse it and return the metadata — no DB writes.

    Powers the "From GitHub" mode of the New App page so the operator
    sees what they're about to import before committing. The created-by
    side of the workflow lives at ``POST /apps/with-github-source``,
    which re-downloads (the file is discarded between the two calls).
    """
    from app.services.github_releases import (
        GithubReleaseError,
        download_asset,
        fetch_repo_metadata,
        find_latest_asset,
        validate_base_url,
        validate_repo,
    )

    try:
        repo = validate_repo(payload.repo)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    try:
        base_url = validate_base_url(payload.base_url)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    provider = (payload.provider or "github").lower()
    if provider not in {"github", "gitlab", "gitea"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown provider: {provider!r}",
        )

    pattern = (payload.asset_pattern or "").strip() or None
    effective_pattern = pattern or "*.apk"
    inspect_token = (payload.access_token or "").strip() or None

    try:
        asset = await find_latest_asset(
            repo,
            asset_pattern=pattern,
            include_prereleases=payload.include_prereleases,
            provider=provider,
            base_url=base_url,
            token=inspect_token,
        )
    except GithubReleaseError as exc:
        # 422 is right: the input is structurally valid but the forge said no.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    if asset is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"No release with a matching APK found for {repo!r} "
                f"(pattern: {effective_pattern})"
            ),
        )

    # Pull the repo-level metadata in parallel with the asset download —
    # best-effort, so a missing/private repo description doesn't break
    # the inspect flow.
    import asyncio as _asyncio

    repo_meta_task = _asyncio.create_task(
        fetch_repo_metadata(repo, provider=provider, base_url=base_url, token=inspect_token)
    )

    tmp_path = await download_asset(asset)
    repo_meta = await repo_meta_task
    try:
        meta = await parse_or_400(tmp_path)
        try:
            from app.fdroid.anti_feature_scan import scan_apk, summarise

            detected = summarise(scan_apk(tmp_path))
        except Exception:  # noqa: BLE001
            detected = {}
        return GithubApkInspect(
            package_name=meta.package_name,
            app_name=meta.app_name,
            version_code=meta.version_code,
            version_name=meta.version_name,
            min_sdk=meta.min_sdk,
            target_sdk=meta.target_sdk,
            sha256=meta.sha256,
            size_bytes=meta.size_bytes,
            signer_sha256=meta.signer_sha256,
            permissions=meta.permissions,
            native_code=meta.native_code,
            has_icon=bool(meta.icon_data),
            detected_anti_features=detected,
            repo=repo,
            release_tag=asset.release_tag,
            release_published_at=asset.release_published_at,
            release_is_prerelease=asset.is_prerelease,
            asset_name=asset.asset_name,
            asset_pattern_used=effective_pattern,
            repo_html_url=repo_meta.html_url if repo_meta else f"https://github.com/{repo}",
            repo_description=repo_meta.description if repo_meta else None,
            repo_homepage=repo_meta.homepage if repo_meta else None,
            repo_license_spdx=repo_meta.license_spdx if repo_meta else None,
            repo_owner_login=repo_meta.owner_login if repo_meta else None,
        )
    finally:
        tmp_path.unlink(missing_ok=True)


@router.post("/inspect-proxy-source", response_model=ProxyApkInspect)
@limiter.limit("10/minute")
async def inspect_proxy_source(
    request: Request,
    payload: ProxyInspectRequest,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> ProxyApkInspect:
    """Probe a proxy source: call ``/resolve``, download the APK, parse
    its metadata. No DB writes.

    Powers the "From proxy" mode of the New App page so the operator
    sees what they're about to import (package name, signer, version)
    before committing. The created-by side of the flow lives at
    ``POST /apps/with-proxy-source``, which re-resolves + re-downloads —
    nothing is staged between the two calls so the proxy is free to mint
    a fresh signed URL each time.
    """
    from app.models.apk_proxy import ApkProxy, ApkProxyHealthStatus
    from app.schemas.apk_proxy import ResolveResponse
    from app.services.apk_proxy_client import ApkProxyError, resolve
    from app.services.apk_proxy_download import download_apk, verify_sha256_hint

    # 1. Resolve the proxy row, validate provider against its cached
    #    catalogue. Uploaders see only healthy + enabled proxies in the
    #    UI, so an unauthorised one reaching this endpoint is either a
    #    stale wizard or a curl-savvy caller — either way, refuse.
    proxy = (
        await db.execute(select(ApkProxy).where(ApkProxy.id == payload.proxy_id))
    ).scalar_one_or_none()
    if proxy is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Proxy not found",
        )
    if not proxy.enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That proxy is disabled.",
        )
    if proxy.last_health_status != ApkProxyHealthStatus.HEALTHY:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "That proxy is not healthy. "
                "Ask an admin to fix or refresh it."
            ),
        )
    catalogue = proxy.cached_sources_json or {}
    providers = catalogue.get("providers", []) if isinstance(catalogue, dict) else []
    descriptor = next(
        (p for p in providers if isinstance(p, dict) and p.get("id") == payload.provider),
        None,
    )
    if descriptor is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Provider {payload.provider!r} is not in this proxy's catalogue. "
                "Refresh the proxy or pick a different one."
            ),
        )

    # 2. Resolve + download. We treat ``ApkProxyError`` as a 422 (the
    #    request shape was fine but the upstream said no) just like
    #    inspect_github maps GithubReleaseError.
    try:
        resolved: ResolveResponse | None = await resolve(
            proxy,
            provider=payload.provider,
            url=str(payload.source_url),
            last_release_id=None,  # Always a fresh resolve for inspect.
            secrets=payload.secrets or {},
        )
    except ApkProxyError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    if resolved is None:
        # 304 from the proxy means "no change since last_release_id" —
        # but we passed None, so a 304 here is a protocol bug. Treat as
        # "no APK available" with the same 422 the absence-of-release
        # path uses.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Proxy {proxy.name!r} returned no release for {payload.source_url!r}. "
                "Double-check the URL or pick a different source."
            ),
        )

    # 3. Pre-flight size cap then stream the bytes.
    max_bytes = await _apk_size_cap_bytes(db)
    if (
        resolved.apk_size_bytes is not None
        and resolved.apk_size_bytes > max_bytes
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Proxy advertised {resolved.apk_size_bytes} B; "
                f"the configured cap is {max_bytes} B. "
                "Ask an admin to raise upload_max_apk_mb or split the build."
            ),
        )
    try:
        tmp_path = await download_apk(
            apk_url=str(resolved.apk_url),
            headers=resolved.apk_headers,
            max_bytes=max_bytes,
        )
    except ApkProxyError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Download failed: {exc}",
        ) from exc

    try:
        # 4. SHA-256 check + parse + anti-feature scan. The mismatch
        #    audit row is written by the worker on the cron path; here
        #    we just refuse the inspect — the user can fix and retry.
        if resolved.apk_sha256_hint:
            try:
                verify_sha256_hint(tmp_path, resolved.apk_sha256_hint)
            except ApkProxyError as exc:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=str(exc),
                ) from exc
        meta = await parse_or_400(tmp_path)
        # Belt-and-suspenders: the manifest version_code MUST agree with
        # the proxy's advertised value. A mismatch is either a buggy /
        # hostile proxy or a tampered download. Same check the worker
        # runs on the cron path, plus a 422 here so the operator finds
        # out before the create call.
        if meta.version_code != resolved.version_code:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    f"Manifest versionCode {meta.version_code} != "
                    f"proxy-advertised {resolved.version_code}"
                ),
            )
        try:
            from app.fdroid.anti_feature_scan import scan_apk, summarise

            detected = summarise(scan_apk(tmp_path))
        except Exception:  # noqa: BLE001
            detected = {}
        return ProxyApkInspect(
            package_name=meta.package_name,
            app_name=meta.app_name,
            version_code=meta.version_code,
            version_name=meta.version_name,
            min_sdk=meta.min_sdk,
            target_sdk=meta.target_sdk,
            sha256=meta.sha256,
            size_bytes=meta.size_bytes,
            signer_sha256=meta.signer_sha256,
            permissions=meta.permissions,
            native_code=meta.native_code,
            has_icon=bool(meta.icon_data),
            detected_anti_features=detected,
            proxy_id=proxy.id,
            proxy_name=proxy.name,
            provider=payload.provider,
            provider_name=str(descriptor.get("name") or payload.provider),
            source_url=str(payload.source_url),
            release_id=resolved.release_id,
            release_published_at=resolved.published_at,
        )
    finally:
        tmp_path.unlink(missing_ok=True)


from pydantic import BaseModel as _BaseModel, Field as _Field


class _StagedAttachBody(_BaseModel):
    """Body for the ``upload-staged`` endpoint. Just the redemption
    token — every other field is derived from the staged APK itself."""
    staging_token: str = _Field(min_length=10, max_length=512)


@router.post(
    "/upload-staged/{app_id}",
    response_model=ApkRead,
    status_code=status.HTTP_201_CREATED,
)
async def upload_apk_staged(
    app_id: uuid.UUID,
    body: _StagedAttachBody,
    db: DbSession,
    request: Request,
    user: Annotated[User, Depends(get_current_uploader)],
) -> ApkRead:
    """Promote a previously-staged APK (``POST /apks/inspect`` →
    ``staging_token``) onto an existing app. Skips the second upload —
    the bytes already live under ``staging/<sha>.apk``.

    Mirrors ``upload_apk`` but reads the blob from staging instead of
    the multipart body. Deploy-token auth isn't supported on this path:
    deploy tokens are designed for one-shot CI pushes and have their
    own upload endpoint that ingests bytes directly.
    """
    app = (
        await db.execute(
            select(App)
            .options(selectinload(App.apks), selectinload(App.owner))
            .where(App.id == app_id)
        )
    ).scalar_one_or_none()
    if app is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App not found")
    from app.services.app_permissions import assert_can_manage_app
    await assert_can_manage_app(db, user, app)
    from app.services.quotas import ensure_can_upload_apk

    tmp_path, content_hash = await _materialise_staged_apk(body.staging_token, user_id=user.id)
    # ``redeemed`` flips to True once we've passed the point where the
    # staged blob is no longer needed. Anything else — quota fail, sha
    # mismatch, ClamAV hit, attach failure — must drop the blob so it
    # doesn't accumulate in storage forever. Without this guard, every
    # rejected staged upload leaks ``staging/<sha>.apk``.
    redeemed = False
    try:
        size_bytes = tmp_path.stat().st_size
        await ensure_can_upload_apk(db, app.owner, incoming_size_bytes=size_bytes)
        meta = await parse_or_400(tmp_path)
        if meta.sha256 != content_hash:
            # Defence-in-depth: the staging key is sha-content-addressed
            # but the parser re-derives the hash. A mismatch here would
            # only happen with a tampered token, not a normal client.
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Staged content hash does not match parsed APK",
            )
        await _maybe_scan_upload(db, tmp_path=tmp_path)
        apk = await attach_apk_to_app(
            db, app=app, tmp_path=tmp_path, meta=meta, uploader=user
        )
        from app.services.apk_eviction import evict_oldest_if_needed
        await evict_oldest_if_needed(db, app=app, actor_id=user.id)
        from app.services.audit import write_event
        await write_event(
            db,
            action="apk.uploaded",
            actor=user,
            target_type="apk",
            target_id=apk.id,
            summary=(
                f"uploaded (staged) {app.package_name} v{meta.version_name} "
                f"({meta.version_code})"
            ),
            payload={
                "app_id": str(app.id),
                "package_name": app.package_name,
                "version_code": meta.version_code,
                "version_name": meta.version_name,
                "size_bytes": meta.size_bytes,
                "sha256": meta.sha256,
                "credential": {"kind": "staging"},
            },
            request=request,
        )
        if apk.status == ApkStatus.PUBLISHED:
            await enqueue_reindex()
        redeemed = True
        return ApkRead.model_validate(apk)
    finally:
        tmp_path.unlink(missing_ok=True)
        # Drop the staged blob in *both* success and failure cases:
        # success → it's been promoted, no longer needed;
        # failure → otherwise it would orphan in ``staging/`` forever.
        # The bool is informational only — both branches discard.
        _ = redeemed
        await _discard_staged_apk(content_hash)


@router.post("/upload/{app_id}", response_model=ApkRead, status_code=status.HTTP_201_CREATED)
async def upload_apk(
    app_id: uuid.UUID,
    db: DbSession,
    request: Request,
    user: Annotated[User, Depends(get_uploader_for_app)],
    file: UploadFile = File(...),
) -> ApkRead:
    """Upload a new APK for an existing app.

    Accepts both interactive JWT auth (publish from the web UI) and a
    deploy token in the ``Authorization: Bearer fdci_…`` header (CI
    push). Deploy tokens are scoped to a single app and short-circuit
    the management-permission check below because that check is
    enforced inside the auth dependency itself (the token *is* the
    per-app capability).
    """
    app = (
        await db.execute(
            select(App)
            .options(selectinload(App.apks), selectinload(App.owner))
            .where(App.id == app_id)
        )
    ).scalar_one_or_none()
    if app is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App not found")
    # Always re-check management rights against the resolved user:
    # whether they authenticated with a JWT or a deploy token, they
    # must still currently have manage rights on this app. This means
    # a token outlives its minter only as long as the minter retains
    # ownership/co-maintainer status — ownership transfer auto-revokes
    # in-flight CI access without an explicit token revoke.
    from app.services.app_permissions import assert_can_manage_app
    await assert_can_manage_app(db, user, app)

    from app.services.quotas import ensure_can_upload_apk

    tmp_path = await save_upload_to_temp(file, max_bytes=await _apk_size_cap_bytes(db))
    try:
        # ``app.owner`` (loaded above) is the quota subject — not the
        # uploader. A co-maintainer using their own session must not be
        # blocked by their own quota when the owner still has headroom,
        # and conversely they can't use their quota to bypass a strict
        # owner cap.
        size_bytes = tmp_path.stat().st_size
        await ensure_can_upload_apk(db, app.owner, incoming_size_bytes=size_bytes)
        meta = await parse_or_400(tmp_path)
        await _maybe_scan_upload(db, tmp_path=tmp_path)
        apk = await attach_apk_to_app(
            db, app=app, tmp_path=tmp_path, meta=meta, uploader=user
        )
        # Retention policy: trim down to the cap, if any. Runs AFTER
        # the new APK lands so the just-uploaded version stays even
        # when it ends up being the oldest in the new set (e.g. a
        # backfill of an older versionCode).
        from app.services.apk_eviction import evict_oldest_if_needed
        await evict_oldest_if_needed(db, app=app, actor_id=user.id)
        # Audit trail. Includes the credential descriptor stashed by
        # ``get_uploader_for_app`` so a leaked deploy token's activity
        # is traceable to the token prefix even after the resulting
        # APK row is the only remaining DB artefact.
        cred = getattr(request.state, "upload_credential", {"kind": "unknown"})
        from app.services.audit import write_event
        await write_event(
            db,
            action="apk.uploaded",
            actor=user,
            target_type="apk",
            target_id=apk.id,
            summary=(
                f"uploaded {app.package_name} v{meta.version_name} "
                f"({meta.version_code}) via {cred.get('kind', 'unknown')}"
            ),
            payload={
                "app_id": str(app.id),
                "package_name": app.package_name,
                "version_code": meta.version_code,
                "version_name": meta.version_name,
                "size_bytes": meta.size_bytes,
                "sha256": meta.sha256,
                "credential": cred,
            },
            request=request,
        )
        if apk.status == ApkStatus.PUBLISHED:
            await enqueue_reindex()
        return ApkRead.model_validate(apk)
    finally:
        tmp_path.unlink(missing_ok=True)


@router.patch("/{apk_id}", response_model=ApkRead)
async def update_apk(
    apk_id: uuid.UUID,
    payload: ApkUpdate,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> ApkRead:
    """Edit a previously-uploaded APK's mutable fields: the changelog and the
    anti-feature flags surfaced to F-Droid clients.

    Whitespace is normalized on save and "" maps to NULL so the index
    builder can cleanly omit the field instead of emitting an empty
    ``whatsNew``.
    """
    apk = (
        await db.execute(
            select(Apk).options(selectinload(Apk.app)).where(Apk.id == apk_id)
        )
    ).scalar_one_or_none()
    if apk is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="APK not found")
    from app.services.app_permissions import assert_can_manage_app
    await assert_can_manage_app(db, user, apk.app)

    # Distinguish "not provided" (don't touch) from "explicitly null/empty"
    # (clear it). Pydantic ``model_fields_set`` only contains keys the
    # client actually sent — exactly the discriminator we need.
    if "whats_new" in payload.model_fields_set:
        if payload.whats_new is None or not payload.whats_new:
            apk.whats_new = None
        else:
            # Validate each locale tag + strip empty entries. Locale shape
            # is the same loose BCP47 we accept for app localizations.
            cleaned: dict[str, str] = {}
            for locale, text in payload.whats_new.items():
                if not isinstance(locale, str) or not _LOCALE_RE.match(locale):
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Invalid locale tag: {locale!r}",
                    )
                if not isinstance(text, str):
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="whats_new values must be strings",
                    )
                trimmed = text.strip()
                if len(trimmed) > 10_000:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"whats_new[{locale}] exceeds 10,000 chars",
                    )
                if trimmed:
                    cleaned[locale] = trimmed
            apk.whats_new = cleaned or None
    if "anti_features" in payload.model_fields_set and payload.anti_features is not None:
        # Normalize: dedupe + drop blanks. Order preserved so the admin UI
        # round-trips edits without churn.
        seen: set[str] = set()
        normalized: list[str] = []
        for flag in payload.anti_features:
            stripped = flag.strip()
            if not stripped or stripped in seen:
                continue
            seen.add(stripped)
            normalized.append(stripped)
        apk.anti_features = normalized
    await db.flush()
    await enqueue_reindex()
    return ApkRead.model_validate(apk)


@router.post("/{apk_id}/download-url", response_model=dict)
async def issue_download_url(
    apk_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
) -> dict:
    """Mint a short-lived signed download URL the SPA can hand to ``<a href>``.

    Plain anchor clicks carry no Authorization header, so private-mode APKs
    can't be downloaded directly from the web UI without triggering the
    browser's Basic-auth pop-up. The SPA calls this endpoint with its JWT,
    gets back a URL of the form ``/fdroid/repo/<filename>?t=<hmac>``, and
    navigates to it. The token expires after ~10 minutes and is bound to
    the specific filename so it can't be replayed against other APKs.
    """
    apk = (
        await db.execute(
            select(Apk).options(selectinload(Apk.app)).where(Apk.id == apk_id)
        )
    ).scalar_one_or_none()
    if apk is None or apk.status != ApkStatus.PUBLISHED:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="APK not found")
    app = apk.app
    # Same visibility rules as the F-Droid serve handler. Owners and admins
    # always see their own / all apps; anyone else needs the app to be
    # public + published.
    if app.visibility == AppVisibility.PRIVATE:
        if user.role != UserRole.ADMIN and app.owner_id != user.id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="APK not found")

    config = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
    base = (config.address.rstrip("/") if config and config.address else "/fdroid/repo")
    token = sign_download_token(apk.file_name, user.id)
    return {
        "url": f"{base}/{apk.file_name}?t={token}",
        "expires_in": DEFAULT_TTL_SECONDS,
    }


@router.delete(
    "/{apk_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    response_class=Response,
)
async def delete_apk(
    apk_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> None:
    apk = (
        await db.execute(
            select(Apk).options(selectinload(Apk.app)).where(Apk.id == apk_id)
        )
    ).scalar_one_or_none()
    if apk is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="APK not found")
    from app.services.app_permissions import assert_can_manage_app
    await assert_can_manage_app(db, user, apk.app)

    storage = get_storage()
    try:
        await storage.delete(apk.storage_key)
    except Exception as exc:  # noqa: BLE001
        log.warning("storage delete failed", key=apk.storage_key, error=str(exc))
    await db.delete(apk)
    await db.flush()
    await enqueue_reindex()


# --------------------------------------------------------------------------
# Reproducible Builds verification
# --------------------------------------------------------------------------
_SHA256_RE = re.compile(r"\b([0-9a-fA-F]{64})\b")


def _normalise_status(value: str | None) -> ReproducibilityStatus | None:
    """Map a free-form status string to the enum or return ``None`` if
    the value isn't a known label."""
    if not value:
        return None
    cleaned = value.strip().lower()
    for member in ReproducibilityStatus:
        if member.value == cleaned:
            return member
    return None


def _extract_sha256_candidates(text: str) -> list[str]:
    """Pull every 64-char hex SHA-256 out of a fetched response body.

    Handles four common shapes:
      * raw hash (``abcd…`` on its own)
      * ``sha256sum`` output (``<hash>  <filename>``)
      * developer-published ``*.sha256`` siblings (the body is just the
        hash + optional filename)
      * F-Droid's verification-server JSON
        (``https://verification.f-droid.org/<pkg>_<vcode>.apk.json``):
        the per-timestamp dict contains both ``local.sha256`` (the build
        server's bytes) and ``remote.sha256`` (the upstream developer's
        bytes). Either is a legitimate reference depending on where the
        APK on disk originated, so we expose both.

    Returns the matches in source order, deduplicated, lowercase.
    """
    if not text:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for m in _SHA256_RE.finditer(text):
        h = m.group(1).lower()
        if h not in seen:
            seen.add(h)
            out.append(h)
    return out


async def _fetch_reference_hashes(url: str) -> tuple[list[str], str]:
    """Fetch ``url`` and return ``(all_extracted_hashes, source_url)``. Reuses
    the SSRF guard from :mod:`github_releases` so an admin can't pivot
    through the backend into the host's private network."""
    import httpx

    from app.services.github_releases import assert_fetch_url_safe

    try:
        safe_url = assert_fetch_url_safe(url)
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail=f"reference_url rejected: {exc}"
        ) from exc

    timeout = httpx.Timeout(10.0, connect=5.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        try:
            res = await client.get(
                safe_url,
                headers={"accept": "application/json, text/plain, */*;q=0.5"},
            )
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"could not fetch reference_url: {exc}",
            ) from exc
    if res.status_code >= 400:
        raise HTTPException(
            status_code=400,
            detail=f"reference_url returned HTTP {res.status_code}",
        )
    # F-Droid verification JSONs are sub-kB; even with multiple
    # timestamps embedded they don't exceed a few KB. 32 KiB is plenty
    # while still capping a hostile redirect into a giant body.
    text = res.text[:32_768]
    hashes = _extract_sha256_candidates(text)
    if not hashes:
        raise HTTPException(
            status_code=400,
            detail="reference_url body did not contain a SHA-256 hash",
        )
    return hashes, safe_url


async def _ensure_rb_feature_enabled(db) -> None:
    """Raise 403 when the admin master switch on the RB feature is off.

    Mirrors the gate semantics of the other repo-config feature flags:
    flipping the toggle off doesn't wipe past data, it only makes the
    mutation endpoints refuse new writes (and the frontend hides the
    badge + editor). Re-enabling later restores the previous state.
    """
    from app.models.repo_config import RepoConfig

    enabled = (
        await db.execute(select(RepoConfig.reproducible_builds_enabled).limit(1))
    ).scalar_one_or_none()
    # Default-True semantics: an empty table (only reachable pre-setup)
    # behaves as if the feature were on, so the endpoint won't 403
    # before the bootstrap row even exists.
    if enabled is False:
        raise HTTPException(
            status_code=403,
            detail=(
                "Reproducible Builds verification is disabled by the admin"
            ),
        )


async def _apply_reproducibility(
    db,
    apk: Apk,
    actor: User,
    *,
    status_override: ReproducibilityStatus | None,
    reference_sha256: str | None = None,
    reference_candidates: list[str] | None = None,
    reference_url: str | None,
    notes: str | None,
) -> Apk:
    """Shared write path used by both endpoints. Auto-decides the status
    from a hash comparison when a reference is present; falls back to
    the caller-supplied ``status_override`` for declarative paths.

    ``reference_sha256`` is the single-hash path used by the manual
    ``POST /reproducibility`` endpoint. ``reference_candidates`` is the
    multi-hash path used by ``POST /reproducibility/verify-from-url``
    where the fetched document (e.g. F-Droid's verification JSON which
    bundles ``local.sha256`` + ``remote.sha256``) yields several
    plausible references — any match counts as VERIFIED, and the
    stored ``reproducibility_reference_sha256`` is whichever one
    matched (or the first candidate if none did, so the admin can see
    what they compared against).
    """
    candidates: list[str] = []
    if reference_candidates:
        for raw in reference_candidates:
            cleaned = raw.strip().lower()
            if len(cleaned) == 64 and all(c in "0123456789abcdef" for c in cleaned):
                candidates.append(cleaned)
    if reference_sha256:
        cleaned = reference_sha256.strip().lower()
        if len(cleaned) != 64 or not all(c in "0123456789abcdef" for c in cleaned):
            raise HTTPException(
                status_code=400, detail="reference_sha256 must be a 64-char hex string"
            )
        candidates.append(cleaned)

    if candidates:
        own = apk.sha256.lower()
        match = next((c for c in candidates if c == own), None)
        if match is not None:
            apk.reproducibility_reference_sha256 = match
            apk.reproducibility_status = ReproducibilityStatus.VERIFIED
        else:
            # No match — store the first candidate so the admin can see
            # the reference value that was compared (failing the
            # comparison is itself useful audit info).
            apk.reproducibility_reference_sha256 = candidates[0]
            apk.reproducibility_status = ReproducibilityStatus.FAILED
    elif status_override is not None:
        apk.reproducibility_status = status_override

    if reference_url is not None:
        cleaned = reference_url.strip() or None
        if cleaned and not cleaned.lower().startswith(("http://", "https://")):
            raise HTTPException(
                status_code=400, detail="reference_url must be http(s)://"
            )
        apk.reproducibility_reference_url = cleaned

    if notes is not None:
        apk.reproducibility_notes = (notes.strip() or None)

    apk.reproducibility_verified_at = datetime.now(UTC)

    await write_event(
        db,
        action="apk.reproducibility_updated",
        actor=actor,
        target_type="apk",
        target_id=apk.id,
        summary=(
            f"reproducibility {apk.reproducibility_status.value} for "
            f"{apk.app.package_name if apk.app else apk.app_id} v{apk.version_name}"
        ),
        payload={
            "status": apk.reproducibility_status.value,
            "reference_sha256": apk.reproducibility_reference_sha256,
            "reference_url": apk.reproducibility_reference_url,
        },
    )
    return apk


@router.post("/{apk_id}/reproducibility", response_model=ApkRead)
async def set_reproducibility(
    apk_id: uuid.UUID,
    payload: ReproducibilitySet,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> ApkRead:
    """Declare an APK's reproducibility status or compare it to a
    supplied reference hash.

    Body shape:
      * ``status`` — one of ``unknown``, ``not_attempted``, ``verified``,
        ``failed``. Optional when ``reference_sha256`` is provided
        (auto-decide wins).
      * ``reference_sha256`` — 64-char hex. When present, the handler
        compares it to ``Apk.sha256`` and sets ``verified`` / ``failed``
        accordingly.
      * ``reference_url`` — optional pointer to the hash's origin.
      * ``notes`` — free-form admin/uploader note.

    Permissions match the rest of the per-APK mutation endpoints: the
    app's owner / collaborator / admin can edit, others get 403 via
    :func:`assert_can_manage_app`.
    """
    await _ensure_rb_feature_enabled(db)
    apk = (
        await db.execute(
            select(Apk).options(selectinload(Apk.app)).where(Apk.id == apk_id)
        )
    ).scalar_one_or_none()
    if apk is None:
        raise HTTPException(status_code=404, detail="APK not found")
    from app.services.app_permissions import assert_can_manage_app

    await assert_can_manage_app(db, user, apk.app)

    status_override = _normalise_status(payload.status)
    if (
        status_override is None
        and not payload.reference_sha256
        and payload.notes is None
        and payload.reference_url is None
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                "Provide at least one of: status, reference_sha256, "
                "reference_url, notes."
            ),
        )
    if payload.status and status_override is None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown status {payload.status!r}. Valid: "
                f"{', '.join(m.value for m in ReproducibilityStatus)}."
            ),
        )

    apk = await _apply_reproducibility(
        db,
        apk,
        user,
        status_override=status_override,
        reference_sha256=payload.reference_sha256,
        reference_url=payload.reference_url,
        notes=payload.notes,
    )
    await db.flush()
    return ApkRead.model_validate(apk)


@router.post("/{apk_id}/reproducibility/verify-from-url", response_model=ApkRead)
async def verify_reproducibility_from_url(
    apk_id: uuid.UUID,
    payload: ReproducibilityFromUrl,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> ApkRead:
    """Fetch a SHA-256 published by an authoritative third party
    (typically the F-Droid build server's ``.sha256`` artifact, or a
    CI build output), then compare against this APK's actual hash.

    The fetch goes through the same SSRF guard as the multi-forge release
    fetcher: HTTP(S) only, blocks RFC1918 / loopback / link-local /
    metadata-IP destinations, refuses redirects.
    """
    await _ensure_rb_feature_enabled(db)
    apk = (
        await db.execute(
            select(Apk).options(selectinload(Apk.app)).where(Apk.id == apk_id)
        )
    ).scalar_one_or_none()
    if apk is None:
        raise HTTPException(status_code=404, detail="APK not found")
    from app.services.app_permissions import assert_can_manage_app

    await assert_can_manage_app(db, user, apk.app)

    ref_hashes, ref_url = await _fetch_reference_hashes(payload.reference_url)
    apk = await _apply_reproducibility(
        db,
        apk,
        user,
        status_override=None,
        reference_candidates=ref_hashes,
        reference_url=ref_url,
        notes=payload.notes,
    )
    await db.flush()
    return ApkRead.model_validate(apk)


# --------------------------------------------------------------------------
# CVE / SBOM (private — owner / collaborator / admin only)
# --------------------------------------------------------------------------
def _serialise_cve(row: ApkCve) -> CveFinding:
    sev = row.severity.value if hasattr(row.severity, "value") else str(row.severity)
    return CveFinding(
        cve_id=row.cve_id,
        severity=sev,
        cvss_score=row.cvss_score,
        package_name=row.package_name,
        installed_version=row.installed_version,
        fixed_version=row.fixed_version,
        title=row.title,
        description=row.description,
        references=list(row.references_json or []),
    )


@router.get("/{apk_id}/sbom", response_model=SbomRead)
async def get_sbom(
    apk_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
    summary: bool = False,
) -> SbomRead:
    """Return the SBOM + CVE list for an APK.

    Restricted to the app's owner, collaborators, and admins — this
    information is operationally sensitive (e.g. a vulnerable embedded
    library is a hint at attack surface) and the catalogue / public
    page never shows it.

    ``?summary=true`` strips the raw SBOM blob from the response so a
    lightweight chip-render in /my-apps doesn't have to download 10s
    of KB of CycloneDX JSON.
    """
    apk = (
        await db.execute(
            select(Apk).options(selectinload(Apk.app)).where(Apk.id == apk_id)
        )
    ).scalar_one_or_none()
    if apk is None:
        raise HTTPException(status_code=404, detail="APK not found")
    from app.services.app_permissions import assert_can_manage_app

    await assert_can_manage_app(db, user, apk.app)

    sbom = (
        await db.execute(
            select(ApkSbom)
            .options(selectinload(ApkSbom.cves))
            .where(ApkSbom.apk_id == apk_id)
        )
    ).scalar_one_or_none()
    if sbom is None:
        return SbomRead(status="never_scanned")
    status_val = (
        sbom.status.value if hasattr(sbom.status, "value") else str(sbom.status)
    )
    cves = [_serialise_cve(c) for c in sbom.cves]
    # Sort by severity desc then CVSS desc — most-impactful first.
    severity_order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "UNKNOWN": 4}
    cves.sort(
        key=lambda c: (severity_order.get(c.severity, 9), -(c.cvss_score or 0.0))
    )
    return SbomRead(
        status=status_val,
        scanned_at=sbom.scanned_at.isoformat() if sbom.scanned_at else None,
        trivy_version=sbom.trivy_version,
        error_message=sbom.error_message,
        cve_summary=sbom.cve_summary or {},
        cves=cves,
        sbom=None if summary else sbom.sbom_json,
    )


@router.post("/{apk_id}/sbom/rescan", response_model=SbomRead)
async def rescan_sbom(
    apk_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
) -> SbomRead:
    """Re-enqueue a CVE scan for this APK. Returns the (possibly stale)
    row so the caller can poll the regular GET endpoint for the new
    result. The worker resets the row to ``scanning`` once it picks up
    the job."""
    apk = (
        await db.execute(
            select(Apk).options(selectinload(Apk.app)).where(Apk.id == apk_id)
        )
    ).scalar_one_or_none()
    if apk is None:
        raise HTTPException(status_code=404, detail="APK not found")
    from app.services.app_permissions import assert_can_manage_app

    await assert_can_manage_app(db, user, apk.app)

    # Mark the existing row pending — gives the UI an instant signal
    # that something is happening without having to wait for the worker
    # to pick the job up.
    sbom = (
        await db.execute(select(ApkSbom).where(ApkSbom.apk_id == apk_id))
    ).scalar_one_or_none()
    if sbom is None:
        sbom = ApkSbom(apk_id=apk_id)
        db.add(sbom)
    sbom.status = ApkSbomStatus.PENDING  # type: ignore[assignment]
    sbom.error_message = None
    await db.commit()
    await enqueue_cve_scan(apk_id)
    await write_event(
        db,
        action="apk.cve_rescan_requested",
        actor=user,
        target_type="apk",
        target_id=apk_id,
        summary=f"manual CVE rescan for {apk.app.package_name if apk.app else apk_id} v{apk.version_name}",
    )
    await db.commit()
    return SbomRead(
        status="pending",
        scanned_at=sbom.scanned_at.isoformat() if sbom.scanned_at else None,
        trivy_version=sbom.trivy_version,
        cve_summary=sbom.cve_summary or {},
    )
