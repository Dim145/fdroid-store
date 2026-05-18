"""Top-level orchestration of repo index generation.

Public API:
  * :func:`rebuild_repo_index` — full regenerate (called by the worker)

A rebuild produces:
  1. **Public index** at ``repo/public/`` — PUBLIC + PUBLISHED apps.
  2. **Per-user private index** at ``repo/private/u_<owner_id>/`` for every
     user that owns at least one PRIVATE + PUBLISHED app. The index contains
     all PUBLIC + PUBLISHED apps plus the owner's own PRIVATE + PUBLISHED
     apps. This way an API key holder only ever sees their own private apps
     in their F-Droid client.

Each variant is a triple of ``index-v1.jar`` + ``index-v2.json`` + ``entry.jar``.
"""
from __future__ import annotations

import hashlib
import json
import tempfile
import uuid as uuid_module
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.logging import get_logger
from app.fdroid.index_v1 import build_index_v1
from app.fdroid.index_v2 import build_entry_json, build_index_v2
from app.fdroid.signing import build_and_sign_jar
from app.models.app import App, AppStatus, AppVisibility
from app.models.apk import ApkStatus
from app.models.repo_config import RepoConfig
from app.models.user import User
from app.storage import Storage, get_storage

log = get_logger(__name__)


REPO_PUBLIC_PREFIX = "repo/public"
REPO_PRIVATE_PREFIX = "repo/private"


def user_private_prefix(owner_id: uuid_module.UUID | str) -> str:
    """Storage prefix for a single user's private index variant."""
    return f"{REPO_PRIVATE_PREFIX}/u_{owner_id}"


# The three filenames an F-Droid client fetches at the repo root.
_INDEX_FILENAMES = ("index-v1.jar", "index-v2.json", "entry.jar")


async def _load_repo_config(db: AsyncSession) -> RepoConfig:
    res = await db.execute(select(RepoConfig).limit(1))
    row = res.scalar_one_or_none()
    if row is None:
        raise RuntimeError("Repo config row is missing — setup wizard not completed")
    return row


def _published_app_query():
    return (
        select(App)
        .options(
            selectinload(App.apks),
            selectinload(App.categories),
            selectinload(App.localizations),
            selectinload(App.screenshots),
        )
        .where(App.status == AppStatus.PUBLISHED)
    )


def _keep_with_published_apk(apps: list[App]) -> list[App]:
    return [a for a in apps if any(apk.status == ApkStatus.PUBLISHED for apk in a.apks)]


async def _load_public_apps(db: AsyncSession) -> list[App]:
    result = await db.execute(
        _published_app_query().where(App.visibility == AppVisibility.PUBLIC)
    )
    return _keep_with_published_apk(list(result.scalars().unique().all()))


def _strip_nsfw(apps: list[App]) -> list[App]:
    return [a for a in apps if not a.is_nsfw]


async def _load_nsfw_users(db: AsyncSession) -> list[uuid_module.UUID]:
    """User ids that have opted into seeing NSFW apps.

    These users need a per-user F-Droid index even when they don't own a
    private app — their view of the catalogue is wider than the default
    public one, so the shared filtered public index would short-change them.
    """
    rows = (
        await db.execute(
            select(User.id).where(User.show_nsfw.is_(True), User.is_active.is_(True))
        )
    ).all()
    return [row[0] for row in rows]


async def _user_show_nsfw(db: AsyncSession, user_id: uuid_module.UUID) -> bool:
    val = (
        await db.execute(select(User.show_nsfw).where(User.id == user_id))
    ).scalar_one_or_none()
    return bool(val)


async def _load_user_private_apps(db: AsyncSession, owner_id: uuid_module.UUID) -> list[App]:
    """PRIVATE + PUBLISHED apps owned by ``owner_id``."""
    result = await db.execute(
        _published_app_query().where(
            App.visibility == AppVisibility.PRIVATE,
            App.owner_id == owner_id,
        )
    )
    return _keep_with_published_apk(list(result.scalars().unique().all()))


async def _load_private_app_owners(db: AsyncSession) -> list[uuid_module.UUID]:
    """Owner ids that have at least one PRIVATE + PUBLISHED app with a published APK."""
    apps = _keep_with_published_apk(list((
        await db.execute(
            _published_app_query().where(App.visibility == AppVisibility.PRIVATE)
        )
    ).scalars().unique().all()))
    owners: list[uuid_module.UUID] = []
    seen: set[uuid_module.UUID] = set()
    for a in apps:
        if a.owner_id is None or a.owner_id in seen:
            continue
        seen.add(a.owner_id)
        owners.append(a.owner_id)
    return owners


async def _write_jar(
    storage: Storage,
    *,
    storage_key: str,
    entries: dict[str, bytes],
) -> None:
    """Build + sign a JAR in a tmpfile, then push it to storage."""
    with tempfile.TemporaryDirectory() as tmp:
        local = Path(tmp) / Path(storage_key).name
        await build_and_sign_jar(
            local,
            entries,
            keystore_path=Path(settings.keystore_path),
            keystore_password=settings.keystore_password,
            alias=settings.key_alias,
            key_password=settings.key_password,
        )
        await storage.put(storage_key, local.read_bytes(), content_type="application/java-archive")


async def _write_bytes(storage: Storage, key: str, data: bytes, *, content_type: str | None = None) -> None:
    await storage.put(key, data, content_type=content_type)


async def _collect_file_meta(
    storage: Storage,
    *,
    repo_config: RepoConfig,
    apps: list[App],
) -> dict[str, dict[str, Any]]:
    """Hash + size every static file referenced by the index.

    Covers the repo icon, per-app icons, and every screenshot. Screenshot
    rows already carry their hash + size from upload time so we don't re-hash
    them. Icons are hashed fresh because an APK upload can overwrite the
    bytes at ``icons/<package>.png`` without touching the App row.
    """
    meta: dict[str, dict[str, Any]] = {}

    # screenshots — trust the row's columns
    for app in apps:
        for s in app.screenshots:
            meta[s.storage_key] = {"sha256": s.sha256, "size": s.size_bytes}

    # icons + featured graphics — re-hash from storage so we pick up
    # overwrites (an APK upload can overwrite ``icons/<package>.png``
    # without touching the App row, and admins can replace banners).
    file_keys: set[str] = set()
    if repo_config.icon_path:
        file_keys.add(repo_config.icon_path)
    for app in apps:
        if app.icon_path:
            file_keys.add(app.icon_path)
        if app.feature_graphic_path:
            file_keys.add(app.feature_graphic_path)
    for key in file_keys:
        try:
            if not await storage.exists(key):
                continue
            data = await storage.get_bytes(key)
        except Exception as exc:  # noqa: BLE001
            log.warning("could not read static asset for index", key=key, error=str(exc))
            continue
        meta[key] = {
            "sha256": hashlib.sha256(data).hexdigest(),
            "size": len(data),
        }
    return meta


async def _build_one(
    storage: Storage,
    *,
    repo_config: RepoConfig,
    apps: list[App],
    prefix: str,
) -> None:
    file_meta = await _collect_file_meta(storage, repo_config=repo_config, apps=apps)

    # Admin-managed mirror list lives in ``mirrors_json`` as a JSON-encoded
    # array. Tolerate empty/missing/garbled values: bad mirror data shouldn't
    # block a reindex, the worst case is the index just lacks the field.
    mirrors: list[str] = []
    try:
        raw = json.loads(repo_config.mirrors_json or "[]")
        if isinstance(raw, list):
            mirrors = [str(u) for u in raw if u]
    except json.JSONDecodeError:
        log.warning("repo_config.mirrors_json is not valid JSON; ignoring")

    # index-v1.jar (contains index-v1.json, signed)
    v1_bytes = build_index_v1(repo_config=repo_config, apps=apps, mirrors=mirrors)
    await _write_jar(
        storage,
        storage_key=f"{prefix}/index-v1.jar",
        entries={"index-v1.json": v1_bytes},
    )

    # index-v2.json (plaintext) + entry.jar (signed, contains entry.json)
    v2_bytes = build_index_v2(repo_config=repo_config, apps=apps, mirrors=mirrors, file_meta=file_meta)
    await _write_bytes(
        storage,
        f"{prefix}/index-v2.json",
        v2_bytes,
        content_type="application/json",
    )

    entry_obj = json.loads(build_entry_json(v2_bytes))
    entry_obj["index"]["numPackages"] = len(apps)
    entry_bytes = json.dumps(entry_obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    await _write_jar(
        storage,
        storage_key=f"{prefix}/entry.jar",
        entries={"entry.json": entry_bytes},
    )


async def _delete_user_private_index(storage: Storage, owner_id: str) -> None:
    """Best-effort cleanup of stale per-user index files."""
    prefix = user_private_prefix(owner_id)
    for name in _INDEX_FILENAMES:
        try:
            await storage.delete(f"{prefix}/{name}")
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "could not delete stale per-user private index file",
                key=f"{prefix}/{name}",
                error=str(exc),
            )


async def rebuild_repo_index(db: AsyncSession) -> None:
    """Regenerate public + per-user private indexes from current DB state."""
    storage = get_storage()
    repo_config = await _load_repo_config(db)

    if not repo_config.setup_complete:
        log.warning("skipping reindex: setup wizard not completed yet")
        return
    if not Path(settings.keystore_path).exists():
        log.warning("skipping reindex: keystore missing", path=settings.keystore_path)
        return

    log.info("rebuilding repo index", repo=repo_config.name)

    apps_public_all = await _load_public_apps(db)
    apps_public_sfw = _strip_nsfw(apps_public_all)

    # The shared public index is the default-view: no NSFW. Anonymous F-Droid
    # clients and API keys for users without an opt-in fall through here.
    await _build_one(
        storage, repo_config=repo_config, apps=apps_public_sfw, prefix=REPO_PUBLIC_PREFIX,
    )

    # Per-user indexes cover two divergences from the default public view:
    #   1. The user owns a private app (only they can see it).
    #   2. The user toggled ``show_nsfw=True`` (their public view is wider).
    private_owners = await _load_private_app_owners(db)
    nsfw_users = await _load_nsfw_users(db)
    per_user_ids = {*private_owners, *nsfw_users}

    private_total = 0
    for user_id in per_user_ids:
        show_nsfw = await _user_show_nsfw(db, user_id)
        base_public = apps_public_all if show_nsfw else apps_public_sfw
        owner_private = await _load_user_private_apps(db, user_id)
        if not show_nsfw:
            owner_private = _strip_nsfw(owner_private)
        await _build_one(
            storage,
            repo_config=repo_config,
            apps=base_public + owner_private,
            prefix=user_private_prefix(user_id),
        )
        private_total += len(owner_private)

    # Delete index files for users that had a per-user index previously but no
    # longer do (private apps removed AND nsfw toggle flipped off).
    try:
        previous = set(json.loads(repo_config.private_index_owner_ids or "[]"))
    except json.JSONDecodeError:
        previous = set()
    current_set = {str(uid) for uid in per_user_ids}
    for stale in previous - current_set:
        await _delete_user_private_index(storage, stale)

    repo_config.private_index_owner_ids = json.dumps(sorted(current_set))
    repo_config.last_index_version += 1
    repo_config.last_indexed_at = datetime.now(UTC)
    await db.flush()
    log.info(
        "repo index rebuilt",
        public_apps=len(apps_public_sfw),
        public_nsfw_hidden=len(apps_public_all) - len(apps_public_sfw),
        per_user_indexes=len(per_user_ids),
        private_apps=private_total,
        version=repo_config.last_index_version,
    )
