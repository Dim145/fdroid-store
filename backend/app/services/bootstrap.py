"""First-run bootstrapping: seed admin user, default categories, repo config row.

Called from the FastAPI lifespan on every boot. All operations are idempotent.
"""
from __future__ import annotations

from sqlalchemy import func, select

from app.core.config import settings
from app.core.database import Base, SessionLocal, engine
from app.core.logging import get_logger
from app.core.security import hash_password
from app.models import (  # noqa: F401 — ensure all models register with Base.metadata
    Apk,
    ApiKey,
    App,
    AppCategory,
    Category,
    DownloadEvent,
    Localization,
    RepoConfig,
    User,
)
from app.models.user import AuthProvider, UserRole

log = get_logger(__name__)


async def _create_tables_if_needed() -> None:
    """For dev/first-run convenience, create any missing tables.

    In production you should run ``alembic upgrade head`` instead; this is
    safe to leave on because it never drops or alters existing tables.
    """
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


# Mirrors F-Droid's default category list (subset, can be edited by admin)
DEFAULT_CATEGORIES = [
    "Connectivity",
    "Development",
    "Games",
    "Graphics",
    "Internet",
    "Money",
    "Multimedia",
    "Navigation",
    "Phone & SMS",
    "Reading",
    "Science & Education",
    "Security",
    "Sports & Health",
    "System",
    "Theming",
    "Time",
    "Writing",
    "Misc",
]


async def bootstrap_first_run() -> None:
    """Idempotent. Safe under concurrent workers — each seed step has its own
    transaction so a race on one row does not abort the others."""
    await _create_tables_if_needed()

    # ---- Initial admin user ------------------------------------------------
    async with SessionLocal() as db:
        try:
            users_count = (await db.execute(select(func.count(User.id)))).scalar_one()
            if users_count == 0:
                log.info("creating initial admin user", email=settings.initial_admin_email)
                db.add(
                    User(
                        email=settings.initial_admin_email,
                        username="admin",
                        full_name="Administrator",
                        hashed_password=hash_password(settings.initial_admin_password),
                        role=UserRole.ADMIN,
                        auth_provider=AuthProvider.LOCAL,
                        is_active=True,
                    )
                )
                await db.commit()
        except Exception as exc:  # noqa: BLE001
            await db.rollback()
            log.info("admin seed skipped", reason=str(exc))

    # ---- Default categories -- one-at-a-time so collisions don't poison the rest
    for cat in DEFAULT_CATEGORIES:
        async with SessionLocal() as db:
            try:
                exists = (
                    await db.execute(select(Category.id).where(Category.name == cat))
                ).scalar_one_or_none()
                if exists is None:
                    db.add(Category(name=cat))
                    await db.commit()
            except Exception:  # noqa: BLE001
                await db.rollback()

    # ---- Single-row repo config -------------------------------------------
    async with SessionLocal() as db:
        try:
            repo = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
            if repo is None:
                log.info("seeding repo config row")
                db.add(
                    RepoConfig(
                        name=settings.repo_name,
                        description=settings.repo_description,
                        icon_path=settings.repo_icon,
                        address=settings.public_repo_url,
                        setup_complete=False,
                    )
                )
                await db.commit()
        except Exception as exc:  # noqa: BLE001
            await db.rollback()
            log.info("repo config seed skipped", reason=str(exc))
