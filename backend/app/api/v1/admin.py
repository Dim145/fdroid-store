from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from sqlalchemy import desc, func, select
from sqlalchemy.orm import aliased, selectinload

from app.api.deps import DbSession, get_current_admin
from app.core.security import hash_password
from app.core.uploads import normalize_image, read_capped
from app.models.api_key import ApiKey
from app.models.apk import Apk, ApkStatus
from app.models.app import App, AppStatus, Category
from app.models.audit import DownloadEvent
from app.models.invite_code import InviteCode
from app.models.package_signer import PackageSignerPin
from app.models.repo_config import RepoConfig
from app.models.user import User, UserRole
from app.schemas.app import AppAdminUpdate, AppRead
from app.schemas.invite import InviteCodeCreate, InviteCodeRead
from app.schemas.repo import RepoConfigRead, RepoConfigUpdate
from app.schemas.user import AdminUserCreate, AdminUserUpdate, UserRead
from app.services.queue import enqueue_reindex
from app.storage import get_storage

router = APIRouter()


# --------------------------------------------------------------------------
# Users
# --------------------------------------------------------------------------
@router.get("/users", response_model=list[UserRead])
async def list_users(
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
    q: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[UserRead]:
    stmt = select(User).order_by(User.created_at.desc())
    if q:
        like = f"%{q}%"
        stmt = stmt.where((User.email.ilike(like)) | (User.username.ilike(like)))
    rows = (await db.execute(stmt.limit(min(limit, 500)).offset(offset))).scalars().all()
    return [UserRead.model_validate(u) for u in rows]


@router.post("/users", response_model=UserRead, status_code=status.HTTP_201_CREATED)
async def create_user(
    payload: AdminUserCreate,
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> UserRead:
    existing = (
        await db.execute(
            select(User).where((User.email == payload.email) | (User.username == payload.username))
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email or username already exists")
    user = User(
        email=payload.email,
        username=payload.username,
        full_name=payload.full_name,
        hashed_password=hash_password(payload.password),
        role=payload.role,
        is_active=True,
    )
    db.add(user)
    await db.flush()
    return UserRead.model_validate(user)


async def _would_orphan_admins(db, target: User, *, removing_admin: bool, disabling: bool) -> bool:
    """Return True if applying the change leaves zero active admins."""
    if target.role != UserRole.ADMIN:
        return False
    if not (removing_admin or disabling):
        return False
    other_active_admins = (
        await db.execute(
            select(func.count(User.id)).where(
                User.id != target.id,
                User.role == UserRole.ADMIN,
                User.is_active.is_(True),
            )
        )
    ).scalar_one()
    return other_active_admins == 0


@router.patch("/users/{user_id}", response_model=UserRead)
async def update_user(
    user_id: uuid.UUID,
    payload: AdminUserUpdate,
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> UserRead:
    target = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    # Refuse the change if it would leave the repo with zero active admins
    # — there's no in-app recovery from that state (CWE-840).
    if await _would_orphan_admins(
        db,
        target,
        removing_admin=(payload.role is not None and payload.role != UserRole.ADMIN),
        disabling=(payload.is_active is False),
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Refusing change: this would leave the repo without an active admin",
        )

    if payload.full_name is not None:
        target.full_name = payload.full_name
    if payload.role is not None:
        target.role = payload.role
    if payload.is_active is not None:
        target.is_active = payload.is_active
    if payload.new_password:
        target.hashed_password = hash_password(payload.new_password)
        # Bump password_changed_at so every outstanding access / refresh
        # token for this user is immediately invalidated by the JWT
        # decoder (C5) + revoke their persisted refresh-token rows (C6).
        target.password_changed_at = datetime.now(UTC)
        from app.services.auth_service import revoke_all_refresh_tokens

        await revoke_all_refresh_tokens(db, target.id)
    # If an admin disables a user, kill their sessions too — otherwise the
    # JWT they're holding keeps working until expiry.
    if payload.is_active is False:
        from app.services.auth_service import revoke_all_refresh_tokens

        await revoke_all_refresh_tokens(db, target.id)
        target.password_changed_at = datetime.now(UTC)
    await db.flush()
    return UserRead.model_validate(target)


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None, response_class=Response)
async def delete_user(
    user_id: uuid.UUID,
    db: DbSession,
    admin: Annotated[User, Depends(get_current_admin)],
) -> None:
    if user_id == admin.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete yourself")
    target = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if await _would_orphan_admins(db, target, removing_admin=True, disabling=True):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Refusing delete: this would leave the repo without an active admin",
        )
    await db.delete(target)
    await db.flush()


# --------------------------------------------------------------------------
# Apps moderation
# --------------------------------------------------------------------------
@router.get("/apps", response_model=list[AppRead])
async def admin_list_apps(
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
    status_filter: str | None = Query(default=None, max_length=32),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[AppRead]:
    stmt = (
        select(App)
        .options(selectinload(App.categories), selectinload(App.apks))
        .order_by(App.created_at.desc())
    )
    if status_filter:
        stmt = stmt.where(App.status == status_filter)
    rows = (await db.execute(stmt.limit(min(limit, 500)).offset(offset))).scalars().unique().all()
    return [AppRead.model_validate(a) for a in rows]


@router.patch("/apps/{app_id}", response_model=AppRead)
async def admin_update_app(
    app_id: uuid.UUID,
    payload: AppAdminUpdate,
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> AppRead:
    app = (
        await db.execute(
            select(App)
            .options(selectinload(App.categories), selectinload(App.apks))
            .where(App.id == app_id)
        )
    ).scalar_one_or_none()
    if app is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App not found")

    # Apply user-facing fields
    for f in (
        "name", "summary", "description", "license",
        "author_name", "author_email",
        "donate", "liberapay", "bitcoin", "open_collective", "translation",
    ):
        v = getattr(payload, f)
        if v is not None:
            setattr(app, f, v)
    if payload.visibility is not None:
        app.visibility = payload.visibility
    if payload.website is not None:
        app.website = str(payload.website)
    if payload.source_code is not None:
        app.source_code = str(payload.source_code)
    if payload.issue_tracker is not None:
        app.issue_tracker = str(payload.issue_tracker)
    if payload.status is not None:
        app.status = payload.status
        if payload.status == AppStatus.PUBLISHED:
            app.last_published_at = datetime.now(UTC)
    if payload.category_ids is not None:
        cats = list(
            (
                await db.execute(select(Category).where(Category.id.in_(payload.category_ids)))
            ).scalars().all()
        )
        app.categories = cats
    await db.flush()
    await enqueue_reindex()
    return AppRead.model_validate(app)


# --------------------------------------------------------------------------
# APK moderation
# --------------------------------------------------------------------------
@router.post("/apks/{apk_id}/publish", response_model=dict)
async def admin_publish_apk(
    apk_id: uuid.UUID,
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> dict:
    apk = (
        await db.execute(
            select(Apk).options(selectinload(Apk.app)).where(Apk.id == apk_id)
        )
    ).scalar_one_or_none()
    if apk is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="APK not found")
    apk.status = ApkStatus.PUBLISHED
    apk.published_at = datetime.now(UTC)
    apk.app.status = AppStatus.PUBLISHED
    if apk.app.locked_signer_sha256 is None:
        apk.app.locked_signer_sha256 = apk.signer_sha256
    # Lock the signer in the cross-App pin table too (C1).
    pin = (
        await db.execute(
            select(PackageSignerPin).where(PackageSignerPin.package_name == apk.app.package_name)
        )
    ).scalar_one_or_none()
    if pin is None:
        db.add(
            PackageSignerPin(
                package_name=apk.app.package_name,
                signer_sha256=apk.signer_sha256,
                locked_by_app_id=apk.app.id,
                first_locked_at=datetime.now(UTC),
            )
        )
    apk.app.suggested_version_code = max(
        apk.app.suggested_version_code or 0, apk.version_code
    )
    apk.app.suggested_version_name = apk.version_name
    apk.app.last_published_at = datetime.now(UTC)
    await db.flush()
    await enqueue_reindex()
    return {"status": "published"}


@router.post("/apks/{apk_id}/reject", response_model=dict)
async def admin_reject_apk(
    apk_id: uuid.UUID,
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
    reason: str = "Rejected by administrator",
) -> dict:
    apk = (await db.execute(select(Apk).where(Apk.id == apk_id))).scalar_one_or_none()
    if apk is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="APK not found")
    apk.status = ApkStatus.REJECTED
    apk.rejection_reason = reason
    await db.flush()
    return {"status": "rejected"}


@router.delete("/apks/{apk_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None, response_class=Response)
async def admin_delete_apk(
    apk_id: uuid.UUID,
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> None:
    apk = (await db.execute(select(Apk).where(Apk.id == apk_id))).scalar_one_or_none()
    if apk is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="APK not found")
    storage = get_storage()
    try:
        await storage.delete(apk.storage_key)
    except Exception:  # noqa: BLE001
        pass
    await db.delete(apk)
    await db.flush()
    await enqueue_reindex()


# --------------------------------------------------------------------------
# Repo config + reindex
# --------------------------------------------------------------------------
@router.get("/repo", response_model=RepoConfigRead)
async def get_repo_config(
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> RepoConfigRead:
    config = (await db.execute(select(RepoConfig).limit(1))).scalar_one()
    return RepoConfigRead.model_validate(config)


@router.patch("/repo", response_model=RepoConfigRead)
async def update_repo_config(
    payload: RepoConfigUpdate,
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> RepoConfigRead:
    import json as _json
    config = (await db.execute(select(RepoConfig).limit(1))).scalar_one()
    repo_index_dirty = False
    if payload.name is not None:
        config.name = payload.name
        repo_index_dirty = True
    if payload.description is not None:
        config.description = payload.description
        repo_index_dirty = True
    if payload.address is not None:
        config.address = str(payload.address).rstrip("/")
        repo_index_dirty = True
    if payload.mirrors is not None:
        config.mirrors_json = _json.dumps([str(m) for m in payload.mirrors])
        repo_index_dirty = True
    if payload.public_mode is not None:
        config.public_mode = payload.public_mode
    if payload.registration_policy is not None:
        config.registration_policy = payload.registration_policy
    if payload.upload_max_apk_mb is not None:
        config.upload_max_apk_mb = payload.upload_max_apk_mb
    await db.flush()
    # Only re-render the index when something baked into the JSON actually
    # changed — toggling registration policy doesn't move any bytes.
    if repo_index_dirty:
        await enqueue_reindex()
    return RepoConfigRead.model_validate(config)


@router.post("/repo/reindex", response_model=dict)
async def trigger_reindex(
    _: Annotated[User, Depends(get_current_admin)],
) -> dict:
    await enqueue_reindex()
    return {"queued": True}


@router.post("/apks/rescan", response_model=dict)
async def rescan_all_apks(
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> dict:
    """Re-parse every stored APK and refresh extracted metadata + icons.

    Useful after a parser bugfix. For each app, the icon is also
    re-extracted from the latest published APK — unless the app already
    has a custom icon, which is preserved.
    """
    from app.services.rescan_service import rescan_all_apps

    result = await rescan_all_apps(db)
    await enqueue_reindex()
    return {
        "rescanned_apks": result.rescanned_apks,
        "icons_refreshed": result.icons_refreshed,
        "failed": result.failed,
    }


@router.post("/apps/{app_id}/rescan", response_model=dict)
async def rescan_one_app(
    app_id: uuid.UUID,
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> dict:
    """Rescan one app's APKs and refresh its icon. Same semantics as the
    global rescan but limited to a single app — used by the admin UI's
    per-row button."""
    from app.services.rescan_service import rescan_app

    target = (
        await db.execute(
            select(App).options(selectinload(App.apks)).where(App.id == app_id)
        )
    ).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App not found")

    result = await rescan_app(db, target)
    await enqueue_reindex()
    return {
        "rescanned_apks": result.rescanned_apks,
        "icons_refreshed": result.icons_refreshed,
        "failed": result.failed,
    }


@router.post("/repo/icon", response_model=RepoConfigRead)
async def upload_repo_icon(
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
    file: UploadFile = File(...),
) -> RepoConfigRead:
    """Upload a custom repo icon. PNG output, max 512×512."""
    raw = await read_capped(file, 4 * 1024 * 1024)
    if not raw:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")
    png = await normalize_image(raw, (512, 512))

    storage = get_storage()
    ts = int(datetime.now(UTC).timestamp())
    key = f"icons/repo-icon-{ts}.png"
    await storage.put(key, png, content_type="image/png")

    config = (await db.execute(select(RepoConfig).limit(1))).scalar_one()
    config.icon_path = key
    await db.flush()
    await enqueue_reindex()
    return RepoConfigRead.model_validate(config)


# --------------------------------------------------------------------------
# Stats
# --------------------------------------------------------------------------
@router.get("/stats", response_model=dict)
async def admin_stats(
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> dict:
    total_users = (await db.execute(select(func.count(User.id)))).scalar_one()
    total_apps = (await db.execute(select(func.count(App.id)))).scalar_one()
    published_apps = (
        await db.execute(select(func.count(App.id)).where(App.status == AppStatus.PUBLISHED))
    ).scalar_one()
    pending_apks = (
        await db.execute(select(func.count(Apk.id)).where(Apk.status == ApkStatus.PENDING_REVIEW))
    ).scalar_one()
    total_downloads = (
        await db.execute(select(func.count(DownloadEvent.id)))
    ).scalar_one()
    total_api_keys = (await db.execute(select(func.count(ApiKey.id)))).scalar_one()

    # Join with App + User so the admin UI can render names instead of UUIDs.
    # Both joins are left-outer because anon downloads and deleted apps/users
    # still belong in the history.
    recent_downloads = (
        await db.execute(
            select(DownloadEvent, App.name, User.username)
            .join(App, DownloadEvent.app_id == App.id, isouter=True)
            .join(User, DownloadEvent.user_id == User.id, isouter=True)
            .order_by(desc(DownloadEvent.created_at))
            .limit(20)
        )
    ).all()

    return {
        "total_users": total_users,
        "total_apps": total_apps,
        "published_apps": published_apps,
        "pending_apks": pending_apks,
        "total_downloads": total_downloads,
        "total_api_keys": total_api_keys,
        "recent_downloads": [
            {
                "id": str(ev.id),
                "apk_id": str(ev.apk_id),
                "app_id": str(ev.app_id),
                "app_name": app_name,
                "user_id": str(ev.user_id) if ev.user_id else None,
                "username": username,
                "created_at": ev.created_at.isoformat(),
            }
            for ev, app_name, username in recent_downloads
        ],
    }


# --------------------------------------------------------------------------
# Invite codes (used when registration_policy = "invite")
# --------------------------------------------------------------------------
def _generate_invite_code() -> str:
    # 16 chars from token_urlsafe -> ~96 bits of entropy. Plenty for a
    # human-shareable single-use code, still short enough to read aloud.
    return secrets.token_urlsafe(12)[:16]


async def _serialize_invite(db, invite: InviteCode) -> InviteCodeRead:
    """Hydrate with the creator/consumer usernames so the admin UI doesn't
    need a per-row /users round-trip."""
    creator_name: str | None = None
    consumer_name: str | None = None
    if invite.created_by_user_id is not None:
        creator_name = (
            await db.execute(
                select(User.username).where(User.id == invite.created_by_user_id)
            )
        ).scalar_one_or_none()
    if invite.used_by_user_id is not None:
        consumer_name = (
            await db.execute(
                select(User.username).where(User.id == invite.used_by_user_id)
            )
        ).scalar_one_or_none()
    return InviteCodeRead(
        id=invite.id,
        code=invite.code,
        note=invite.note,
        created_at=invite.created_at,
        expires_at=invite.expires_at,
        used_at=invite.used_at,
        created_by_username=creator_name,
        used_by_username=consumer_name,
    )


@router.get("/invites", response_model=list[InviteCodeRead])
async def list_invite_codes(
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> list[InviteCodeRead]:
    """Newest first. Includes both pending and consumed codes — the admin
    can see audit history at a glance."""
    creator = aliased(User)
    consumer = aliased(User)
    rows = (
        await db.execute(
            select(InviteCode, creator.username, consumer.username)
            .join(creator, InviteCode.created_by_user_id == creator.id, isouter=True)
            .join(consumer, InviteCode.used_by_user_id == consumer.id, isouter=True)
            .order_by(desc(InviteCode.created_at))
        )
    ).all()
    return [
        InviteCodeRead(
            id=inv.id,
            code=inv.code,
            note=inv.note,
            created_at=inv.created_at,
            expires_at=inv.expires_at,
            used_at=inv.used_at,
            created_by_username=cname,
            used_by_username=uname,
        )
        for inv, cname, uname in rows
    ]


@router.post("/invites", response_model=InviteCodeRead, status_code=status.HTTP_201_CREATED)
async def create_invite_code(
    payload: InviteCodeCreate,
    db: DbSession,
    admin: Annotated[User, Depends(get_current_admin)],
) -> InviteCodeRead:
    # Collisions are statistically impossible at 96 bits, but treating the
    # unique constraint as authoritative beats hand-rolling a "retry on
    # IntegrityError" loop in 99.9999% no-op territory.
    invite = InviteCode(
        code=_generate_invite_code(),
        note=payload.note,
        created_by_user_id=admin.id,
        expires_at=(
            datetime.now(UTC) + timedelta(days=payload.expires_in_days)
            if payload.expires_in_days
            else None
        ),
    )
    db.add(invite)
    await db.flush()
    return await _serialize_invite(db, invite)


@router.delete("/invites/{invite_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None, response_class=Response)
async def revoke_invite_code(
    invite_id: uuid.UUID,
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> None:
    invite = (
        await db.execute(select(InviteCode).where(InviteCode.id == invite_id))
    ).scalar_one_or_none()
    if invite is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found")
    await db.delete(invite)
    await db.flush()
