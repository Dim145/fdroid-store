"""Top-level orchestration of repo index generation.

Public API:
  * :func:`rebuild_repo_index` — full regenerate (called by the worker)

A rebuild has two outputs:
  1. The "public" index — contains only PUBLIC + PUBLISHED apps.
  2. The "private" index — same plus PRIVATE apps. This is served behind auth.

Both indexes are produced as ``index-v1.jar``, ``index-v2.json``, ``entry.jar``
under separate storage prefixes (``repo/public/`` vs ``repo/private/``).
"""
from __future__ import annotations

import hashlib
import json
import tempfile
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
from app.models.app import App, AppVisibility
from app.models.apk import ApkStatus
from app.models.repo_config import RepoConfig
from app.storage import Storage, get_storage

log = get_logger(__name__)


REPO_PUBLIC_PREFIX = "repo/public"
REPO_PRIVATE_PREFIX = "repo/private"


async def _load_repo_config(db: AsyncSession) -> RepoConfig:
    res = await db.execute(select(RepoConfig).limit(1))
    row = res.scalar_one_or_none()
    if row is None:
        raise RuntimeError("Repo config row is missing — setup wizard not completed")
    return row


async def _load_apps(db: AsyncSession, *, include_private: bool) -> list[App]:
    stmt = (
        select(App)
        .options(
            selectinload(App.apks),
            selectinload(App.categories),
            selectinload(App.localizations),
            selectinload(App.screenshots),
        )
        .where(App.status == "published")
    )
    if not include_private:
        stmt = stmt.where(App.visibility == AppVisibility.PUBLIC)
    result = await db.execute(stmt)
    apps = list(result.scalars().unique().all())
    # Filter at python level: keep only apps that have at least one published APK
    return [
        a for a in apps
        if any(apk.status == ApkStatus.PUBLISHED for apk in a.apks)
    ]


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


async def rebuild_repo_index(db: AsyncSession) -> None:
    """Regenerate both public and private indexes from current DB state."""
    storage = get_storage()
    repo_config = await _load_repo_config(db)

    if not repo_config.setup_complete:
        log.warning("skipping reindex: setup wizard not completed yet")
        return
    if not Path(settings.keystore_path).exists():
        log.warning("skipping reindex: keystore missing", path=settings.keystore_path)
        return

    log.info("rebuilding repo index", repo=repo_config.name)

    apps_public = await _load_apps(db, include_private=False)
    apps_private = await _load_apps(db, include_private=True)

    await _build_one(storage, repo_config=repo_config, apps=apps_public, prefix=REPO_PUBLIC_PREFIX)
    await _build_one(storage, repo_config=repo_config, apps=apps_private, prefix=REPO_PRIVATE_PREFIX)

    repo_config.last_index_version += 1
    repo_config.last_indexed_at = datetime.now(UTC)
    await db.flush()
    log.info(
        "repo index rebuilt",
        public_apps=len(apps_public),
        total_apps=len(apps_private),
        version=repo_config.last_index_version,
    )
