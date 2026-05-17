"""F-Droid client-facing endpoints (``/fdroid/repo/...``).

This is the path that gets configured in F-Droid Android as the repo URL.
The endpoint:
  * serves ``index-v1.jar`` / ``index-v2.json`` / ``entry.jar`` from storage
  * serves APK binaries
  * picks the **public** or **private** index based on Basic-auth credentials
"""
from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession, get_api_key_from_basic_auth
from app.fdroid.repo_builder import REPO_PRIVATE_PREFIX, REPO_PUBLIC_PREFIX
from app.models.api_key import ApiKey
from app.models.apk import Apk, ApkStatus
from app.models.app import App, AppVisibility
from app.models.audit import DownloadEvent
from app.storage import get_storage
from app.storage.local import LocalStorage
from app.storage.s3 import S3Storage

router = APIRouter()


# Files we expect at the root of /fdroid/repo/
_INDEX_FILES = {
    "index-v1.jar": "application/java-archive",
    "index-v2.json": "application/json",
    "entry.jar": "application/java-archive",
}


def _hash_ip(ip: str | None) -> str | None:
    if not ip:
        return None
    return hashlib.sha256(ip.encode("utf-8")).hexdigest()


async def _stream_or_redirect(storage_key: str, *, content_type: str) -> Response:
    storage = get_storage()
    if isinstance(storage, LocalStorage):
        path = storage.local_path(storage_key)
        if not path.exists():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
        return FileResponse(str(path), media_type=content_type)
    if isinstance(storage, S3Storage):
        public = storage.public_url(storage_key)
        if public:
            return RedirectResponse(public, status_code=status.HTTP_302_FOUND)
        if not await storage.exists(storage_key):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
        stream = await storage.open_stream(storage_key)
        return StreamingResponse(stream, media_type=content_type)
    # Generic fallback for custom backends
    if not await storage.exists(storage_key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    stream = await storage.open_stream(storage_key)
    return StreamingResponse(stream, media_type=content_type)


@router.get("/{filename}")
async def serve(
    filename: str,
    request: Request,
    db: DbSession,
    api_key: Annotated[ApiKey | None, Depends(get_api_key_from_basic_auth)] = None,
) -> Response:
    """Catch-all under ``/fdroid/repo/``.

    Dispatches by file kind:
      * ``index-v1.jar`` / ``index-v2.json`` / ``entry.jar``  -> repo index
      * ``*.apk``                                             -> APK binary
      * anything else stored as a static asset (icons live in their own path)
    """
    if filename in _INDEX_FILES:
        return await _serve_index(filename, api_key)
    if filename.lower().endswith(".apk"):
        return await _serve_apk(filename, request=request, db=db, api_key=api_key)
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")


@router.get("/icons/{filename}")
async def serve_icon(filename: str) -> Response:
    storage = get_storage()
    key = f"icons/{filename}"
    if not await storage.exists(key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Icon not found")
    return await _stream_or_redirect(key, content_type=_content_type_for(filename))


# Screenshots and other localized media: served from
# ``<package>/<locale>/<kind>/<filename>``. The path on disk matches the URL
# layout the F-Droid client expects. We restrict ``kind`` to known shapes to
# avoid being a generic static-file server.
_ALLOWED_MEDIA_KINDS = {
    "phoneScreenshots",
    "sevenInchScreenshots",
    "tenInchScreenshots",
    "wearScreenshots",
    "tvScreenshots",
}


@router.get("/{package}/{locale}/{kind}/{filename}")
async def serve_media(
    package: str, locale: str, kind: str, filename: str
) -> Response:
    if kind not in _ALLOWED_MEDIA_KINDS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    # Defensive: refuse traversal-y components
    for seg in (package, locale, kind, filename):
        if not seg or "/" in seg or seg.startswith("."):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    key = f"{package}/{locale}/{kind}/{filename}"
    storage = get_storage()
    if not await storage.exists(key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return await _stream_or_redirect(key, content_type=_content_type_for(filename))


def _content_type_for(filename: str) -> str:
    ext = filename.rsplit(".", 1)[-1].lower()
    return {
        "png": "image/png",
        "webp": "image/webp",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
    }.get(ext, "application/octet-stream")


# --------------------------------------------------------------------------
async def _serve_index(filename: str, api_key: ApiKey | None) -> Response:
    """Return the public OR private index variant depending on auth.

    The private variant requires an API key with ``can_download_private``.
    """
    prefix = REPO_PUBLIC_PREFIX
    if api_key is not None and api_key.can_download_private:
        prefix = REPO_PRIVATE_PREFIX

    storage_key = f"{prefix}/{filename}"
    storage = get_storage()
    if not await storage.exists(storage_key):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                "Index not built yet. The admin must complete setup and trigger a reindex."
            ),
        )
    return await _stream_or_redirect(storage_key, content_type=_INDEX_FILES[filename])


async def _serve_apk(
    filename: str,
    *,
    request: Request,
    db,
    api_key: ApiKey | None,
) -> Response:
    """Locate the APK by file name and serve it (with auth checks)."""
    apk = (
        await db.execute(
            select(Apk).options(selectinload(Apk.app)).where(Apk.file_name == filename)
        )
    ).scalar_one_or_none()
    if apk is None or apk.status != ApkStatus.PUBLISHED:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="APK not found")

    app = apk.app
    if app.visibility == AppVisibility.PRIVATE:
        if api_key is None or not api_key.can_download_private:
            return Response(
                status_code=status.HTTP_401_UNAUTHORIZED,
                headers={"WWW-Authenticate": 'Basic realm="fdroid-store"'},
            )

    # Record the download (best effort — never fail the response on this)
    try:
        ev = DownloadEvent(
            apk_id=apk.id,
            app_id=app.id,
            user_id=api_key.user_id if api_key else None,
            api_key_id=api_key.id if api_key else None,
            ip_hash=_hash_ip(request.client.host if request.client else None),
            user_agent=(request.headers.get("user-agent") or "")[:512] or None,
            bytes_served=apk.size_bytes,
            status_code=200,
        )
        db.add(ev)
        if api_key is not None:
            api_key.last_used_at = datetime.now(UTC)
        await db.flush()
    except Exception:  # noqa: BLE001
        pass

    return await _stream_or_redirect(apk.storage_key, content_type="application/vnd.android.package-archive")
