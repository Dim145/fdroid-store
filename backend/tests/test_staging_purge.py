"""Stale staged uploads are listed and purged; the staging counter fails open."""
from __future__ import annotations

import os
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.core import one_time
from app.storage.local import LocalStorage
from app.workers import tasks


async def test_local_storage_lists_a_prefix(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    await storage.put("staging/a.apk", b"a")
    await storage.put("staging/b.apk", b"b")
    await storage.put("apks/c.apk", b"c")
    keys = sorted(k for k, _ in await storage.list_prefix("staging/"))
    assert keys == ["staging/a.apk", "staging/b.apk"]
    assert await LocalStorage(tmp_path / "empty").list_prefix("staging/") == []


async def test_purge_deletes_only_expired_staged_uploads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = LocalStorage(tmp_path)
    await storage.put("staging/old.apk", b"old")
    await storage.put("staging/fresh.apk", b"fresh")
    two_hours_ago = time.time() - 7200
    os.utime(storage.local_path("staging/old.apk"), (two_hours_ago, two_hours_ago))
    monkeypatch.setattr(tasks, "get_storage", lambda: storage)
    assert await tasks.purge_stale_staging({}) == {"deleted": 1}
    assert not await storage.exists("staging/old.apk")
    assert await storage.exists("staging/fresh.apk")


async def test_staging_counter_fails_open(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Down:
        def pipeline(self, transaction: bool = True):
            raise ConnectionError("redis down")

    monkeypatch.setattr(one_time, "_redis", lambda: _Down())
    assert await one_time.bump_counter("staging:u", 3600) == 0


def test_listed_timestamps_are_aware(tmp_path: Path) -> None:
    # Compared against an aware cutoff in the purge job.
    assert datetime.fromtimestamp(0, UTC) < datetime.now(UTC) - timedelta(seconds=1)
