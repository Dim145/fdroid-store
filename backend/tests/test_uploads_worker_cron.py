"""Daily source fan-out: per-day job ids, honest counts, worker health."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import arq
import pytest

from app.workers import proxy_tasks, tasks


class _Rows:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def scalars(self) -> _Rows:
        return self

    def all(self) -> list[Any]:
        return self._rows


class _Session:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    async def __aenter__(self) -> _Session:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def execute(self, _stmt: Any) -> _Rows:
        return _Rows(self._rows)


class _Pool:
    """Mimics arq: an id that already has a job or a kept result is dropped."""

    def __init__(self, taken: set[str]) -> None:
        self.taken = taken
        self.ids: list[str] = []

    async def enqueue_job(self, _name: str, *_args: Any, _job_id: str) -> object | None:
        self.ids.append(_job_id)
        if _job_id in self.taken:
            return None
        self.taken.add(_job_id)
        return object()

    async def close(self) -> None:
        return None


def _patch(monkeypatch: pytest.MonkeyPatch, module: Any, rows: list[Any], taken: set[str]) -> _Pool:
    pool = _Pool(taken)

    async def create_pool(*_args: Any, **_kwargs: Any) -> _Pool:
        return pool

    monkeypatch.setattr(module, "SessionLocal", lambda: _Session(rows))
    monkeypatch.setattr(arq, "create_pool", create_pool)
    return pool


async def test_github_fan_out_ids_carry_the_day(monkeypatch: pytest.MonkeyPatch) -> None:
    sid = uuid.uuid4()
    # Yesterday's run left its result under the old-style / yesterday's id.
    taken = {f"fetch_github_source:{sid}", f"fetch_github_source:{sid}:19700101"}
    pool = _patch(monkeypatch, tasks, [SimpleNamespace(id=sid)], taken)
    assert await tasks.scan_github_sources_periodic({}) == {"queued": 1}
    day = datetime.now(UTC).strftime("%Y%m%d")
    assert pool.ids == [f"fetch_github_source:{sid}:{day}"]
    # A second run the same day is deduplicated — and reported as such.
    assert await tasks.scan_github_sources_periodic({}) == {"queued": 0}


async def test_proxy_fan_out_ids_carry_the_day(monkeypatch: pytest.MonkeyPatch) -> None:
    sid = uuid.uuid4()
    source = SimpleNamespace(id=sid, suspended_until=None)
    pool = _patch(monkeypatch, proxy_tasks, [source], {f"fetch_apk_proxy_source:{sid}"})
    result = await proxy_tasks.scan_apk_proxy_sources_periodic({})
    assert result["queued"] == 1
    day = datetime.now(UTC).strftime("%Y%m%d")
    assert pool.ids == [f"fetch_apk_proxy_source:{sid}:{day}"]


def test_worker_health_key_is_refreshed_every_minute() -> None:
    assert tasks.WorkerSettings.health_check_interval == 60
    assert tasks.WorkerSettings.queue_read_limit == 1


# --------------------------------------------------------------------------
# rebuild_index: a failed build is retried by arq
# --------------------------------------------------------------------------
class _Redis:
    def __init__(self) -> None:
        self.data: dict[str, str] = {"reindex:dirty": "1"}

    async def delete(self, *keys: str) -> None:
        for key in keys:
            self.data.pop(key, None)

    async def getdel(self, key: str) -> str | None:
        return self.data.pop(key, None)

    async def set(self, key: str, value: object, **_kw: Any) -> bool:
        self.data[key] = str(value)
        return True

    def lock(self, *_args: Any, **_kwargs: Any) -> _Lock:
        return _Lock()


class _Lock:
    async def acquire(self) -> bool:
        return True

    async def release(self) -> None:
        return None

    async def reacquire(self) -> None:
        return None


class _NoDb:
    async def __aenter__(self) -> _NoDb:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def rollback(self) -> None:
        return None


async def test_failed_rebuild_is_retried_and_stays_dirty(monkeypatch: pytest.MonkeyPatch) -> None:
    async def broken(_db: object) -> None:
        raise OSError("S3 timeout")

    monkeypatch.setattr(tasks, "REINDEX_DIRTY_KEY", "reindex:dirty")
    monkeypatch.setattr(tasks, "rebuild_repo_index", broken)
    monkeypatch.setattr(tasks, "SessionLocal", _NoDb)
    redis = _Redis()
    with pytest.raises(arq.Retry) as excinfo:
        await tasks.rebuild_index({"redis": redis})
    assert excinfo.value.defer_score == 30_000
    assert redis.data.get("reindex:dirty") == "1"


# --------------------------------------------------------------------------
# scan_apks_periodic: one APK's scan blowing up doesn't sink the run
# --------------------------------------------------------------------------
class _ScanDb:
    def __init__(self, apks: list[Any]) -> None:
        self._apks = apks
        self.commits = 0
        self.added: list[Any] = []

    async def __aenter__(self) -> _ScanDb:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def execute(self, stmt: Any) -> Any:
        sql = str(stmt)
        if "repo_config" in sql:
            config = SimpleNamespace(clamav_scan_periodic=True)
            return SimpleNamespace(scalar_one_or_none=lambda: config)
        if "apk_scans" in sql:
            return SimpleNamespace(scalar_one_or_none=lambda: None)
        return _Rows(self._apks)

    def add(self, row: Any) -> None:
        self.added.append(row)

    async def commit(self) -> None:
        self.commits += 1


async def test_one_failing_scan_keeps_the_other_verdicts(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    from app.models.apk_scan import ApkScanStatus
    from app.services import clamav
    from app.storage.local import LocalStorage

    files = {}
    for name in ("a", "b", "c"):
        files[name] = tmp_path / f"{name}.apk"
        files[name].write_bytes(b"apk")

    class _Storage(LocalStorage):
        def __init__(self) -> None:
            pass

        def local_path(self, key: str) -> Any:
            return files[key]

    async def scan(path: Any) -> Any:
        if path.name == "b.apk":
            raise ConnectionResetError("clamd closed the stream")
        return SimpleNamespace(clean=True, signature=None, error=None)

    apk_rows = [SimpleNamespace(id=uuid.uuid4(), storage_key=k) for k in ("a", "b", "c")]
    db = _ScanDb(apk_rows)
    monkeypatch.setattr(tasks.settings, "clamav_host", "clamd")
    monkeypatch.setattr(tasks, "get_storage", _Storage)
    monkeypatch.setattr(tasks, "SessionLocal", lambda: db)
    monkeypatch.setattr(clamav, "scan_path", scan)
    result = await tasks.scan_apks_periodic({}, True)
    assert result == {"scanned": 3, "infected": 0, "errors": 1}
    assert [r.status for r in db.added] == [
        ApkScanStatus.CLEAN, ApkScanStatus.ERROR, ApkScanStatus.CLEAN,
    ]
    assert db.commits == 3  # one per APK
