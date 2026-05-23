"""arq tasks for the APK source-proxy pipeline.

Two functions live here:

  * :func:`scan_apk_proxy_sources_periodic` — cron coordinator. Fans
    out one ``fetch_apk_proxy_source`` job per enabled
    :class:`ApkProxySource`. Skips sources currently in
    ``suspended_until`` (rate-limited from a prior scan) and sources
    bound to a disabled proxy.

  * :func:`fetch_apk_proxy_source` — process one source. Calls
    ``POST /resolve`` on the proxy with the cached
    ``last_release_id``, branches on the response (200 = ingest a new
    APK, 304 = no-op, 401 = auth_required, 429 = rate_limited, …)
    and runs the standard ingest pipeline (parse + signer-pin +
    clamav + retention + reindex) for accepted releases.

Mirrors ``fetch_github_source`` in shape and audit-log coverage —
the admin/jobs UI can group both source families under the same
"recent runs" view without two distinct dashboards.
"""
from __future__ import annotations

import json
import tempfile
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from arq import cron
from arq.connections import RedisSettings
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.logging import configure_logging, get_logger
from app.models.apk import ApkStatus
from app.models.apk_proxy import (
    ApkProxy,
    ApkProxySource,
    ApkProxySourceStatus,
)
from app.models.app import App
from app.models.user import User
from app.schemas.apk_proxy import ResolveResponse
from app.services.apk_proxy_client import ApkProxyError, resolve
from app.services.crypto import decrypt as fernet_decrypt

log = get_logger(__name__)


# ============================================================================
# Helpers
# ============================================================================


async def _mark_error(
    db,
    src: ApkProxySource,
    *,
    status: ApkProxySourceStatus,
    message: str | None,
    retry_after: int | None = None,
) -> None:
    """Persist the failure on the row. Caller commits.

    ``retry_after`` (seconds) is honoured by setting
    ``suspended_until`` so the coordinator skips the source until the
    proxy's hint elapses.
    """
    src.last_status = status
    src.last_error = (message or "")[:2000]
    src.last_scanned_at = datetime.now(UTC)
    if retry_after and retry_after > 0:
        # Hard-cap to a day — a hostile proxy can't suspend a source
        # for years by returning ``retry_after: 99999999``.
        cap = min(int(retry_after), 86400)
        src.suspended_until = datetime.now(UTC) + timedelta(seconds=cap)
    else:
        src.suspended_until = None


def _decrypt_secrets(src: ApkProxySource) -> dict[str, str]:
    """Return the source's decrypted secrets dict, or an empty dict if
    none are configured (or the key has rotated and the blob is no
    longer decryptable)."""
    if not src.secrets_encrypted:
        return {}
    raw = fernet_decrypt(src.secrets_encrypted)
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        log.warning(
            "proxy source: secrets blob is not valid JSON",
            source_id=str(src.id),
        )
        return {}
    if not isinstance(parsed, dict):
        return {}
    # Coerce everything to str — the protocol declares
    # ``secrets: dict[str, str]``.
    return {str(k): str(v) for k, v in parsed.items()}


def _assert_apk_url_safe(url: str) -> None:
    """SSRF guard on the proxy-supplied ``apk_url``. Refuses RFC 1918 /
    loopback / link-local / metadata-IP destinations regardless of who
    supplied the URL — the trust boundary with the proxy is treated the
    same as the trust boundary with any third-party forge.
    """
    from app.services.github_releases import _is_private_ip, _resolves_to_blocked
    import ipaddress

    parsed = urlsplit(url)
    scheme = (parsed.scheme or "").lower()
    if scheme not in {"http", "https"}:
        raise ApkProxyError(f"apk_url must be http(s): {url!r}", code="bad_response")
    host = (parsed.hostname or "").strip()
    if not host:
        raise ApkProxyError(f"apk_url is missing a hostname: {url!r}", code="bad_response")
    try:
        as_ip = ipaddress.ip_address(host)
        if _is_private_ip(str(as_ip)):
            raise ApkProxyError(
                f"apk_url resolves to a blocked range: {host}",
                code="bad_response",
            )
    except ValueError:
        if _resolves_to_blocked(host):
            raise ApkProxyError(
                f"apk_url resolves to a blocked range: {host}",
                code="bad_response",
            )


async def _download_apk(
    *,
    apk_url: str,
    headers: dict[str, str] | None,
    max_bytes: int,
) -> Path:
    """Stream the APK from ``apk_url`` to a tempfile.

    ``max_bytes`` is the admin-configured upload cap — the download is
    aborted (and the partial tempfile unlinked) the moment we go over.
    A proxy that lies about ``apk_size_bytes`` can't exhaust disk.

    Returns the path; caller is responsible for ``unlink(missing_ok=True)``.
    """
    _assert_apk_url_safe(apk_url)
    req_headers: dict[str, str] = {"User-Agent": "fdroid-store/1.2"}
    if headers:
        # Forward only string values; refuse anything else (a hostile
        # proxy can't smuggle bytes / control characters via the headers).
        for k, v in headers.items():
            if isinstance(k, str) and isinstance(v, str):
                req_headers[k] = v
    timeout = httpx.Timeout(180.0, connect=15.0)
    path: Path | None = None
    total = 0
    try:
        with tempfile.NamedTemporaryFile(suffix=".apk", delete=False) as tmp:
            path = Path(tmp.name)
            async with httpx.AsyncClient(
                timeout=timeout,
                follow_redirects=False,
            ) as client:
                async with client.stream("GET", apk_url, headers=req_headers) as res:
                    if res.status_code != 200:
                        raise ApkProxyError(
                            f"apk_url returned {res.status_code}",
                            status_code=res.status_code,
                            code="upstream",
                        )
                    async for chunk in res.aiter_bytes(1024 * 1024):
                        if not chunk:
                            continue
                        total += len(chunk)
                        if total > max_bytes:
                            raise ApkProxyError(
                                f"APK exceeds the configured {max_bytes} byte limit",
                                code="upstream",
                            )
                        tmp.write(chunk)
    except Exception:
        if path is not None:
            path.unlink(missing_ok=True)
        raise
    return path


def _verify_sha256_hint(path: Path, hint: str) -> None:
    """Recompute SHA-256 over the downloaded file; raise on mismatch.

    The hint is optional in the protocol; when supplied, mismatches
    almost certainly mean the proxy↔upstream link is compromised or the
    artefact was retransformed in transit.
    """
    import hashlib

    h = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    got = h.hexdigest()
    if got.lower() != hint.lower():
        raise ApkProxyError(
            f"apk_sha256_hint mismatch: declared {hint}, downloaded {got}",
            code="bad_response",
        )


# ============================================================================
# Tasks
# ============================================================================


async def scan_apk_proxy_sources_periodic(ctx: dict) -> dict:
    """Coordinator: one ``fetch_apk_proxy_source`` per enabled source.

    Skips sources whose ``suspended_until`` is in the future (rate-limit
    backoff from a prior 429) and sources whose parent proxy is
    disabled — flipping either flag is the supported way to pause the
    cron without losing the configuration.
    """
    from arq import create_pool

    now = datetime.now(UTC)
    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(ApkProxySource)
                .join(ApkProxy, ApkProxy.id == ApkProxySource.proxy_id)
                .where(ApkProxySource.enabled.is_(True))
                .where(ApkProxy.enabled.is_(True))
            )
        ).scalars().all()

    eligible = [
        s for s in rows
        if not s.suspended_until or s.suspended_until <= now
    ]
    if not eligible:
        log.info("scan_apk_proxy_sources: nothing eligible")
        return {"queued": 0, "skipped_suspended": len(rows) - len(eligible)}

    pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
    try:
        queued = 0
        for s in eligible:
            sid = str(s.id)
            await pool.enqueue_job(
                "fetch_apk_proxy_source",
                sid,
                _job_id=f"fetch_apk_proxy_source:{sid}",
            )
            queued += 1
    finally:
        await pool.close()
    log.info(
        "scan_apk_proxy_sources queued",
        queued=queued,
        skipped_suspended=len(rows) - len(eligible),
    )
    return {"queued": queued, "skipped_suspended": len(rows) - len(eligible)}


async def fetch_apk_proxy_source(ctx: dict, source_id: str) -> dict:
    """Process one source: resolve → download → ingest → audit.

    Result shape mirrors :func:`fetch_github_source` so the admin/jobs
    "Recent runs" panel can format both side-by-side: ``status`` plus
    ``provider`` / ``proxy`` / ``release_id`` / ``version_code`` /
    ``error`` when applicable.
    """
    from app.api.v1.apks import attach_apk_to_app, parse_or_400, _apk_size_cap_bytes
    from app.services.audit import write_event
    from app.services.queue import enqueue_reindex

    try:
        sid = uuid.UUID(source_id)
    except ValueError:
        log.warning("fetch_apk_proxy_source: invalid source_id", source_id=source_id)
        return {"status": "error", "error": "invalid source id"}

    async with SessionLocal() as db:
        src = (
            await db.execute(
                select(ApkProxySource)
                .options(
                    selectinload(ApkProxySource.app).selectinload(App.apks),
                    selectinload(ApkProxySource.proxy),
                )
                .where(ApkProxySource.id == sid)
            )
        ).scalar_one_or_none()
        if src is None:
            log.warning("fetch_apk_proxy_source: source vanished", source_id=source_id)
            return {"status": "error", "error": "source not found"}
        if src.app is None:
            return {"status": "error", "error": "app missing"}
        proxy = src.proxy
        if proxy is None or not proxy.enabled:
            await _mark_error(
                db, src,
                status=ApkProxySourceStatus.ERROR,
                message="Proxy is missing or disabled",
            )
            await db.commit()
            return {"status": "error", "error": "proxy disabled"}

        # Owner is needed to attribute the upload (audit + quota path).
        owner = None
        if src.app.owner_id is not None:
            owner = (
                await db.execute(select(User).where(User.id == src.app.owner_id))
            ).scalar_one_or_none()
        if owner is None:
            await _mark_error(
                db, src,
                status=ApkProxySourceStatus.ERROR,
                message="App has no owner — cannot attribute uploads",
            )
            await db.commit()
            return {"status": "error", "error": "app owner missing"}

        secrets = _decrypt_secrets(src)

        # ---- 1. /resolve on the proxy --------------------------------
        try:
            resolved: ResolveResponse | None = await resolve(
                proxy,
                provider=src.provider,
                url=src.source_url,
                last_release_id=src.last_release_id,
                secrets=secrets,
            )
        except ApkProxyError as exc:
            # Map protocol codes onto our status enum.
            target_status = ApkProxySourceStatus.ERROR
            if exc.code == "auth_failed" or exc.status_code in (401, 403):
                target_status = ApkProxySourceStatus.AUTH_REQUIRED
            elif exc.code == "rate_limited" or exc.status_code == 429:
                target_status = ApkProxySourceStatus.RATE_LIMITED
            await _mark_error(
                db, src,
                status=target_status,
                message=str(exc),
                retry_after=exc.retry_after,
            )
            await db.commit()
            return {
                "status": target_status.value,
                "provider": src.provider,
                "error": str(exc),
            }

        src.last_scanned_at = datetime.now(UTC)

        if resolved is None:
            # 304 — same release as last time. Quiet success.
            src.last_status = ApkProxySourceStatus.UP_TO_DATE
            src.last_error = None
            src.suspended_until = None
            await db.commit()
            return {"status": "up_to_date", "provider": src.provider}

        # Pre-flight: same versionCode already ingested? Mark release_id
        # so the proxy can short-circuit next time, but don't re-import.
        already_present = any(
            a.version_code == resolved.version_code for a in src.app.apks
        )
        if already_present:
            src.last_status = ApkProxySourceStatus.SKIPPED
            src.last_release_id = resolved.release_id
            src.last_release_at = resolved.published_at or datetime.now(UTC)
            src.last_error = (
                f"Release {resolved.release_id} skipped: versionCode "
                f"{resolved.version_code} already exists for this app"
            )
            src.suspended_until = None
            await db.commit()
            return {
                "status": "skipped",
                "provider": src.provider,
                "release_id": resolved.release_id,
                "reason": "version_code_present",
            }

        # ---- 2. Pre-flight size check + download -------------------
        max_bytes = await _apk_size_cap_bytes(db)
        if resolved.apk_size_bytes is not None and resolved.apk_size_bytes > max_bytes:
            await _mark_error(
                db, src,
                status=ApkProxySourceStatus.ERROR,
                message=(
                    f"Proxy advertised {resolved.apk_size_bytes} B; "
                    f"the configured cap is {max_bytes} B"
                ),
            )
            await db.commit()
            return {"status": "error", "error": "apk_size_over_cap"}

        try:
            tmp_path = await _download_apk(
                apk_url=str(resolved.apk_url),
                headers=resolved.apk_headers,
                max_bytes=max_bytes,
            )
        except ApkProxyError as exc:
            await _mark_error(
                db, src,
                status=ApkProxySourceStatus.ERROR,
                message=f"Download failed: {exc}",
            )
            await db.commit()
            return {"status": "error", "error": str(exc)}

        # ---- 3. SHA-256 verification (when hinted) ------------------
        if resolved.apk_sha256_hint:
            try:
                _verify_sha256_hint(tmp_path, resolved.apk_sha256_hint)
            except ApkProxyError as exc:
                tmp_path.unlink(missing_ok=True)
                await _mark_error(
                    db, src,
                    status=ApkProxySourceStatus.ERROR,
                    message=str(exc),
                )
                # Audit-log the mismatch — it's the strongest signal of
                # a compromised proxy or upstream and warrants visible
                # admin attention.
                await write_event(
                    db,
                    action="proxy_source.sha256_mismatch",
                    actor=None,
                    target_type="apk_proxy_source",
                    target_id=src.id,
                    summary=str(exc),
                    payload={
                        "provider": src.provider,
                        "release_id": resolved.release_id,
                        "declared": resolved.apk_sha256_hint,
                    },
                )
                await db.commit()
                return {"status": "error", "error": "sha256_mismatch"}

        # ---- 4. Parse + ingest (same path as a manual upload) ------
        try:
            try:
                meta = await parse_or_400(tmp_path)
            except Exception as exc:  # noqa: BLE001
                await _mark_error(
                    db, src,
                    status=ApkProxySourceStatus.ERROR,
                    message=f"APK parsing failed: {getattr(exc, 'detail', str(exc))}",
                )
                await db.commit()
                return {"status": "error", "error": "parse_failed"}

            # Belt-and-suspenders: the proxy-advertised version_code
            # MUST match the parsed manifest. A mismatch means the
            # proxy lied or the wrong bytes were delivered.
            if meta.version_code != resolved.version_code:
                await _mark_error(
                    db, src,
                    status=ApkProxySourceStatus.ERROR,
                    message=(
                        f"Manifest versionCode {meta.version_code} != "
                        f"proxy-advertised {resolved.version_code}"
                    ),
                )
                await db.commit()
                return {"status": "error", "error": "version_code_mismatch"}

            # Same belt-and-suspenders for package_name. The cross-
            # app signer pin enforced by attach_apk_to_app would catch
            # an attempt to push a different developer's APK under a
            # taken package name anyway, but a clearer error message
            # earlier in the pipeline is easier on the admin.
            if meta.package_name != src.app.package_name:
                await _mark_error(
                    db, src,
                    status=ApkProxySourceStatus.ERROR,
                    message=(
                        f"APK package {meta.package_name!r} does not match app "
                        f"{src.app.package_name!r}"
                    ),
                )
                await db.commit()
                return {"status": "error", "error": "package_mismatch"}

            try:
                apk = await attach_apk_to_app(
                    db,
                    app=src.app,
                    tmp_path=tmp_path,
                    meta=meta,
                    uploader=owner,
                )
            except Exception as exc:  # noqa: BLE001
                detail = getattr(exc, "detail", None) or str(exc)
                await _mark_error(
                    db, src,
                    status=ApkProxySourceStatus.ERROR,
                    message=f"Import rejected: {detail}",
                )
                await write_event(
                    db,
                    action="proxy_source.import_failed",
                    actor=None,
                    target_type="app",
                    target_id=src.app.id,
                    summary=(
                        f"Import via proxy {proxy.name!r} provider={src.provider} "
                        f"release={resolved.release_id} rejected"
                    ),
                    payload={
                        "provider": src.provider,
                        "proxy_id": str(proxy.id),
                        "release_id": resolved.release_id,
                        "error": detail,
                    },
                )
                await db.commit()
                return {"status": "error", "error": detail}

            src.last_status = ApkProxySourceStatus.IMPORTED
            src.last_release_id = resolved.release_id
            src.last_release_at = resolved.published_at or datetime.now(UTC)
            src.last_error = None
            src.suspended_until = None

            from app.services.apk_eviction import evict_oldest_if_needed
            await evict_oldest_if_needed(db, app=src.app, actor_id=owner.id)

            await write_event(
                db,
                action="proxy_source.imported",
                actor=None,
                target_type="app",
                target_id=src.app.id,
                summary=(
                    f"Imported via proxy {proxy.name!r} ({src.provider}) "
                    f"release={resolved.release_id} as versionCode {meta.version_code}"
                ),
                payload={
                    "provider": src.provider,
                    "proxy_id": str(proxy.id),
                    "release_id": resolved.release_id,
                    "version_code": meta.version_code,
                    "version_name": meta.version_name,
                },
            )
            await db.commit()
        finally:
            tmp_path.unlink(missing_ok=True)

    # Index rebuild outside the DB transaction.
    if apk.status == ApkStatus.PUBLISHED:
        await enqueue_reindex()

    return {
        "status": "imported",
        "provider": src.provider,
        "release_id": resolved.release_id,
        "version_code": meta.version_code,
    }
