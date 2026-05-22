"""Per-app icon and screenshot management.

Storage layout:

  * Auto icon: ``icons/<package>.png`` — overwritten on every APK upload
    (converted to PNG and resized to 512x512 max).
  * Custom icon: ``icons/<package>-custom.png`` — set via this endpoint,
    sticky until the admin reverts.
  * Screenshots: ``<package>/<locale>/phoneScreenshots/<screenshot-id>.png``
    — matches the path layout that F-Droid clients expect, so the
    ``/fdroid/repo/...`` endpoint can serve them straight from storage.
"""
from __future__ import annotations

import hashlib
import io
import uuid
from typing import Annotated

from PIL import Image
from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession, get_current_user, get_current_user_optional, get_current_uploader, is_public_mode
from app.core.logging import get_logger
from app.core.uploads import normalize_image, read_capped
from app.models.app import App, AppScreenshot, AppStatus, AppVisibility
from app.models.user import User, UserRole
from app.services.queue import enqueue_reindex
from app.storage import get_storage

# Per-endpoint upload caps. Anything above these is rejected before the
# bytes hit memory; the PIL pipeline also enforces a global pixel-count
# limit (see app/core/uploads.py).
_MAX_ICON_BYTES = 4 * 1024 * 1024          # 4 MiB
_MAX_FEATURE_GRAPHIC_BYTES = 8 * 1024 * 1024  # 8 MiB
_MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024   # 12 MiB

router = APIRouter()
log = get_logger(__name__)

# Stored under the same locale subdirectory layout as screenshots so the
# F-Droid client can read it through its existing media URL conventions.
_DEFAULT_FG_LOCALE = "en-US"


async def _load_owned_app(db, app_id: uuid.UUID, user: User) -> App:
    """Despite the name, this helper accepts co-maintainers too — image
    uploads are part of "managing the listing" and collaborators have
    full rights on that. Renaming the function would touch a lot of
    callers, so the doc note here is the contract."""
    from app.services.app_permissions import assert_can_manage_app

    app = (
        await db.execute(
            select(App)
            .options(selectinload(App.apks), selectinload(App.screenshots))
            .where(App.id == app_id)
        )
    ).scalar_one_or_none()
    if app is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App not found")
    await assert_can_manage_app(db, user, app)
    return app


# Image normalisation is now in app.core.uploads — same pipeline shared with
# the repo-icon endpoint, with format whitelisting + decompression-bomb
# detection + ``asyncio.to_thread`` to keep the event loop responsive on
# multi-megapixel inputs.


# --------------------------------------------------------------------------
# Icon
# --------------------------------------------------------------------------
@router.post("/{app_id}/icon", response_model=dict)
async def upload_custom_icon(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
    file: UploadFile = File(...),
) -> dict:
    """Override the auto-extracted icon with an admin-supplied one.

    Sets ``icon_is_custom = True`` so future APK uploads don't replace it.
    """
    app = await _load_owned_app(db, app_id, user)
    raw = await read_capped(file, _MAX_ICON_BYTES)
    if not raw:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")
    png = await normalize_image(raw, (512, 512))

    storage = get_storage()
    key = f"icons/{app.package_name}-custom.png"
    await storage.put(key, png, content_type="image/png")
    app.icon_path = key
    app.icon_is_custom = True
    await db.flush()
    await enqueue_reindex()
    return {"icon_path": key, "icon_is_custom": True}


@router.post("/{app_id}/feature-graphic", response_model=dict)
async def upload_feature_graphic(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
    file: UploadFile = File(...),
) -> dict:
    """Set the app's featured graphic (the wide banner the F-Droid client
    shows above the description). Re-encoded to PNG and capped at 1024×500,
    which matches the dimensions Google Play and F-Droid clients optimise
    for; clients downscale as needed."""
    app = await _load_owned_app(db, app_id, user)
    raw = await read_capped(file, _MAX_FEATURE_GRAPHIC_BYTES)
    if not raw:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")
    png = await normalize_image(raw, (1024, 500))

    storage = get_storage()
    key = f"{app.package_name}/{_DEFAULT_FG_LOCALE}/featureGraphic.png"
    await storage.put(key, png, content_type="image/png")
    app.feature_graphic_path = key
    await db.flush()
    await enqueue_reindex()
    return {"feature_graphic_path": key}


@router.delete(
    "/{app_id}/feature-graphic",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    response_class=Response,
)
async def delete_feature_graphic(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> None:
    app = await _load_owned_app(db, app_id, user)
    if not app.feature_graphic_path:
        return
    storage = get_storage()
    try:
        await storage.delete(app.feature_graphic_path)
    except Exception:  # noqa: BLE001
        pass
    app.feature_graphic_path = None
    await db.flush()
    await enqueue_reindex()


# --------------------------------------------------------------------------
# promoGraphic + tvBanner — same shape as featureGraphic, different sizes
# and different storage filenames. The F-Droid v2 spec uses these on
# different surfaces (tablet promo strips, Android TV launchers); shipping
# them gives clients the assets they expect without forcing them to use the
# featureGraphic as a stand-in.
# --------------------------------------------------------------------------
_MAX_PROMO_GRAPHIC_BYTES = 4 * 1024 * 1024   # 4 MiB — promo is small (320×180-ish)
_MAX_TV_BANNER_BYTES = 12 * 1024 * 1024      # 12 MiB — TV banner is the biggest of the three


@router.post("/{app_id}/promo-graphic", response_model=dict)
async def upload_promo_graphic(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
    file: UploadFile = File(...),
) -> dict:
    """A smaller promo tile (Play Store style ~320×180). F-Droid v2 clients
    use it on tablet layouts."""
    app = await _load_owned_app(db, app_id, user)
    raw = await read_capped(file, _MAX_PROMO_GRAPHIC_BYTES)
    if not raw:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")
    png = await normalize_image(raw, (320, 180))

    storage = get_storage()
    key = f"{app.package_name}/{_DEFAULT_FG_LOCALE}/promoGraphic.png"
    await storage.put(key, png, content_type="image/png")
    app.promo_graphic_path = key
    await db.flush()
    await enqueue_reindex()
    return {"promo_graphic_path": key}


@router.delete(
    "/{app_id}/promo-graphic",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    response_class=Response,
)
async def delete_promo_graphic(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> None:
    app = await _load_owned_app(db, app_id, user)
    if not app.promo_graphic_path:
        return
    storage = get_storage()
    try:
        await storage.delete(app.promo_graphic_path)
    except Exception:  # noqa: BLE001
        pass
    app.promo_graphic_path = None
    await db.flush()
    await enqueue_reindex()


@router.post("/{app_id}/tv-banner", response_model=dict)
async def upload_tv_banner(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
    file: UploadFile = File(...),
) -> dict:
    """Android TV banner — 16:9 wide. Capped at 1280×720 which is what the
    Android TV launcher actually renders."""
    app = await _load_owned_app(db, app_id, user)
    raw = await read_capped(file, _MAX_TV_BANNER_BYTES)
    if not raw:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")
    png = await normalize_image(raw, (1280, 720))

    storage = get_storage()
    key = f"{app.package_name}/{_DEFAULT_FG_LOCALE}/tvBanner.png"
    await storage.put(key, png, content_type="image/png")
    app.tv_banner_path = key
    await db.flush()
    await enqueue_reindex()
    return {"tv_banner_path": key}


@router.delete(
    "/{app_id}/tv-banner",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    response_class=Response,
)
async def delete_tv_banner(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> None:
    app = await _load_owned_app(db, app_id, user)
    if not app.tv_banner_path:
        return
    storage = get_storage()
    try:
        await storage.delete(app.tv_banner_path)
    except Exception:  # noqa: BLE001
        pass
    app.tv_banner_path = None
    await db.flush()
    await enqueue_reindex()


@router.delete(
    "/{app_id}/icon",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    response_class=Response,
)
async def revert_to_auto_icon(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> None:
    """Clear the custom flag. The icon falls back to the one extracted from
    the latest published APK (which already sits at ``icons/<pkg>.png``).
    Returns 204 even when there is no auto icon — the app simply has none.
    """
    app = await _load_owned_app(db, app_id, user)
    if not app.icon_is_custom:
        return

    storage = get_storage()
    custom_key = f"icons/{app.package_name}-custom.png"
    auto_key = f"icons/{app.package_name}.png"

    # Delete the custom blob (best-effort).
    try:
        await storage.delete(custom_key)
    except Exception:  # noqa: BLE001
        pass

    app.icon_is_custom = False
    app.icon_path = auto_key if await storage.exists(auto_key) else None
    await db.flush()
    await enqueue_reindex()


# --------------------------------------------------------------------------
# Screenshots
# --------------------------------------------------------------------------
@router.post("/{app_id}/screenshots", response_model=list[dict])
async def upload_screenshots(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
    files: list[UploadFile] = File(...),
    locale: str = "en-US",
) -> list[dict]:
    """Append one or more screenshots to an app.

    Stored under ``<package>/<locale>/phoneScreenshots/<id>.png`` so the
    F-Droid client finds them at the path advertised in the index.
    """
    app = await _load_owned_app(db, app_id, user)
    storage = get_storage()

    # New ones come after the existing ones
    next_order = max((s.display_order for s in app.screenshots), default=-1) + 1

    created: list[AppScreenshot] = []
    for upload in files:
        raw = await read_capped(upload, _MAX_SCREENSHOT_BYTES)
        if not raw:
            continue
        # Screenshots can stay larger than icons — phone images are typically
        # 1080×1920 (or similar). Cap at a sensible upper bound.
        png = await normalize_image(raw, (1080, 1920))

        with Image.open(io.BytesIO(png)) as img:
            width, height = img.size

        screenshot_id = uuid.uuid4()
        key = f"{app.package_name}/{locale}/phoneScreenshots/{screenshot_id}.png"
        await storage.put(key, png, content_type="image/png")

        row = AppScreenshot(
            id=screenshot_id,
            app_id=app.id,
            locale=locale,
            storage_key=key,
            sha256=hashlib.sha256(png).hexdigest(),
            size_bytes=len(png),
            width=width,
            height=height,
            display_order=next_order,
        )
        db.add(row)
        created.append(row)
        next_order += 1

    await db.flush()
    await enqueue_reindex()
    return [
        {
            "id": str(s.id),
            "storage_key": s.storage_key,
            "sha256": s.sha256,
            "size_bytes": s.size_bytes,
            "width": s.width,
            "height": s.height,
            "display_order": s.display_order,
            "locale": s.locale,
        }
        for s in created
    ]


@router.get("/{app_id}/screenshots", response_model=list[dict])
async def list_screenshots(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User | None, Depends(get_current_user_optional)],
) -> list[dict]:
    """List screenshots for an app. Honours the same visibility rules as the
    catalogue: a private app's screenshots are only listable by its owner
    or by an admin, and anonymous callers are bounced when the repo is not
    in public mode. The previous "no auth needed" wide-open behaviour
    leaked private package names via storage_key inspection (CWE-639)."""
    app = (
        await db.execute(
            select(App).options(selectinload(App.screenshots)).where(App.id == app_id)
        )
    ).scalar_one_or_none()
    if app is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App not found")
    # Anonymous + private mode → never. Anonymous + public mode → only
    # PUBLIC + PUBLISHED apps. Authenticated → owner / admin / any
    # PUBLIC+PUBLISHED.
    if user is None and not await is_public_mode(db):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    public_listable = (
        app.visibility == AppVisibility.PUBLIC and app.status == AppStatus.PUBLISHED
    )
    if not public_listable:
        if user is None or (user.role != UserRole.ADMIN and app.owner_id != user.id):
            # Mask existence to the unauthorised caller.
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App not found")
    return [
        {
            "id": str(s.id),
            "storage_key": s.storage_key,
            "sha256": s.sha256,
            "size_bytes": s.size_bytes,
            "width": s.width,
            "height": s.height,
            "display_order": s.display_order,
            "locale": s.locale,
        }
        for s in app.screenshots
    ]


@router.delete(
    "/{app_id}/screenshots/{screenshot_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    response_class=Response,
)
async def delete_screenshot(
    app_id: uuid.UUID,
    screenshot_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> None:
    app = await _load_owned_app(db, app_id, user)
    target = next((s for s in app.screenshots if s.id == screenshot_id), None)
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Screenshot not found"
        )
    storage = get_storage()
    try:
        await storage.delete(target.storage_key)
    except Exception:  # noqa: BLE001
        pass
    await db.delete(target)
    await db.flush()
    await enqueue_reindex()


class ScreenshotReorderRequest(BaseModel):
    ordered_ids: list[uuid.UUID] = Field(
        default_factory=list,
        description="Screenshot ids in the desired display order. Unknown ids are "
        "skipped, omitted ones keep their current relative order at the end.",
    )


@router.patch("/{app_id}/screenshots/reorder", response_model=list[dict])
async def reorder_screenshots(
    app_id: uuid.UUID,
    payload: ScreenshotReorderRequest,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> list[dict]:
    """Apply the order from a UI drag-and-drop. Missing or unknown ids are
    ignored — IDs not in the input keep their current relative order at the
    end of the list.
    """
    app = await _load_owned_app(db, app_id, user)
    by_id = {s.id: s for s in app.screenshots}
    seen: set[uuid.UUID] = set()
    order = 0
    for sid in payload.ordered_ids:
        s = by_id.get(sid)
        if s is None:
            continue
        s.display_order = order
        seen.add(sid)
        order += 1
    # remaining (unmentioned) screenshots get appended in their current order
    for s in sorted(app.screenshots, key=lambda x: x.display_order):
        if s.id not in seen:
            s.display_order = order
            order += 1
    await db.flush()
    await enqueue_reindex()
    return [
        {"id": str(s.id), "display_order": s.display_order}
        for s in sorted(app.screenshots, key=lambda x: x.display_order)
    ]
