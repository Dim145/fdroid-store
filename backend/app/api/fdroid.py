"""F-Droid client-facing endpoints (``/fdroid/repo/...``).

This is the path that gets configured in F-Droid Android as the repo URL.
The endpoint:
  * serves ``index-v1.jar`` / ``index-v2.json`` / ``entry.jar`` from storage
  * serves APK binaries
  * picks the **public** or **private** index based on Basic-auth credentials
"""
from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession, get_api_key_from_basic_auth, is_public_mode
from app.core.download_token import verify_download_token
from app.core.security import parse_api_key, verify_api_key_secret
from app.fdroid.repo_builder import REPO_PRIVATE_PREFIX, REPO_PUBLIC_PREFIX
from app.models.api_key import ApiKey
from app.models.apk import Apk, ApkStatus
from app.models.app import App, AppStatus, AppVisibility
from app.models.audit import DownloadEvent
from app.storage import get_storage
from app.storage.local import LocalStorage
from app.storage.s3 import S3Storage

# Public + Basic-auth endpoints. Mounted at /fdroid/repo in main.py.
router = APIRouter()

# Path-based token endpoints. Mounted at /r in main.py.
#
# Why we need a parallel scheme: the F-Droid Android client supports HTTP
# Basic auth in repo URLs (RepoUriGetter.kt extracts user:pass@host), but the
# `Uri.Builder.authority(value)` call it uses to rebuild the URL after
# stripping userinfo *percent-encodes* the host. That re-encodes the `:`
# of the port (`host:port` → `host%3Aport`), which then makes F-Droid try
# to connect to a port-less host. The bug surfaces only when both userinfo
# AND a port are present in the URL.
#
# By embedding the API key in the URL *path* instead of the userinfo, we
# never trigger that code path. F-Droid sees a normal URL ending in
# /fdroid/repo, the token is just opaque to it, and the server treats the
# token segment as authentication.
token_router = APIRouter()


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


async def _dispatch_root(
    filename: str,
    request: Request,
    db,
    api_key: ApiKey | None,
) -> Response:
    """Shared dispatcher for both Basic-auth and path-token routes."""
    if filename in _INDEX_FILES:
        return await _serve_index(filename, api_key)
    if filename.lower().endswith(".apk"):
        return await _serve_apk(filename, request=request, db=db, api_key=api_key)
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")


@router.get("/{filename}")
async def serve(
    filename: str,
    request: Request,
    db: DbSession,
    api_key: Annotated[ApiKey | None, Depends(get_api_key_from_basic_auth)] = None,
    t: str | None = None,
) -> Response:
    """Catch-all under ``/fdroid/repo/`` — anonymous + Basic-auth path.

    Auth precedence:
      1. Basic auth API key (``api_key`` is set by the dependency).
      2. ``?t=<signed token>`` issued by /api/v1/apks/{id}/download-url for a
         logged-in SPA session — lets ``<a href download>`` clicks work in
         private mode without triggering the browser's Basic-auth prompt.
      3. Anonymous, only when the repo is in public mode.
    """
    if api_key is None:
        token_ok = t is not None and verify_download_token(filename, t) is not None
        if not token_ok and not await is_public_mode(db):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication required",
                headers={"WWW-Authenticate": 'Basic realm="fdroid-store"'},
            )
    return await _dispatch_root(filename, request, db, api_key)


async def _media_anonymously_visible(
    *,
    db,
    package_name: str,
    api_key: ApiKey | None,
) -> bool:
    """Return True if the underlying app (looked up by package) may be
    served anonymously through the media routes.

    Private apps' media (icons, banners, screenshots) is what makes their
    name guessable by probing. Anonymous callers see media only for
    PUBLIC + PUBLISHED apps; callers with an API key that ``can_download_
    private`` also see private apps' media. Repo-level icons (no matching
    app) stay anonymous so the catalogue masthead works for logged-out
    visitors.
    """
    app_row = (
        await db.execute(
            select(App).where(App.package_name == package_name)
        )
    ).scalar_one_or_none()
    if app_row is None:
        return True  # not tied to an app (e.g. the repo icon itself)
    if app_row.visibility == AppVisibility.PUBLIC and app_row.status == AppStatus.PUBLISHED:
        return True
    if api_key is not None and api_key.can_download_private:
        return True
    return False


@router.get("/icons/{filename}")
async def serve_icon(
    filename: str,
    db: DbSession,
    api_key: Annotated[ApiKey | None, Depends(get_api_key_from_basic_auth)] = None,
) -> Response:
    """Icons.

    Refuse anonymously serving icons of private / unpublished apps — the
    file naming (``icons/<package>.png``) made the F-Droid serve route a
    package-name oracle for private packages (CWE-203). Catalogue
    thumbnails of public apps stay public so the logged-out home page
    still renders.
    """
    # Filename layout is ``<package>.png``, ``<package>-custom.png``,
    # ``fdroid-icon.png`` (the repo's own icon), or ``repo-icon-<ts>.png``.
    # Derive the package name only for the per-app variants.
    base = filename.rsplit(".", 1)[0]
    package_name: str | None = None
    if not base.startswith("repo-icon") and base != "fdroid-icon":
        package_name = base.removesuffix("-custom")
    if package_name and not await _media_anonymously_visible(
        db=db, package_name=package_name, api_key=api_key,
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Icon not found")
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


# Per-app singleton media (featureGraphic, etc.) live one directory shallower
# than screenshots. F-Droid clients fetch ``<package>/<locale>/featureGraphic.png``
# directly. We restrict to a known whitelist to stay out of the generic
# static-server business.
_ALLOWED_SINGLETON_MEDIA = {
    "featureGraphic.png",
    "promoGraphic.png",
    "tvBanner.png",
}


@router.get("/{package}/{locale}/{filename}")
async def serve_singleton_media(
    package: str,
    locale: str,
    filename: str,
    db: DbSession,
    api_key: Annotated[ApiKey | None, Depends(get_api_key_from_basic_auth)] = None,
) -> Response:
    if filename not in _ALLOWED_SINGLETON_MEDIA:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    for seg in (package, locale, filename):
        if not seg or "/" in seg or seg.startswith("."):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if not await _media_anonymously_visible(db=db, package_name=package, api_key=api_key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    key = f"{package}/{locale}/{filename}"
    storage = get_storage()
    if not await storage.exists(key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return await _stream_or_redirect(key, content_type=_content_type_for(filename))


@router.get("/{package}/{locale}/{kind}/{filename}")
async def serve_media(
    package: str,
    locale: str,
    kind: str,
    filename: str,
    db: DbSession,
    api_key: Annotated[ApiKey | None, Depends(get_api_key_from_basic_auth)] = None,
) -> Response:
    # Screenshots are <img>-loaded previews but the URL doubles as a
    # package-name oracle for private apps if served anonymously. Gate on
    # the same rule as the icon route.
    if kind not in _ALLOWED_MEDIA_KINDS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    # Defensive: refuse traversal-y components
    for seg in (package, locale, kind, filename):
        if not seg or "/" in seg or seg.startswith("."):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if not await _media_anonymously_visible(db=db, package_name=package, api_key=api_key):
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
# Path-token routes (/r/{token}/fdroid/repo/...)
# --------------------------------------------------------------------------
async def _api_key_from_token_path(token: str, db) -> ApiKey:
    """Resolve a URL-path token to an active ApiKey.

    Tokens that don't parse, don't match, or aren't active all return 404 (not
    401) so we don't leak information about which prefixes exist.
    """
    parts = parse_api_key(token)
    if parts is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    prefix, secret = parts
    key = (
        await db.execute(select(ApiKey).where(ApiKey.prefix == prefix))
    ).scalar_one_or_none()
    if key is None or not key.is_active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if not verify_api_key_secret(secret, key.hashed_secret):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    # Same throttle as deps.py: bursts of F-Droid client requests share a
    # single ``last_used_at`` write per minute.
    now = datetime.now(UTC)
    if key.last_used_at is None or (now - key.last_used_at) >= timedelta(minutes=1):
        key.last_used_at = now
        await db.flush()
    return key


@token_router.get("/{token}/fdroid/repo/{filename}")
async def serve_token_root(
    token: str,
    filename: str,
    request: Request,
    db: DbSession,
) -> Response:
    """Root file via a path-token URL.

    Mirrors ``serve()`` but resolves auth from the URL path, so F-Droid clients
    that mishandle userinfo+port URLs (Basic auth) can still reach private apps.
    """
    api_key = await _api_key_from_token_path(token, db)
    return await _dispatch_root(filename, request, db, api_key)


@token_router.get("/{token}/fdroid/repo/icons/{filename}")
async def serve_token_icon(
    token: str,
    filename: str,
    db: DbSession,
) -> Response:
    api_key = await _api_key_from_token_path(token, db)
    return await serve_icon(filename, db=db, api_key=api_key)


@token_router.get("/{token}/fdroid/repo/{package}/{locale}/{filename}")
async def serve_token_singleton_media(
    token: str,
    package: str,
    locale: str,
    filename: str,
    db: DbSession,
) -> Response:
    # H15: token equivalent of ``serve_singleton_media`` so featureGraphic
    # / promoGraphic / tvBanner are reachable through the path-token URL
    # in private mode without falling back to the anonymous route.
    api_key = await _api_key_from_token_path(token, db)
    return await serve_singleton_media(
        package, locale, filename, db=db, api_key=api_key,
    )


@token_router.get("/{token}/fdroid/repo/{package}/{locale}/{kind}/{filename}")
async def serve_token_media(
    token: str,
    package: str,
    locale: str,
    kind: str,
    filename: str,
    db: DbSession,
) -> Response:
    api_key = await _api_key_from_token_path(token, db)
    return await serve_media(
        package, locale, kind, filename, db=db, api_key=api_key,
    )


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
