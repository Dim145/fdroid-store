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
    DeployToken,
    DownloadEvent,
    GithubSource,
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
        # Backend + worker boot in parallel under docker-compose; both
        # call into here. Take a Postgres advisory lock so the
        # idempotent ALTERs (especially the ``DO $$ ALTER COLUMN
        # whats_new TYPE JSON $$`` block) never race — without this,
        # the second connection blocks on the ALTER's table lock and
        # the noisy "tuple concurrently updated" errors poison the
        # transaction. ``pg_advisory_lock`` is session-scoped so we
        # explicitly unlock after the loop.
        from sqlalchemy import text

        await conn.execute(text("SELECT pg_advisory_lock(hashtext('fdroid-store:bootstrap'))"))
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
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS show_nsfw BOOLEAN NOT NULL DEFAULT FALSE",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_locale VARCHAR(16)",
            "ALTER TABLE apps ADD COLUMN IF NOT EXISTS promo_graphic_path VARCHAR(512)",
            "ALTER TABLE apps ADD COLUMN IF NOT EXISTS tv_banner_path VARCHAR(512)",
            "ALTER TABLE apps ADD COLUMN IF NOT EXISTS suggested_version_is_manual BOOLEAN NOT NULL DEFAULT FALSE",
            # v0.14 — per-user quota overrides (NULL = fall back to repo default).
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS quota_max_apps INTEGER",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS quota_max_storage_bytes BIGINT",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS quota_max_apks_per_month INTEGER",
            # v0.14 — repo-wide default quotas (NULL = unlimited).
            "ALTER TABLE repo_config ADD COLUMN IF NOT EXISTS default_quota_max_apps INTEGER",
            "ALTER TABLE repo_config ADD COLUMN IF NOT EXISTS default_quota_max_storage_bytes BIGINT",
            "ALTER TABLE repo_config ADD COLUMN IF NOT EXISTS default_quota_max_apks_per_month INTEGER",
            # v0.14 — optional ClamAV malware scanning toggles.
            "ALTER TABLE repo_config ADD COLUMN IF NOT EXISTS clamav_scan_on_upload BOOLEAN NOT NULL DEFAULT FALSE",
            "ALTER TABLE repo_config ADD COLUMN IF NOT EXISTS clamav_scan_periodic BOOLEAN NOT NULL DEFAULT FALSE",
            # v0.14 — require 2FA for the admin role.
            "ALTER TABLE repo_config ADD COLUMN IF NOT EXISTS require_admin_2fa BOOLEAN NOT NULL DEFAULT FALSE",
            # Multi-forge release sources. SQLAlchemy's default Enum
            # mapping uses the Python *member name* (uppercase) as the
            # PG label, so we have to match here — otherwise inserts
            # crash with "invalid input value for enum".
            """
            DO $$ BEGIN
              CREATE TYPE github_provider AS ENUM ('GITHUB', 'GITLAB', 'GITEA');
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            """,
            "ALTER TABLE github_sources ADD COLUMN IF NOT EXISTS provider github_provider NOT NULL DEFAULT 'GITHUB'",
            "ALTER TABLE github_sources ADD COLUMN IF NOT EXISTS base_url VARCHAR(255)",
            # Per-source PAT, Fernet-encrypted. See services/crypto.py.
            "ALTER TABLE github_sources ADD COLUMN IF NOT EXISTS access_token_encrypted BYTEA",
            # v1.x — max retained APK versions per app. Repo-wide default
            # on RepoConfig, optional per-app override on App.
            "ALTER TABLE repo_config ADD COLUMN IF NOT EXISTS default_max_versions_per_app INTEGER",
            "ALTER TABLE apps ADD COLUMN IF NOT EXISTS max_versions_override INTEGER",
            # Convert apks.whats_new from TEXT → JSON, wrapping any existing
            # text values as ``{"en-US": <text>}`` so the F-Droid spec's
            # per-locale shape is the only one the app code ever sees.
            # Idempotent: ``data_type = 'text'`` is only true on the first run.
            """
            DO $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'apks'
                  AND column_name = 'whats_new'
                  AND data_type = 'text'
              ) THEN
                ALTER TABLE apks
                  ALTER COLUMN whats_new TYPE JSON
                  USING (CASE
                    WHEN whats_new IS NULL OR whats_new = '' THEN NULL
                    ELSE json_build_object('en-US', whats_new)
                  END);
              END IF;
            END $$;
            """,
            # v1.2 — auto-promote happens in the AUTOCOMMIT block
            # below, AFTER ``ALTER TYPE … ADD VALUE 'uploader'``. The
            # in-transaction UPDATE would fail here because the enum
            # doesn't yet contain the new value.
        ):
            try:
                await conn.execute(text(stmt))
            except Exception as exc:  # noqa: BLE001
                log.info("skipping migration step", stmt=stmt, error=str(exc))
        # Release the bootstrap lock — without this the connection
        # holds it until close, which happens implicitly at engine
        # shutdown but is worth being explicit about.
        await conn.execute(text("SELECT pg_advisory_unlock(hashtext('fdroid-store:bootstrap'))"))

    # ALTER TYPE … ADD VALUE cannot run inside a transaction block —
    # PG explicitly refuses, raising
    # ``ALTER TYPE ... ADD cannot run inside a transaction block``.
    # Use a separate AUTOCOMMIT connection so the enum is widened
    # outside any open transaction, then run the data-migration
    # UPDATE in the same connection (now that the new value is
    # available).
    async with engine.connect() as conn:
        await conn.execution_options(isolation_level="AUTOCOMMIT")
        from sqlalchemy import text as _text  # local import to avoid shadowing the inner one above
        # NOTE: SQLAlchemy's ``Enum`` defaults to the Python *member name*
        # (UPPERCASE) as the PG label, so the type already contains
        # ``USER`` and ``ADMIN`` (not their lowercase ``.value`` strings).
        # We add ``UPLOADER`` here to match. The harmless lowercase
        # ``'uploader'`` value that an earlier iteration added once is
        # left in place — PG doesn't support ``DROP VALUE`` and it's
        # unused.
        for stmt in (
            "ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'UPLOADER'",
            # Auto-promote pre-existing ``USER`` accounts that already
            # own or co-maintain an app. Without this, every user with
            # apps would lose /my-apps access at upgrade time.
            # Idempotent on re-run — the WHERE filter on ``role =
            # 'USER'`` short-circuits once everyone is up.
            """
            UPDATE users SET role = 'UPLOADER'
            WHERE role = 'USER'
              AND (
                id IN (SELECT owner_id FROM apps WHERE owner_id IS NOT NULL)
                OR id IN (SELECT user_id FROM app_collaborators)
              )
            """,
        ):
            try:
                await conn.execute(_text(stmt))
            except Exception as exc:  # noqa: BLE001
                log.info("skipping enum migration step", stmt=stmt, error=str(exc))


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
