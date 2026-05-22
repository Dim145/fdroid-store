"""Public-or-auth stats endpoint.

Returns aggregate "health of the repo" counters: total apps + users +
downloads, top apps by lifetime download count, downloads-per-day for
the last 30 days, and a category breakdown.

Visibility is layered:

* The endpoint is reachable anonymously only when BOTH
  ``RepoConfig.public_stats`` AND ``RepoConfig.public_mode`` are
  True. A private repo (``public_mode = False``) keeps /stats
  authenticated regardless of ``public_stats`` — leaking aggregate
  download counts of a private catalogue would itself be a leak.

* Private apps are ALWAYS excluded from public payloads. The "total
  apps" counter, the top list, and the category breakdown all run on
  ``visibility = 'public'`` only. An authenticated admin gets the
  full picture; everyone else (anonymous when ``public_stats`` is on,
  plain authenticated callers) gets the public-only view.

The endpoint is deliberately cheap: a handful of aggregate queries,
no joins outside the top-apps lookup. Safe to hit on every page
visit.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import DbSession, get_current_user_optional
from app.models.apk import Apk, ApkStatus
from app.models.app import App, AppVisibility, Category, app_categories_table
from app.models.audit import DownloadEvent
from app.models.repo_config import RepoConfig
from app.models.user import User, UserRole

router = APIRouter()


async def _ensure_visibility(db: AsyncSession, viewer: User | None) -> RepoConfig:
    """Resolve the access policy and return the loaded RepoConfig.

    Two modes for ``public_stats``:

      * ``True`` (public mode) — the page is visible to everyone. The
        only hard gate is the global ``public_mode``: when the repo
        itself is in private mode, anonymous callers are still
        refused (so a private repo never leaks aggregates). Every
        authenticated role — including plain ``user`` accounts — sees
        the public view.

      * ``False`` (private mode) — admins only. Anonymous → 401, every
        non-admin authenticated user → 403. Used when an operator
        wants to keep the figures internal.
    """
    config = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
    if config is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Repo not yet initialised",
        )
    if config.public_stats:
        # Public — anonymous OK only when the repo itself is public.
        if viewer is None and not config.public_mode:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication required",
            )
    else:
        # Private — admins only.
        if viewer is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication required",
            )
        if viewer.role != UserRole.ADMIN:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Stats are restricted to administrators",
            )
    return config


@router.get("")
async def get_stats(
    db: DbSession,
    viewer: Annotated[User | None, Depends(get_current_user_optional)],
) -> dict:
    config = await _ensure_visibility(db, viewer)
    # Admins see private apps in the counters; everyone else sees the
    # public-only view. The toggle on ``include_private`` flips the
    # WHERE clause in one place rather than peppering it through every
    # query.
    include_private = viewer is not None and viewer.role == UserRole.ADMIN
    if include_private:
        app_filter = App.id.is_not(None)
    else:
        app_filter = App.visibility == AppVisibility.PUBLIC

    # --- totals ---------------------------------------------------------
    total_apps = (
        await db.execute(select(func.count(App.id)).where(app_filter))
    ).scalar_one()
    # ``published`` APK count tracks apps actually live in the F-Droid
    # index — drafts and rejected don't show.
    total_apks = (
        await db.execute(
            select(func.count(Apk.id))
            .join(App, App.id == Apk.app_id)
            .where(Apk.status == ApkStatus.PUBLISHED, app_filter)
        )
    ).scalar_one()
    total_downloads = (
        await db.execute(
            select(func.count(DownloadEvent.id))
            .join(App, App.id == DownloadEvent.app_id)
            .where(app_filter)
        )
    ).scalar_one()
    # Repo storage: sum of every published APK's filesize. Mirrors what
    # the operator pays for at the storage backend.
    total_bytes = (
        await db.execute(
            select(func.coalesce(func.sum(Apk.size_bytes), 0))
            .join(App, App.id == Apk.app_id)
            .where(Apk.status == ApkStatus.PUBLISHED, app_filter)
        )
    ).scalar_one()
    # Only count active users. Disabled accounts shouldn't pad the chart.
    total_users = (
        await db.execute(select(func.count(User.id)).where(User.is_active.is_(True)))
    ).scalar_one()

    # --- top apps -------------------------------------------------------
    top_rows = (
        await db.execute(
            select(
                App.id,
                App.package_name,
                App.name,
                App.icon_path,
                App.updated_at,
                func.count(DownloadEvent.id).label("dl"),
            )
            .outerjoin(DownloadEvent, DownloadEvent.app_id == App.id)
            .where(app_filter)
            .group_by(App.id)
            .order_by(func.count(DownloadEvent.id).desc())
            .limit(10)
        )
    ).all()
    top_apps = [
        {
            "id": str(r.id),
            "package_name": r.package_name,
            "name": r.name,
            "icon_path": r.icon_path,
            "updated_at": (
                r.updated_at.isoformat().replace("+00:00", "Z") if r.updated_at else None
            ),
            "download_count": int(r.dl or 0),
        }
        for r in top_rows
    ]

    # --- downloads per day, last 30 days --------------------------------
    # ``date_trunc('day', ...)`` is PG-specific. We feed the resulting
    # bucket back to the frontend as an ISO date string ``YYYY-MM-DD``.
    since = datetime.now(UTC) - timedelta(days=30)
    day_rows = (
        await db.execute(
            select(
                func.date_trunc("day", DownloadEvent.created_at).label("bucket"),
                func.count(DownloadEvent.id).label("dl"),
            )
            .join(App, App.id == DownloadEvent.app_id)
            .where(DownloadEvent.created_at >= since, app_filter)
            .group_by("bucket")
            .order_by("bucket")
        )
    ).all()
    downloads_by_day = [
        {"date": r.bucket.date().isoformat(), "count": int(r.dl or 0)}
        for r in day_rows
    ]

    # --- category breakdown ---------------------------------------------
    cat_rows = (
        await db.execute(
            select(
                Category.id,
                Category.name,
                func.count(App.id).label("apps"),
            )
            .outerjoin(app_categories_table, app_categories_table.c.category_id == Category.id)
            .outerjoin(
                App,
                (App.id == app_categories_table.c.app_id) & app_filter,
            )
            .group_by(Category.id)
            .order_by(func.count(App.id).desc())
        )
    ).all()
    categories = [
        {"id": str(r.id), "name": r.name, "app_count": int(r.apps or 0)}
        for r in cat_rows
    ]

    return {
        "totals": {
            "apps": int(total_apps),
            "apks_published": int(total_apks),
            "downloads": int(total_downloads),
            "bytes_published": int(total_bytes),
            "active_users": int(total_users),
        },
        "top_apps": top_apps,
        "downloads_by_day": downloads_by_day,
        "categories": categories,
        # Tell the frontend which view it received, so it can label the
        # page ("Public stats" vs "Admin stats — includes private apps").
        "scope": "admin" if include_private else "public",
        "public_stats_enabled": config.public_stats,
    }
