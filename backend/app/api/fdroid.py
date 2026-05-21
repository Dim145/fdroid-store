"""F-Droid client-facing endpoints (``/fdroid/repo/...``).

This is the path that gets configured in F-Droid Android as the repo URL.
The endpoint:
  * serves ``index-v1.jar`` / ``index-v2.json`` / ``entry.jar`` from storage
  * serves APK binaries
  * picks the **public** or **private** index based on Basic-auth credentials
"""
from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse, Response, StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession, get_api_key_from_basic_auth, is_public_mode
from app.core.download_token import verify_download_token
from app.core.security import parse_api_key, verify_api_key_secret
from app.fdroid.repo_builder import REPO_PUBLIC_PREFIX, user_private_prefix
from app.models.api_key import ApiKey
from app.models.apk import Apk, ApkStatus
from app.models.app import App, AppStatus, AppVisibility
from app.models.audit import DownloadEvent
from app.models.user import User, UserRole
from app.storage import get_storage
from app.storage.local import LocalStorage

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


async def _serve_storage_object(storage_key: str, *, content_type: str) -> Response:
    """Serve a stored object through the backend.

    We deliberately do NOT redirect to an S3 public URL even when one
    is available: the redirect path bypasses every backend control
    that the caller-side access checks rely on (private-app gating,
    audit, rate limits, slowapi), and an S3 backend that refuses
    anonymous reads (Garage, private MinIO bucket, …) just 403s on
    the redirect. Streaming keeps the surface uniform — the bytes
    always traverse the backend, so an admin who pulled a deploy
    token revoke / disabled a user can be sure no in-flight download
    is using the old credential against a publicly readable bucket.
    """
    storage = get_storage()
    if isinstance(storage, LocalStorage):
        path = storage.local_path(storage_key)
        if not path.exists():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
        # FileResponse already sets Content-Length from the stat.
        return FileResponse(str(path), media_type=content_type)
    if not await storage.exists(storage_key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    # Best-effort Content-Length — without it the F-Droid client shows
    # an indeterminate progress bar on a 30 MB APK. ``storage.size``
    # does a HEAD against S3 which is cheap.
    headers: dict[str, str] = {}
    try:
        headers["Content-Length"] = str(await storage.size(storage_key))
    except Exception:  # noqa: BLE001 — best-effort, fall through without the header
        pass
    stream = await storage.open_stream(storage_key)
    return StreamingResponse(stream, media_type=content_type, headers=headers)


async def _dispatch_root(
    filename: str,
    request: Request,
    db,
    api_key: ApiKey | None,
    signed_user_id: str | None = None,
) -> Response:
    """Shared dispatcher for both Basic-auth and path-token routes."""
    if filename in _INDEX_FILES:
        return await _serve_index(filename, api_key)
    if filename.lower().endswith(".apk"):
        return await _serve_apk(
            filename,
            request=request,
            db=db,
            api_key=api_key,
            signed_user_id=signed_user_id,
        )
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
    signed_user_id: str | None = None
    if api_key is None and t is not None:
        signed_user_id = verify_download_token(filename, t)
    if api_key is None and signed_user_id is None and not await is_public_mode(db):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": 'Basic realm="fdroid-store"'},
        )
    return await _dispatch_root(filename, request, db, api_key, signed_user_id)


async def _media_anonymously_visible(
    *,
    db,
    package_name: str,
    api_key: ApiKey | None,
) -> bool:
    """Return True if the underlying app (looked up by package) may be
    served through the media routes for this caller.

    Private apps' media (icons, banners, screenshots) is what makes their
    name guessable by probing. The rule is:

      * PUBLIC + PUBLISHED → always visible.
      * PRIVATE → only the owner's API key may fetch it. Other API keys
        and anonymous callers are 404'd, indistinguishable from a typo.
      * Repo-level media (no matching App row, e.g. the catalogue icon)
        stays anonymous so the logged-out home page renders.
    """
    app_row = (
        await db.execute(
            select(App).where(App.package_name == package_name)
        )
    ).scalar_one_or_none()
    if app_row is None:
        return True
    if app_row.visibility == AppVisibility.PUBLIC and app_row.status == AppStatus.PUBLISHED:
        return True
    if (
        api_key is not None
        and api_key.can_download_private
        and app_row.owner_id is not None
        and api_key.user_id == app_row.owner_id
    ):
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
    return await _serve_storage_object(key, content_type=_content_type_for(filename))


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
    return await _serve_storage_object(key, content_type=_content_type_for(filename))


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
    return await _serve_storage_object(key, content_type=_content_type_for(filename))


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
    """Return the right index variant for this caller.

    An API key with ``can_download_private`` resolves to its owner's per-user
    private index (``repo/private/u_<user_id>/...``). If that user has no
    private apps right now, the file is absent and we fall through to the
    public index — which gives the same view as an anonymous caller would
    get on a public-mode repo, plus access to private *download* URLs the
    user owns elsewhere in the API.
    """
    storage = get_storage()

    if api_key is not None and api_key.can_download_private:
        per_user_key = f"{user_private_prefix(api_key.user_id)}/{filename}"
        if await storage.exists(per_user_key):
            return await _serve_storage_object(
                per_user_key, content_type=_INDEX_FILES[filename],
            )

    storage_key = f"{REPO_PUBLIC_PREFIX}/{filename}"
    if not await storage.exists(storage_key):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                "Index not built yet. The admin must complete setup and trigger a reindex."
            ),
        )
    return await _serve_storage_object(storage_key, content_type=_INDEX_FILES[filename])


async def _serve_apk(
    filename: str,
    *,
    request: Request,
    db,
    api_key: ApiKey | None,
    signed_user_id: str | None = None,
) -> Response:
    """Locate the APK by file name and serve it (with auth checks).

    Two authentication channels feed into the private-app ACL:
      * ``api_key`` — F-Droid client over HTTP Basic; must belong to
        the app's owner and carry the ``can_download_private`` scope.
      * ``signed_user_id`` — SPA-issued HMAC token (see
        ``apks.issue_download_url``). The token already enforces
        ownership/admin at sign time, but we re-verify here in case
        ownership transferred between sign and click.
    """
    apk = (
        await db.execute(
            select(Apk).options(selectinload(Apk.app)).where(Apk.file_name == filename)
        )
    ).scalar_one_or_none()
    if apk is None or apk.status != ApkStatus.PUBLISHED:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="APK not found")

    app = apk.app
    if app.visibility == AppVisibility.PRIVATE:
        # API-key path — must be the owner's key and carry the scope.
        owner_match = (
            api_key is not None
            and api_key.can_download_private
            and app.owner_id is not None
            and api_key.user_id == app.owner_id
        )
        # Signed-URL path — resolve the user, accept owner or admin.
        # Ownership transfer between sign-time and click-time
        # invalidates the URL (revalidation, not just signature check).
        signed_match = False
        if not owner_match and signed_user_id is not None:
            try:
                signed_uuid = uuid.UUID(signed_user_id)
            except (TypeError, ValueError):
                signed_uuid = None
            if signed_uuid is not None:
                u = (
                    await db.execute(select(User).where(User.id == signed_uuid))
                ).scalar_one_or_none()
                if u is not None and u.is_active:
                    signed_match = (
                        u.role == UserRole.ADMIN
                        or (app.owner_id is not None and u.id == app.owner_id)
                    )
        if not (owner_match or signed_match):
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

    return await _serve_storage_object(apk.storage_key, content_type="application/vnd.android.package-archive")
