"""Top-level orchestration of repo index generation.

Public API:
  * :func:`rebuild_repo_index` — full regenerate (called by the worker)

A rebuild produces:
  1. **Public index** at ``repo/public/`` — PUBLIC + PUBLISHED apps, NSFW
     hidden.
  2. **Public + NSFW index** at ``repo/public-nsfw/`` — the same with NSFW
     apps, shared by every user who opted into NSFW and owns no private app.
  3. **Per-user private index** at ``repo/private/u_<owner_id>/`` for every
     user that owns at least one PRIVATE + PUBLISHED app. The index contains
     all PUBLIC + PUBLISHED apps plus the owner's own PRIVATE + PUBLISHED
     apps. This way an API key holder only ever sees their own private apps
     in their F-Droid client.

Each variant is a triple of ``index-v1.jar`` + ``index-v2.json`` + ``entry.jar``.

A per-user variant is only ever served to a user listed in
``RepoConfig.private_index_owner_ids`` (see ``app.api.fdroid``): dropping a
user from that list is what retires their variant, deleting its files is
cleanup.
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
REPO_PUBLIC_NSFW_PREFIX = "repo/public-nsfw"
REPO_PRIVATE_PREFIX = "repo/private"


def user_private_prefix(owner_id: uuid_module.UUID | str) -> str:
    """Storage prefix for a single user's private index variant."""
    return f"{REPO_PRIVATE_PREFIX}/u_{owner_id}"


# The three filenames an F-Droid client fetches at the repo root, in
# publication order: ``entry.jar`` — the signed entrypoint, whose presence
# the serving layer reads as "this variant is complete" — goes up last and is
# deleted first.
_INDEX_FILENAMES = ("index-v1.jar", "index-v2.json", "entry.jar")
_INDEX_CONTENT_TYPES = {
    "index-v1.jar": "application/java-archive",
    "index-v2.json": "application/json",
    "entry.jar": "application/java-archive",
}


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

    Their view of the catalogue is wider than the default public one: the
    shared public + NSFW index serves them, or — when they own private
    apps — their per-user index keeps the NSFW apps in.
    """
    rows = (
        await db.execute(
            select(User.id).where(User.show_nsfw.is_(True), User.is_active.is_(True))
        )
    ).all()
    return [row[0] for row in rows]


async def _load_private_apps_by_owner(
    db: AsyncSession,
) -> dict[uuid_module.UUID, list[App]]:
    """PRIVATE + PUBLISHED apps with a published APK, grouped by owner.

    Disabled owners are left out (like ``_load_nsfw_users``): their API keys
    are refused anyway, and dropping them from the per-user list retires
    the variant that still holds their private apps.
    """
    result = await db.execute(
        _published_app_query()
        .join(User, User.id == App.owner_id)
        .where(App.visibility == AppVisibility.PRIVATE, User.is_active.is_(True))
    )
    by_owner: dict[uuid_module.UUID, list[App]] = {}
    for app in _keep_with_published_apk(list(result.scalars().unique().all())):
        if app.owner_id is not None:
            by_owner.setdefault(app.owner_id, []).append(app)
    return by_owner


async def _sign_jar(name: str, entries: dict[str, bytes]) -> bytes:
    """Build + sign a JAR in a tmpdir and return its bytes."""
    with tempfile.TemporaryDirectory() as tmp:
        local = Path(tmp) / name
        await build_and_sign_jar(
            local,
            entries,
            keystore_path=Path(settings.keystore_path),
            keystore_password=settings.keystore_password,
            alias=settings.key_alias,
            key_password=settings.key_password,
        )
        return local.read_bytes()


def _parse_mirrors(repo_config: RepoConfig) -> list[str]:
    # Admin-managed mirror list lives in ``mirrors_json`` as a JSON-encoded
    # array. Tolerate empty/missing/garbled values: bad mirror data shouldn't
    # block a reindex, the worst case is the index just lacks the field.
    try:
        raw = json.loads(repo_config.mirrors_json or "[]")
    except json.JSONDecodeError:
        log.warning("repo_config.mirrors_json is not valid JSON; ignoring")
        return []
    return [str(u) for u in raw if u] if isinstance(raw, list) else []


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
        if app.promo_graphic_path:
            file_keys.add(app.promo_graphic_path)
        if app.tv_banner_path:
            file_keys.add(app.tv_banner_path)
    for key in file_keys:
        # Only a missing file is skipped. A storage error (S3 timeout, 5xx,
        # 403) fails the rebuild so the worker retries it, instead of
        # publishing an index whose icons silently vanished.
        if not await storage.exists(key):
            continue
        try:
            data = await storage.get_bytes(key)
        except FileNotFoundError:
            continue  # deleted between the two calls
        meta[key] = {
            "sha256": hashlib.sha256(data).hexdigest(),
            "size": len(data),
        }
    return meta


async def _render_variant(
    *,
    repo_config: RepoConfig,
    apps: list[App],
    mirrors: list[str],
    file_meta: dict[str, dict[str, Any]],
    timestamp_ms: int,
) -> dict[str, bytes]:
    """Build and sign one variant's three files, without touching storage.

    All three share ONE timestamp: the F-Droid v2 client binds the signed
    entry.json to index-v2.json by both checksum AND ``timestamp``, so they
    must be byte-for-byte agreed. Threading ``timestamp_ms`` (rather than
    letting each builder call ``now()``) is what fixes the intermittent
    "expected timestamp doesn't match" client error.
    """
    # index-v1.jar (contains index-v1.json, signed)
    v1_bytes = build_index_v1(
        repo_config=repo_config, apps=apps, mirrors=mirrors, timestamp_ms=timestamp_ms
    )
    v1_jar = await _sign_jar("index-v1.jar", {"index-v1.json": v1_bytes})

    # index-v2.json (plaintext). ``webBaseUrl`` points F-Droid's "Share"
    # action at our public app pages (``/apps/<package>``).
    v2_bytes = build_index_v2(
        repo_config=repo_config, apps=apps, mirrors=mirrors,
        file_meta=file_meta, timestamp_ms=timestamp_ms,
        web_base_url=f"{settings.public_app_url.rstrip('/')}/apps",
    )

    # entry.jar (signed) — same timestamp as index-v2.json above.
    entry_obj = json.loads(build_entry_json(v2_bytes, timestamp_ms=timestamp_ms))
    entry_obj["index"]["numPackages"] = len(apps)
    entry_bytes = json.dumps(entry_obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    entry_jar = await _sign_jar("entry.jar", {"entry.json": entry_bytes})

    return {"index-v1.jar": v1_jar, "index-v2.json": v2_bytes, "entry.jar": entry_jar}


async def _publish_variant(storage: Storage, prefix: str, files: dict[str, bytes]) -> None:
    """Upload a rendered variant. Everything is built and signed already, so
    the uploads run back to back, ``entry.jar`` last: the signed entry never
    points at an index-v2.json that isn't in place yet."""
    for name in _INDEX_FILENAMES:
        await storage.put(f"{prefix}/{name}", files[name], content_type=_INDEX_CONTENT_TYPES[name])


async def _build_one(
    storage: Storage,
    *,
    repo_config: RepoConfig,
    apps: list[App],
    prefix: str,
    timestamp_ms: int,
    mirrors: list[str],
    file_meta: dict[str, dict[str, Any]],
) -> None:
    files = await _render_variant(
        repo_config=repo_config, apps=apps, mirrors=mirrors,
        file_meta=file_meta, timestamp_ms=timestamp_ms,
    )
    await _publish_variant(storage, prefix, files)


async def _delete_user_private_index(storage: Storage, owner_id: str) -> None:
    """Best-effort cleanup of stale per-user index files. ``entry.jar`` goes
    first, so the variant stops looking complete before anything else is
    removed. A failure only leaves dead files behind: the serving layer
    hands a per-user variant only to users still in
    ``private_index_owner_ids``, and a later build overwrites them."""
    prefix = user_private_prefix(owner_id)
    for name in reversed(_INDEX_FILENAMES):
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

    # One timestamp for the whole rebuild, forced strictly monotonic against
    # the previous rebuild. F-Droid clients treat a non-increasing repo
    # timestamp as a rollback and refuse the update, so if the wall clock
    # ever steps backwards (NTP correction) we still hand out an increasing
    # value rather than wedging every client until real time catches up.
    now_ms = int(datetime.now(UTC).timestamp() * 1000)
    prev = repo_config.last_indexed_at
    if prev is not None:
        prev_aware = prev if prev.tzinfo is not None else prev.replace(tzinfo=UTC)
        prev_ms = int(prev_aware.timestamp() * 1000)
        if now_ms <= prev_ms:
            now_ms = prev_ms + 1

    apps_public_all = await _load_public_apps(db)
    apps_public_sfw = _strip_nsfw(apps_public_all)

    # Two divergences from the default public view:
    #   1. The user owns a private app (only they can see it) → per-user
    #      index, the only kind that needs one.
    #   2. The user toggled ``show_nsfw=True`` (their public view is wider)
    #      → the shared public + NSFW index, or NSFW kept in their per-user
    #      one. (A per-user copy each cost two signing runs per rebuild.)
    private_by_owner = await _load_private_apps_by_owner(db)
    nsfw_users = set(await _load_nsfw_users(db))
    per_user_ids = set(private_by_owner)

    # Hash the static files once for every variant: they all share the
    # public apps' icons and screenshots.
    mirrors = _parse_mirrors(repo_config)
    file_meta = await _collect_file_meta(
        storage,
        repo_config=repo_config,
        apps=[*apps_public_all, *(a for apps in private_by_owner.values() for a in apps)],
    )

    # The shared public index is the default-view: no NSFW. Anonymous F-Droid
    # clients and API keys for users without an opt-in fall through here.
    await _build_one(
        storage, repo_config=repo_config, apps=apps_public_sfw,
        prefix=REPO_PUBLIC_PREFIX, timestamp_ms=now_ms,
        mirrors=mirrors, file_meta=file_meta,
    )
    # Built unconditionally so the serving layer can count on it as soon
    # as a user opts in.
    await _build_one(
        storage, repo_config=repo_config, apps=apps_public_all,
        prefix=REPO_PUBLIC_NSFW_PREFIX, timestamp_ms=now_ms,
        mirrors=mirrors, file_meta=file_meta,
    )

    private_total = 0
    for user_id in per_user_ids:
        show_nsfw = user_id in nsfw_users
        base_public = apps_public_all if show_nsfw else apps_public_sfw
        owner_private = private_by_owner.get(user_id, [])
        if not show_nsfw:
            owner_private = _strip_nsfw(owner_private)
        await _build_one(
            storage,
            repo_config=repo_config,
            apps=base_public + owner_private,
            prefix=user_private_prefix(user_id),
            timestamp_ms=now_ms,
            mirrors=mirrors,
            file_meta=file_meta,
        )
        private_total += len(owner_private)

    # Users that had a per-user index previously but no longer do (private
    # apps gone or owner disabled; NSFW-only users of older builds). Leaving
    # the list is what stops their variant being served; the delete is only
    # cleanup, so a failed one can't keep a frozen index online.
    try:
        previous = set(json.loads(repo_config.private_index_owner_ids or "[]"))
    except json.JSONDecodeError:
        previous = set()
    current_set = {str(uid) for uid in per_user_ids}
    for stale in previous - current_set:
        await _delete_user_private_index(storage, stale)

    repo_config.private_index_owner_ids = json.dumps(sorted(current_set))
    repo_config.last_index_version += 1
    # Persist the EXACT timestamp embedded in this rebuild's indexes (not a
    # fresh now()) so the monotonic clamp on the next rebuild is precise.
    repo_config.last_indexed_at = datetime.fromtimestamp(now_ms / 1000, tz=UTC)
    await db.flush()
    log.info(
        "repo index rebuilt",
        public_apps=len(apps_public_sfw),
        public_nsfw_hidden=len(apps_public_all) - len(apps_public_sfw),
        nsfw_users=len(nsfw_users),
        per_user_indexes=len(per_user_ids),
        private_apps=private_total,
        version=repo_config.last_index_version,
    )
