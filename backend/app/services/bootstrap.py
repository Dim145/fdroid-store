"""First-run bootstrapping: seed admin user, default categories, repo config row.

Called from the FastAPI lifespan on every boot. All operations are idempotent.
"""
from __future__ import annotations

from sqlalchemy import func, select

from app.core.config import settings
from app.core.database import Base, SessionLocal, engine
from app.core.logging import get_logger
from app.core.security import hash_password
from app.fdroid.default_icon import generate_default_repo_icon
from app.models import (  # noqa: F401 — ensure all models register with Base.metadata
    Apk,
    ApiKey,
    App,
    AppCategory,
    Category,
    DownloadEvent,
    InviteCode,
    Localization,
    PackageSignerPin,
    RefreshToken,
    RepoConfig,
    User,
)
from app.models.user import AuthProvider, UserRole
from app.storage import get_storage

log = get_logger(__name__)

DEFAULT_REPO_ICON_KEY = "icons/fdroid-icon.png"


async def _create_tables_if_needed() -> None:
    """For dev/first-run convenience, create any missing tables.

    In production you should run ``alembic upgrade head`` instead; this is
    safe to leave on because it never drops or alters existing tables.
    """
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Idempotent column additions for upgrades that don't justify a full
        # migration yet. Each statement is its own savepoint so a partial
        # failure (e.g. column already exists on a different type) does not
        # poison the others.
        from sqlalchemy import text
        for stmt in (
            "ALTER TABLE apps ADD COLUMN IF NOT EXISTS icon_is_custom BOOLEAN NOT NULL DEFAULT FALSE",
            "ALTER TABLE apks ADD COLUMN IF NOT EXISTS whats_new TEXT",
            "ALTER TABLE repo_config ADD COLUMN IF NOT EXISTS public_mode BOOLEAN NOT NULL DEFAULT TRUE",
            "ALTER TABLE repo_config ADD COLUMN IF NOT EXISTS registration_policy VARCHAR(16) NOT NULL DEFAULT 'public'",
            "ALTER TABLE apps ADD COLUMN IF NOT EXISTS donate VARCHAR(512)",
            "ALTER TABLE apps ADD COLUMN IF NOT EXISTS liberapay VARCHAR(512)",
            "ALTER TABLE apps ADD COLUMN IF NOT EXISTS bitcoin VARCHAR(512)",
            "ALTER TABLE apps ADD COLUMN IF NOT EXISTS open_collective VARCHAR(512)",
            "ALTER TABLE apps ADD COLUMN IF NOT EXISTS translation VARCHAR(512)",
            "ALTER TABLE apks ADD COLUMN IF NOT EXISTS anti_features JSON NOT NULL DEFAULT '[]'",
            "ALTER TABLE repo_config ADD COLUMN IF NOT EXISTS upload_max_apk_mb INTEGER NOT NULL DEFAULT 200",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP WITH TIME ZONE",
            "ALTER TABLE repo_config ADD COLUMN IF NOT EXISTS private_index_owner_ids TEXT NOT NULL DEFAULT '[]'",
        ):
            try:
                await conn.execute(text(stmt))
            except Exception as exc:  # noqa: BLE001
                log.info("skipping migration step", stmt=stmt, error=str(exc))


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
                        icon_path=DEFAULT_REPO_ICON_KEY,
                        address=settings.public_repo_url,
                        setup_complete=False,
                    )
                )
                await db.commit()
            elif not repo.icon_path or "/" not in repo.icon_path:
                # Older rows (or environment-seeded ones) may have just a
                # filename instead of a full storage key. Normalize.
                repo.icon_path = DEFAULT_REPO_ICON_KEY
                await db.commit()
        except Exception as exc:  # noqa: BLE001
            await db.rollback()
            log.info("repo config seed skipped", reason=str(exc))

    # ---- Default repo icon -------------------------------------------------
    try:
        storage = get_storage()
        if not await storage.exists(DEFAULT_REPO_ICON_KEY):
            log.info("seeding default repo icon", key=DEFAULT_REPO_ICON_KEY)
            await storage.put(
                DEFAULT_REPO_ICON_KEY,
                generate_default_repo_icon(),
                content_type="image/png",
            )
    except Exception as exc:  # noqa: BLE001
        log.warning("could not seed default repo icon", error=str(exc))
