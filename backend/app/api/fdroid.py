"""F-Droid client-facing endpoints (``/fdroid/repo/...``).

This is the path that gets configured in F-Droid Android as the repo URL.
The endpoint:
  * serves ``index-v1.jar`` / ``index-v2.json`` / ``entry.jar`` from storage
  * serves APK binaries
  * picks the **public** or **private** index based on Basic-auth credentials
"""
from __future__ import annotations

import json
import re
import uuid
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse, Response, StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import (
    DbSession,
    _api_key_from_secret,
    get_api_key_from_basic_auth,
    get_current_user_optional,
    is_public_mode,
)
from app.core.client_ip import client_ip, hash_ip
from app.core.config import settings
from app.core.download_token import verify_download_token, verify_media_token
from app.core.logging import get_logger
from app.fdroid.repo_builder import (
    REPO_PUBLIC_NSFW_PREFIX,
    REPO_PUBLIC_PREFIX,
    user_private_prefix,
)
from app.models.api_key import ApiKey
from app.models.apk import Apk, ApkStatus
from app.models.app import App, AppStatus, AppVisibility
from app.models.audit import DownloadEvent
from app.models.repo_config import RepoConfig
from app.models.user import User, UserRole
from app.storage import Storage, get_storage
from app.storage.local import LocalStorage

log = get_logger(__name__)

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


# One storage-key segment — the alphabet every server-generated key uses,
# and all ``LocalStorage`` accepts. A request naming anything else can't
# match a stored file: 404 it up front rather than let the storage layer
# raise (a 500 on e.g. ``icons/a%20b.png``). Also refuses separators and
# dotfiles.
_SAFE_SEGMENT = re.compile(r"[A-Za-z0-9._-]{1,255}")


def _safe_segments(*segments: str) -> bool:
    return all(
        _SAFE_SEGMENT.fullmatch(seg) is not None and not seg.startswith(".")
        for seg in segments
    )


async def _exists(storage: Storage, key: str) -> bool:
    """``storage.exists`` for the serving paths. A key the backend refuses
    to resolve is simply missing; a storage failure (S3 timeout, 5xx, 403)
    is a 503 — never a "missing" that would serve another index variant or
    locale in its place."""
    try:
        return await storage.exists(key)
    except ValueError:
        return False
    except Exception as exc:  # noqa: BLE001 — any backend failure
        log.warning("storage lookup failed", key=key, error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Storage temporarily unavailable",
            headers={"Retry-After": "5"},
        ) from exc


def _starts_download(range_header: str | None) -> bool:
    """Whether an APK GET counts as a download: the whole file (no
    ``Range``) or a range from byte 0. Resumes and parallel chunks
    (``bytes=N-`` with N > 0, suffix ranges) belong to a download that was
    already counted; an unparsable byte range isn't served as one."""
    if not range_header:
        return True
    unit, _, ranges = range_header.partition("=")
    if unit.strip().lower() != "bytes":
        return True  # unknown unit: ignored, the whole file is sent
    start, dash, _ = ranges.split(",", 1)[0].partition("-")
    start = start.strip()
    # ``isascii``: ``"²".isdigit()`` is true but ``int("²")`` raises.
    return bool(dash) and start.isascii() and start.isdigit() and int(start) == 0


def _cache_control_for(storage_key: str) -> str:
    """Sensible browser-cache policy for the F-Droid asset shape.

    Three buckets:
      * Index files — rewritten on every reindex, MUST revalidate.
      * APK files — version code is baked into the filename so the
        bytes behind a URL never change. Long immutable cache.
        ``private`` (not ``public``) because private-mode APK URLs
        are gated by per-user credentials (Basic-auth API key OR a
        per-user signed ``?t=``); a shared CDN keyed on URL alone
        would otherwise replay one user's authorized 200 to other
        callers (CWE-525).
      * Everything else (icons, screenshots, banners) — content can
        be replaced under a stable key but the frontend cache-busts
        with ``?v=<updated_at>``. Identity-gated for private apps
        served via the SW JWT-bearer path; same shared-CDN concern,
        same ``private`` answer.
    """
    name = storage_key.rsplit("/", 1)[-1].lower()
    if name in {"index-v1.jar", "index-v2.json", "entry.jar"}:
        return "no-cache, must-revalidate"
    if name.endswith(".apk"):
        return "private, max-age=31536000, immutable"
    return "private, max-age=86400"


async def _serve_storage_object(
    storage_key: str, *, content_type: str, allow_x_accel: bool = False
) -> Response:
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
    headers = {"Cache-Control": _cache_control_for(storage_key)}
    storage = get_storage()
    if isinstance(storage, LocalStorage):
        try:
            path = storage.local_path(storage_key)
        except ValueError:  # not a key LocalStorage can hold
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="File not found"
            ) from None
        if not path.exists():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
        if allow_x_accel and settings.x_accel_redirect_enabled:
            # Hand the byte transfer to nginx: it serves /data/storage/<key>
            # via its internal /_protected/ location (sendfile, native Range/
            # resume, no Python nor backend read-timeout in the path). Only
            # used for large APKs; icons/index keep the FileResponse path so
            # their Content-Type stays exact. ``quote(safe="/")`` keeps path
            # separators while escaping anything else in the key.
            headers["X-Accel-Redirect"] = "/_protected/" + quote(storage_key, safe="/")
            headers["Content-Type"] = content_type
            return Response(status_code=status.HTTP_200_OK, headers=headers)
        # FileResponse sets Content-Length from the stat AND honours Range
        # requests (206), so a dropped download can be resumed.
        return FileResponse(str(path), media_type=content_type, headers=headers)
    if not await _exists(storage, storage_key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    # Two response shapes depending on size:
    #
    #   * Small object (icon, index JSON / jar)  — read fully into memory
    #     and return a plain ``Response``. This sets Content-Length
    #     exactly (no streaming mismatch risk) and lets the F-Droid
    #     client show a precise progress bar on the index pull.
    #   * Large object (APK)                    — stream chunks via
    #     ``StreamingResponse`` with NO explicit Content-Length. Starlette
    #     then uses chunked transfer encoding; the F-Droid client falls
    #     back to indeterminate progress but the bytes flow correctly.
    #
    # The reason we don't set Content-Length on the streaming path: the
    # SlowAPI rate-limit middleware uses ``BaseHTTPMiddleware`` which
    # buffers responses, and the buffered re-emit can drop the final
    # ``more_body=False`` ordering, leaving uvicorn raising
    # ``RuntimeError: Response content shorter than Content-Length``
    # at the tail of every download. Chunked encoding sidesteps the
    # check entirely.
    BUFFER_LIMIT = 5 * 1024 * 1024  # 5 MiB — icons + index files comfortably fit
    try:
        size = await storage.size(storage_key)
    except Exception:  # noqa: BLE001 — fall through to streaming on any HEAD failure
        size = None
    if size is not None and size <= BUFFER_LIMIT:
        data = await storage.get_bytes(storage_key)
        return Response(content=data, media_type=content_type, headers=headers)
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
        return await _serve_index(filename, db, api_key)
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
    bearer_user: User | None = None,
) -> bool:
    """Return True if the underlying app (looked up by package) may be
    served through the media routes for this caller.

    Private apps' media (icons, banners, screenshots) is what makes their
    name guessable by probing. The rule is:

      * PUBLIC + PUBLISHED → always visible.
      * PRIVATE → owner's API key OR a JWT bearer (web SPA via the
        Service Worker that adds ``Authorization: Bearer <jwt>`` on
        every <img> fetch) belonging to the owner / an admin.
      * Other API keys and anonymous callers are 404'd, indistinguishable
        from a typo.
      * No App row (deleted app, typo) → refused: the files of a deleted
        app may outlive it. Repo-level media (the catalogue icon) has no
        package and never gets here, so the logged-out pages still render.

    Private mode (no anonymous access at all) is enforced by
    ``_media_visible`` before this runs.
    """
    app_row = (
        await db.execute(
            select(App).where(App.package_name == package_name)
        )
    ).scalar_one_or_none()
    if app_row is None:
        return False
    if app_row.visibility == AppVisibility.PUBLIC and app_row.status == AppStatus.PUBLISHED:
        return True
    if (
        api_key is not None
        and api_key.can_download_private
        and app_row.owner_id is not None
        and api_key.user_id == app_row.owner_id
    ):
        return True
    if bearer_user is not None and bearer_user.is_active:
        if bearer_user.role == UserRole.ADMIN:
            return True
        if app_row.owner_id is not None and bearer_user.id == app_row.owner_id:
            return True
        # Co-maintainers manage media + listing on the apps they collab
        # on (see ``app/services/app_permissions.py``). They need to
        # render private-app images in the SPA just like owners do.
        from app.models.app_collaborator import AppCollaborator
        collab = await db.execute(
            select(AppCollaborator.id).where(
                AppCollaborator.app_id == app_row.id,
                AppCollaborator.user_id == bearer_user.id,
            ).limit(1)
        )
        if collab.scalar_one_or_none() is not None:
            return True
    return False


async def _media_visible(
    *,
    db,
    package_name: str,
    api_key: ApiKey | None,
    bearer_user: User | None,
    token: str | None,
) -> bool:
    """Gate for every per-package media file.

    A media token (``?t=``, minted for a caller allowed to see the app)
    always passes. In private mode anything else needs credentials — an API
    key (Basic auth / ``/r/<key>``, which F-Droid clients send) or the SPA's
    JWT (added by its Service Worker, ``frontend/public/sw.js``) — or the
    route would leak images and confirm which packages exist. Then the
    per-app rule of ``_media_anonymously_visible`` applies.
    """
    if token and verify_media_token(package_name, token):
        return True
    if api_key is None and bearer_user is None and not await is_public_mode(db):
        return False
    return await _media_anonymously_visible(
        db=db, package_name=package_name, api_key=api_key, bearer_user=bearer_user,
    )


@router.get("/icons/{filename}")
async def serve_icon(
    filename: str,
    db: DbSession,
    api_key: Annotated[ApiKey | None, Depends(get_api_key_from_basic_auth)] = None,
    bearer_user: Annotated[User | None, Depends(get_current_user_optional)] = None,
    t: str | None = None,
) -> Response:
    """Icons.

    Refuse anonymously serving icons of private / unpublished apps — the
    file naming (``icons/<package>.png``) made the F-Droid serve route a
    package-name oracle for private packages (CWE-203). Catalogue
    thumbnails of public apps stay public in public mode so the logged-out
    home page still renders; the repo's own icon stays public in every
    mode (login page). Owners' SPA sessions pass a ``?t=<media_token>``
    that binds to the package (see ``download_token.sign_media_token``);
    the token survives the lack of an Authorization header on ``<img>``.
    """
    # Reject any path separator / dotfile / character no storage key uses
    # before the name reaches the storage key, mirroring the other media
    # routes. The FastAPI ``{filename}`` converter already refuses ``/``
    # and the local backend re-anchors under its root, but the S3 backend
    # has no such barrier — so defend in depth here rather than rely on
    # either.
    if not _safe_segments(filename):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Icon not found")
    # Filename layout is ``<package>.png``, ``<package>-custom.png``,
    # ``fdroid-icon.png`` (the repo's own icon), or ``repo-icon-<ts>.png``.
    # Derive the package name only for the per-app variants.
    base = filename.rsplit(".", 1)[0]
    package_name: str | None = None
    if not base.startswith("repo-icon") and base != "fdroid-icon":
        package_name = base.removesuffix("-custom")
    if package_name and not await _media_visible(
        db=db, package_name=package_name, api_key=api_key,
        bearer_user=bearer_user, token=t,
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Icon not found")
    storage = get_storage()
    key = f"icons/{filename}"
    if not await _exists(storage, key):
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


# Per-app media is currently uploaded only at the ``en-US`` locale, but
# F-Droid clients (and our own catalogue under a non-English UI) can
# legitimately request the same asset under a different BCP47 tag —
# matching whichever locale the index marked as available for that app's
# *text* localizations. Until we genuinely support per-locale media,
# we transparently fall back to ``en-US`` when the requested locale's
# file is missing. Keeps the "images are the same for every language"
# contract working without forcing every caller to second-guess the tag.
_MEDIA_FALLBACK_LOCALE = "en-US"


@router.get("/{package}/{locale}/{filename}")
async def serve_singleton_media(
    package: str,
    locale: str,
    filename: str,
    db: DbSession,
    api_key: Annotated[ApiKey | None, Depends(get_api_key_from_basic_auth)] = None,
    bearer_user: Annotated[User | None, Depends(get_current_user_optional)] = None,
    t: str | None = None,
) -> Response:
    if filename not in _ALLOWED_SINGLETON_MEDIA:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if not _safe_segments(package, locale, filename):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if not await _media_visible(
        db=db, package_name=package, api_key=api_key, bearer_user=bearer_user, token=t,
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    storage = get_storage()
    key = f"{package}/{locale}/{filename}"
    if not await _exists(storage, key):
        if locale != _MEDIA_FALLBACK_LOCALE:
            fallback = f"{package}/{_MEDIA_FALLBACK_LOCALE}/{filename}"
            if await _exists(storage, fallback):
                key = fallback
            else:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
        else:
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
    bearer_user: Annotated[User | None, Depends(get_current_user_optional)] = None,
    t: str | None = None,
) -> Response:
    # Screenshots are <img>-loaded previews but the URL doubles as a
    # package-name oracle for private apps if served anonymously. Gate on
    # the same rule as the icon route.
    if kind not in _ALLOWED_MEDIA_KINDS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    # Defensive: refuse traversal-y components
    if not _safe_segments(package, locale, kind, filename):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if not await _media_visible(
        db=db, package_name=package, api_key=api_key, bearer_user=bearer_user, token=t,
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    storage = get_storage()
    key = f"{package}/{locale}/{kind}/{filename}"
    if not await _exists(storage, key):
        if locale != _MEDIA_FALLBACK_LOCALE:
            fallback = f"{package}/{_MEDIA_FALLBACK_LOCALE}/{kind}/{filename}"
            if await _exists(storage, fallback):
                key = fallback
            else:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
        else:
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

    Same checks as the Basic-auth path (``deps._api_key_from_secret``:
    parse, active, secret, enabled owner, throttled ``last_used_at``).
    Every failure returns 404 (not 401) so we don't leak information about
    which prefixes exist.
    """
    key = await _api_key_from_secret(token, db)
    if key is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
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
async def _index_prefix(db, storage: Storage, api_key: ApiKey | None) -> str:
    """The index variant this caller gets — decided the same way whichever
    of the three files is asked for, so a client never pairs an
    ``entry.jar`` from one variant with an ``index-v2.json`` from another.

    An API key with ``can_download_private`` resolves to its owner's
    per-user variant (``repo/private/u_<user_id>/...``) when:
      * the user is in ``RepoConfig.private_index_owner_ids`` — the last
        rebuild still produces their variant. A user the rebuild dropped
        never gets their old files back, even if deleting them failed;
      * its ``entry.jar`` exists: it is uploaded last and deleted first, so
        the variant is complete.
    Otherwise such a key whose user opted into NSFW gets the shared
    public + NSFW variant (same completeness rule). Anyone else gets the
    public index — the same view as an anonymous caller on a public-mode
    repo.
    """
    if api_key is None or not api_key.can_download_private:
        return REPO_PUBLIC_PREFIX
    raw = (
        await db.execute(select(RepoConfig.private_index_owner_ids).limit(1))
    ).scalar_one_or_none()
    try:
        owners = json.loads(raw or "[]")
    except json.JSONDecodeError:
        owners = []
    if isinstance(owners, list) and str(api_key.user_id) in owners:
        prefix = user_private_prefix(api_key.user_id)
        if await _exists(storage, f"{prefix}/entry.jar"):
            return prefix
    show_nsfw = (
        await db.execute(select(User.show_nsfw).where(User.id == api_key.user_id))
    ).scalar_one_or_none()
    if show_nsfw and await _exists(storage, f"{REPO_PUBLIC_NSFW_PREFIX}/entry.jar"):
        return REPO_PUBLIC_NSFW_PREFIX
    return REPO_PUBLIC_PREFIX


async def _serve_index(filename: str, db, api_key: ApiKey | None) -> Response:
    """Return the right index variant for this caller (see ``_index_prefix``).
    A storage failure is a 503, never a silent fall back to the public
    variant — a private user's client would drop their private apps."""
    storage = get_storage()
    storage_key = f"{await _index_prefix(db, storage, api_key)}/{filename}"
    if not await _exists(storage, storage_key):
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

    Only APKs of PUBLISHED apps are served to everyone. Two authentication
    channels feed into the private-app ACL — the same owner/admin rule
    that also unlocks APKs of an app that is not (or no longer) published:
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

    # Resolve the signed-URL user once up-front. We need it for two
    # purposes: gating private-app access AND attributing the download
    # event. Previously we only resolved it inside the private branch
    # and never carried the result into the audit row — every
    # logged-in SPA click on a public APK was logged as anonymous.
    signed_user: User | None = None
    if signed_user_id is not None:
        try:
            signed_uuid = uuid.UUID(signed_user_id)
        except (TypeError, ValueError):
            signed_uuid = None
        if signed_uuid is not None:
            signed_user = (
                await db.execute(select(User).where(User.id == signed_uuid))
            ).scalar_one_or_none()
            if signed_user is not None and not signed_user.is_active:
                signed_user = None

    # API-key path — must be the owner's key and carry the scope.
    owner_match = (
        api_key is not None
        and api_key.can_download_private
        and app.owner_id is not None
        and api_key.user_id == app.owner_id
    )
    # Signed-URL path — accept whoever manages the app (owner,
    # co-maintainer, admin), the people ``apks.issue_download_url`` mints
    # links for. Rights are re-checked at click time (revalidation, not
    # just signature check): a removed co-maintainer's link stops working.
    from app.services.app_permissions import can_manage_app

    signed_match = signed_user is not None and await can_manage_app(db, signed_user, app)
    if app.visibility == AppVisibility.PRIVATE and not (owner_match or signed_match):
        return Response(
            status_code=status.HTTP_401_UNAUTHORIZED,
            headers={"WWW-Authenticate": 'Basic realm="fdroid-store"'},
        )
    if app.status != AppStatus.PUBLISHED and not (owner_match or signed_match):
        # Archived / rejected (taken down) or not yet live: the binaries go
        # with the listing — except for the owner's key and the people who
        # manage the app (signed links from ``apks.issue_download_url``).
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="APK not found")

    # Attribute the download. Precedence: API key (F-Droid Basic auth)
    # wins, then signed-URL SPA session, otherwise anonymous.
    attributed_user_id = (
        api_key.user_id if api_key is not None
        else signed_user.id if signed_user is not None
        else None
    )

    # Record the download — once per download, not per resumed / parallel
    # chunk. Best effort: the savepoint keeps a failed insert from
    # poisoning the request's transaction (its commit would fail the
    # response). ``api_key.last_used_at`` is already refreshed, throttled,
    # by ``deps._api_key_from_secret``.
    if _starts_download(request.headers.get("range")):
        try:
            async with db.begin_nested():
                db.add(
                    DownloadEvent(
                        apk_id=apk.id,
                        app_id=app.id,
                        user_id=attributed_user_id,
                        api_key_id=api_key.id if api_key else None,
                        ip_hash=hash_ip(client_ip(request)),
                        user_agent=(request.headers.get("user-agent") or "")[:512] or None,
                        bytes_served=apk.size_bytes,
                        status_code=200,
                    )
                )
        except Exception as exc:  # noqa: BLE001 — stats must never fail a download
            log.warning("could not record download", apk=apk.file_name, error=str(exc))

    return await _serve_storage_object(
        apk.storage_key,
        content_type="application/vnd.android.package-archive",
        allow_x_accel=True,
    )
