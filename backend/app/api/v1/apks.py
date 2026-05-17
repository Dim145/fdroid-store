from __future__ import annotations

import tempfile
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession, get_current_user
from app.core.logging import get_logger
from app.fdroid.apk_parser import ApkMetadata, ApkParseError, parse_apk
from app.models.apk import Apk, ApkStatus
from app.models.app import App, AppStatus
from app.models.user import User, UserRole
from app.schemas.app import ApkInspect, ApkRead, ApkUpdate
from app.services.queue import enqueue_reindex
from app.storage import get_storage

router = APIRouter()
log = get_logger(__name__)


# --------------------------------------------------------------------------
# Helpers (also used by /apps/with-apk)
# --------------------------------------------------------------------------
async def save_upload_to_temp(upload: UploadFile) -> Path:
    """Stream an UploadFile to a NamedTemporaryFile. Caller cleans up."""
    if not upload.filename or not upload.filename.lower().endswith(".apk"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Expected an .apk file",
        )
    with tempfile.NamedTemporaryFile(suffix=".apk", delete=False) as tmp:
        path = Path(tmp.name)
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            tmp.write(chunk)
    return path


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
    tmp_path = await save_upload_to_temp(file)
    try:
        meta = await parse_or_400(tmp_path)
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
    if app.owner_id != user.id and user.role != UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")

    tmp_path = await save_upload_to_temp(file)
    try:
        meta = await parse_or_400(tmp_path)
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
    if apk.app.owner_id != user.id and user.role != UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")

    # Distinguish "not provided" (don't touch) from "explicitly null/empty"
    # (clear it). Pydantic ``model_fields_set`` only contains keys the
    # client actually sent — exactly the discriminator we need.
    if "whats_new" in payload.model_fields_set:
        if payload.whats_new is None:
            apk.whats_new = None
        else:
            cleaned = payload.whats_new.strip()
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
    if apk.app.owner_id != user.id and user.role != UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")

    storage = get_storage()
    try:
        await storage.delete(apk.storage_key)
    except Exception as exc:  # noqa: BLE001
        log.warning("storage delete failed", key=apk.storage_key, error=str(exc))
    await db.delete(apk)
    await db.flush()
    await enqueue_reindex()
