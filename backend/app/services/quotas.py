"""Per-user quota checks.

Three dimensions:
  * ``max_apps`` — total number of App rows owned by the user.
  * ``max_storage_bytes`` — sum of ``Apk.size_bytes`` across the user's apps.
  * ``max_apks_per_month`` — APK rows whose ``created_at`` falls in the
    current calendar month (UTC, rolling on the 1st 00:00).

Each user row carries optional overrides (``User.quota_*``). When NULL we
fall back to the repo-wide defaults on ``RepoConfig.default_quota_*``. When
both are NULL the quota is unlimited.

Admins bypass every check — quotas are about constraining ordinary users,
not the operator.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.apk import Apk
from app.models.app import App
from app.models.repo_config import RepoConfig
from app.models.user import User, UserRole


def _effective(user_value: int | None, default_value: int | None) -> int | None:
    """User-override wins. ``None`` at both levels = unlimited."""
    return user_value if user_value is not None else default_value


async def _load_config(db: AsyncSession) -> RepoConfig | None:
    return (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()


async def _lock_quota_subject(db: AsyncSession, user_id) -> None:
    """Acquire a per-owner advisory lock for the lifetime of the current
    transaction. Two concurrent uploads from the same owner serialise
    here so the SUM/COUNT under the cap reflect each other — without
    this, both reads run before either commit and the cap is bypassed
    proportionally to the parallelism (CWE-367).

    We use a Postgres advisory lock keyed on a stable hash of the user
    UUID rather than ``SELECT FOR UPDATE`` on the ``users`` row so that
    unrelated user-row updates (e.g. ``preferred_locale``) don't block
    on upload progress.
    """
    from sqlalchemy import text

    # ``pg_advisory_xact_lock`` releases automatically when the
    # transaction commits or rolls back. ``hashtext`` produces an
    # int4 from any string — UUID stringification is stable.
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
        {"k": f"quota:{user_id}"},
    )


async def ensure_can_create_app(db: AsyncSession, user: User) -> None:
    """Refuse with 403 when the user has hit ``max_apps``."""
    if user.role == UserRole.ADMIN:
        return
    config = await _load_config(db)
    cap = _effective(
        user.quota_max_apps,
        config.default_quota_max_apps if config else None,
    )
    if cap is None:
        return
    # Serialise quota checks for this owner so N parallel creates
    # can't all observe the same pre-commit COUNT and overshoot.
    await _lock_quota_subject(db, user.id)
    owned = (
        await db.execute(
            select(func.count(App.id)).where(App.owner_id == user.id)
        )
    ).scalar_one()
    if owned >= cap:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"App quota reached ({owned}/{cap}). Ask an admin to raise it.",
        )


async def ensure_can_upload_apk(
    db: AsyncSession,
    user: User,
    *,
    incoming_size_bytes: int,
) -> None:
    """Refuse with 403 when the upload would exceed storage or monthly cap."""
    if user.role == UserRole.ADMIN:
        return
    config = await _load_config(db)
    # Same TOCTOU defence as ensure_can_create_app — parallel uploads
    # from the same owner would otherwise each read the pre-upload
    # totals and all pass the cap.
    await _lock_quota_subject(db, user.id)

    storage_cap = _effective(
        user.quota_max_storage_bytes,
        config.default_quota_max_storage_bytes if config else None,
    )
    monthly_cap = _effective(
        user.quota_max_apks_per_month,
        config.default_quota_max_apks_per_month if config else None,
    )

    if storage_cap is not None:
        # SUM joins through App because Apk doesn't carry the owner directly.
        used = (
            await db.execute(
                select(func.coalesce(func.sum(Apk.size_bytes), 0))
                .join(App, App.id == Apk.app_id)
                .where(App.owner_id == user.id)
            )
        ).scalar_one()
        if used + incoming_size_bytes > storage_cap:
            mb_used = used // (1024 * 1024)
            mb_cap = storage_cap // (1024 * 1024)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    f"Storage quota exceeded ({mb_used} MiB used of {mb_cap} MiB). "
                    "Delete an old version or ask an admin to raise the limit."
                ),
            )

    if monthly_cap is not None:
        # "This calendar month" — start at the first of the current UTC
        # month. Using a calendar boundary (not a 30-day rolling window)
        # matches what users see in their billing-like mental model.
        now = datetime.now(UTC)
        month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        count = (
            await db.execute(
                select(func.count(Apk.id))
                .join(App, App.id == Apk.app_id)
                .where(App.owner_id == user.id, Apk.created_at >= month_start)
            )
        ).scalar_one()
        if count >= monthly_cap:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    f"Monthly upload quota reached ({count}/{monthly_cap}). "
                    "Wait until the 1st of next month or ask an admin to raise it."
                ),
            )


async def usage_summary(db: AsyncSession, user: User) -> dict:
    """Compact JSON for the account page: usage + cap per dimension.

    ``cap == None`` is rendered client-side as the infinity glyph.
    """
    config = await _load_config(db)
    apps_cap = _effective(
        user.quota_max_apps,
        config.default_quota_max_apps if config else None,
    )
    storage_cap = _effective(
        user.quota_max_storage_bytes,
        config.default_quota_max_storage_bytes if config else None,
    )
    monthly_cap = _effective(
        user.quota_max_apks_per_month,
        config.default_quota_max_apks_per_month if config else None,
    )

    apps_used = (
        await db.execute(select(func.count(App.id)).where(App.owner_id == user.id))
    ).scalar_one()
    storage_used = (
        await db.execute(
            select(func.coalesce(func.sum(Apk.size_bytes), 0))
            .join(App, App.id == Apk.app_id)
            .where(App.owner_id == user.id)
        )
    ).scalar_one()
    now = datetime.now(UTC)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    monthly_used = (
        await db.execute(
            select(func.count(Apk.id))
            .join(App, App.id == Apk.app_id)
            .where(App.owner_id == user.id, Apk.created_at >= month_start)
        )
    ).scalar_one()

    return {
        "apps": {"used": apps_used, "cap": apps_cap},
        "storage_bytes": {"used": int(storage_used), "cap": storage_cap},
        "apks_this_month": {"used": monthly_used, "cap": monthly_cap},
    }
