from __future__ import annotations

import re
import tempfile
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession, get_current_user
from app.core.download_token import DEFAULT_TTL_SECONDS, sign_download_token
from app.core.logging import get_logger
from app.fdroid.apk_parser import ApkMetadata, ApkParseError, parse_apk
from app.models.apk import Apk, ApkStatus
from app.models.app import App, AppStatus, AppVisibility
from app.models.package_signer import PackageSignerPin
from app.models.repo_config import RepoConfig
from app.models.user import User, UserRole
from app.schemas.app import ApkInspect, ApkRead, ApkUpdate
from app.services.queue import enqueue_reindex
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
    return apk


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@router.post("/inspect", response_model=ApkInspect)
async def inspect_apk(
    user: Annotated[User, Depends(get_current_user)],
    file: UploadFile = File(...),
) -> ApkInspect:
    """Parse an APK and return its metadata without persisting anything.

    Intended to power the "auto-fill the new-app form when an APK is picked"
    UX flow. Authenticated callers only — APK parsing isn't free.
    """
    tmp_path = await save_upload_to_temp(file, max_bytes=await _apk_size_cap_bytes(db))
    try:
        meta = await parse_or_400(tmp_path)
        # Run the lightweight DEX/class-name scan to suggest anti-feature
        # chips. Failures here are non-fatal — inspect just returns the
        # metadata it has and an empty suggestions dict.
        try:
            from app.fdroid.anti_feature_scan import scan_apk, summarise

            detected = summarise(scan_apk(tmp_path))
        except Exception:  # noqa: BLE001
            detected = {}
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
        )
    finally:
        tmp_path.unlink(missing_ok=True)


@router.post("/upload/{app_id}", response_model=ApkRead, status_code=status.HTTP_201_CREATED)
async def upload_apk(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
    file: UploadFile = File(...),
) -> ApkRead:
    """Upload a new APK for an existing app (e.g. publishing a new version)."""
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
    user: Annotated[User, Depends(get_current_user)],
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
    user: Annotated[User, Depends(get_current_user)],
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
