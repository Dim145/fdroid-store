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
from app.fdroid.apk_parser import ApkParseError, parse_apk
from app.models.apk import Apk, ApkStatus
from app.models.app import App, AppStatus
from app.models.user import User, UserRole
from app.schemas.app import ApkRead
from app.services.queue import enqueue_reindex
from app.storage import get_storage

router = APIRouter()
log = get_logger(__name__)


@router.post("/upload/{app_id}", response_model=ApkRead, status_code=status.HTTP_201_CREATED)
async def upload_apk(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
    file: UploadFile = File(...),
) -> ApkRead:
    """Upload a new APK for an app.

    The file is parsed inline (small overhead) so we can return a useful error
    immediately. Reindex is queued to the worker.
    """
    if not file.filename or not file.filename.lower().endswith(".apk"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Expected an .apk file")

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

    # ---- Persist upload to a temp file so we can parse it -----------------
    with tempfile.NamedTemporaryFile(suffix=".apk", delete=False) as tmp:
        tmp_path = Path(tmp.name)
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            tmp.write(chunk)

    try:
        try:
            meta = await parse_apk(tmp_path)
        except ApkParseError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid APK: {exc}",
            ) from exc

        if meta.package_name != app.package_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"APK package {meta.package_name!r} does not match app "
                    f"{app.package_name!r}"
                ),
            )

        # Lock signer on first publish; reject mismatches afterwards
        if app.locked_signer_sha256 and app.locked_signer_sha256 != meta.signer_sha256:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="APK signer does not match the signer of previously published APKs",
            )

        # Reject duplicates by content hash
        dup = (
            await db.execute(select(Apk).where(Apk.sha256 == meta.sha256))
        ).scalar_one_or_none()
        if dup is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"This APK is already uploaded (id={dup.id})",
            )

        # Reject duplicate versionCode for the same app
        if any(a.version_code == meta.version_code for a in app.apks):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"versionCode {meta.version_code} already exists for this app",
            )

        # ---- Push to storage ----------------------------------------------
        storage = get_storage()
        target_name = f"{app.package_name}_{meta.version_code}.apk"
        storage_key = f"apks/{app.package_name}/{target_name}"
        with tmp_path.open("rb") as fh:
            await storage.put(storage_key, fh, content_type="application/vnd.android.package-archive")

        # Optional: persist the embedded icon for the index
        if meta.icon_data and meta.icon_extension and app.icon_path is None:
            icon_key = f"icons/{app.package_name}.{meta.version_code}.{meta.icon_extension}"
            await storage.put(icon_key, meta.icon_data, content_type=f"image/{meta.icon_extension}")
            app.icon_path = icon_key

        # ---- DB row -------------------------------------------------------
        is_admin_or_owner_admin = user.role == UserRole.ADMIN
        # Admin uploads auto-publish; regular user uploads await review.
        initial_status = ApkStatus.PUBLISHED if is_admin_or_owner_admin else ApkStatus.PENDING_REVIEW
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
            uploaded_by_id=user.id,
            published_at=datetime.now(UTC) if initial_status == ApkStatus.PUBLISHED else None,
        )
        db.add(apk)

        if initial_status == ApkStatus.PUBLISHED:
            if app.locked_signer_sha256 is None:
                app.locked_signer_sha256 = meta.signer_sha256
            app.suggested_version_code = meta.version_code
            app.suggested_version_name = meta.version_name
            app.status = AppStatus.PUBLISHED
            app.last_published_at = datetime.now(UTC)

        await db.flush()
        log.info(
            "apk uploaded",
            apk_id=str(apk.id),
            app=app.package_name,
            version_code=apk.version_code,
            status=apk.status.value,
        )

        if initial_status == ApkStatus.PUBLISHED:
            await enqueue_reindex()

        return ApkRead.model_validate(apk)
    finally:
        tmp_path.unlink(missing_ok=True)


@router.delete("/{apk_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None, response_class=Response)
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
