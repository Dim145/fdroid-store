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
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession, get_current_user
from app.core.logging import get_logger
from app.models.app import App, AppScreenshot
from app.models.user import User, UserRole
from app.services.queue import enqueue_reindex
from app.storage import get_storage

router = APIRouter()
log = get_logger(__name__)

# Stored under the same locale subdirectory layout as screenshots so the
# F-Droid client can read it through its existing media URL conventions.
_DEFAULT_FG_LOCALE = "en-US"


async def _load_owned_app(db, app_id: uuid.UUID, user: User) -> App:
    app = (
        await db.execute(
            select(App)
            .options(selectinload(App.apks), selectinload(App.screenshots))
            .where(App.id == app_id)
        )
    ).scalar_one_or_none()
    if app is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App not found")
    if app.owner_id != user.id and user.role != UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    return app


def _normalize_to_png(raw: bytes, max_size: tuple[int, int]) -> bytes:
    """Validate + re-encode an image to PNG with a max bounding box.

    Raises ``HTTPException(400)`` if the bytes don't decode.
    """
    try:
        with Image.open(io.BytesIO(raw)) as probe:
            probe.verify()
        img = Image.open(io.BytesIO(raw)).convert("RGBA")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File is not a valid image",
        ) from exc
    img.thumbnail(max_size, Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# --------------------------------------------------------------------------
# Icon
# --------------------------------------------------------------------------
@router.post("/{app_id}/icon", response_model=dict)
async def upload_custom_icon(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
    file: UploadFile = File(...),
) -> dict:
    """Override the auto-extracted icon with an admin-supplied one.

    Sets ``icon_is_custom = True`` so future APK uploads don't replace it.
    """
    app = await _load_owned_app(db, app_id, user)
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")
    png = _normalize_to_png(raw, (512, 512))

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
    user: Annotated[User, Depends(get_current_user)],
    file: UploadFile = File(...),
) -> dict:
    """Set the app's featured graphic (the wide banner the F-Droid client
    shows above the description). Re-encoded to PNG and capped at 1024×500,
    which matches the dimensions Google Play and F-Droid clients optimise
    for; clients downscale as needed."""
    app = await _load_owned_app(db, app_id, user)
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")
    png = _normalize_to_png(raw, (1024, 500))

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
    user: Annotated[User, Depends(get_current_user)],
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


@router.delete(
    "/{app_id}/icon",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    response_class=Response,
)
async def revert_to_auto_icon(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
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
    user: Annotated[User, Depends(get_current_user)],
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
        raw = await upload.read()
        if not raw:
            continue
        # Screenshots can stay larger than icons — phone images are typically
        # 1080×1920 (or similar). Cap at a sensible upper bound.
        png = _normalize_to_png(raw, (1080, 1920))

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
) -> list[dict]:
    """Public listing — no auth needed to enumerate an app's screenshots."""
    app = (
        await db.execute(
            select(App).options(selectinload(App.screenshots)).where(App.id == app_id)
        )
    ).scalar_one_or_none()
    if app is None:
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
    user: Annotated[User, Depends(get_current_user)],
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


@router.patch("/{app_id}/screenshots/reorder", response_model=list[dict])
async def reorder_screenshots(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
    ordered_ids: list[uuid.UUID] = [],
) -> list[dict]:
    """Apply the order from a UI drag-and-drop. Missing or unknown ids are
    ignored — IDs not in the input keep their current relative order at the
    end of the list.
    """
    app = await _load_owned_app(db, app_id, user)
    by_id = {s.id: s for s in app.screenshots}
    seen: set[uuid.UUID] = set()
    order = 0
    for sid in ordered_ids:
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
