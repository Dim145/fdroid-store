"""Index rebuild coordination: after-commit enqueue, coalescing, single flight."""
from __future__ import annotations

import pytest
from arq import Retry

from app.core import database
from app.services import queue
from app.workers import tasks


async def _record(calls: list[str], name: str) -> None:
    calls.append(name)


# --------------------------------------------------------------------------
# get_db: hooks run only once the request's transaction committed
# --------------------------------------------------------------------------
async def test_after_commit_hooks_run_once_the_request_committed() -> None:
    calls: list[str] = []
    gen = database.get_db()
    await gen.__anext__()
    assert database.run_after_commit("a", lambda: _record(calls, "a"))
    assert database.run_after_commit("a", lambda: _record(calls, "a-again"))  # coalesced
    assert calls == []
    with pytest.raises(StopAsyncIteration):
        await gen.__anext__()
    assert calls == ["a-again"]
    # Back outside a request: callers must do the work themselves.
    assert database.run_after_commit("b", lambda: _record(calls, "b")) is False


async def test_after_commit_hooks_are_dropped_when_the_request_fails() -> None:
    calls: list[str] = []
    gen = database.get_db()
    await gen.__anext__()
    database.run_after_commit("a", lambda: _record(calls, "a"))
    with pytest.raises(RuntimeError):
        await gen.athrow(RuntimeError("boom"))
    assert calls == []


async def test_enqueue_reindex_waits_for_the_commit(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[bool] = []

    async def fake_now(*, force: bool) -> None:
        sent.append(force)

    monkeypatch.setattr(queue, "_enqueue_reindex_now", fake_now)
    gen = database.get_db()
    await gen.__anext__()
    await queue.enqueue_reindex()
    await queue.enqueue_reindex()
    assert sent == []
    with pytest.raises(StopAsyncIteration):
        await gen.__anext__()
    assert sent == [False]


async def test_enqueue_reindex_outside_a_request_is_immediate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent: list[bool] = []

    async def fake_now(*, force: bool) -> None:
        sent.append(force)

    monkeypatch.setattr(queue, "_enqueue_reindex_now", fake_now)
    await queue.enqueue_reindex(force=True)
    assert sent == [True]


# --------------------------------------------------------------------------
# rebuild_index: skip when clean, one build at a time, retry on failure
# --------------------------------------------------------------------------
class _FakeLock:
    def __init__(self, redis: _FakeRedis) -> None:
        self.redis = redis

    async def acquire(self) -> bool:
        if self.redis.locked:
            return False
        self.redis.locked = True
        return True

    async def release(self) -> None:
        self.redis.locked = False

    async def reacquire(self) -> None:
        return None


class _FakeRedis:
    def __init__(self) -> None:
        self.data: dict[str, str] = {}
        self.locked = False

    async def delete(self, *keys: str) -> None:
        for key in keys:
            self.data.pop(key, None)

    async def getdel(self, key: str) -> str | None:
        return self.data.pop(key, None)

    async def set(self, key: str, value: object, nx: bool = False, ex: int | None = None):
        if nx and key in self.data:
            return None
        self.data[key] = str(value)
        return True

    def lock(self, name: str, timeout: float, blocking_timeout: float) -> _FakeLock:
        return _FakeLock(self)


class _NoDbSession:
    async def __aenter__(self) -> _NoDbSession:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    async def commit(self) -> None:
        return None

    async def rollback(self) -> None:
        return None


@pytest.fixture
def builds(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    done: list[str] = []

    async def fake_rebuild(db: object) -> None:
        done.append("build")

    monkeypatch.setattr(tasks, "rebuild_repo_index", fake_rebuild)
    monkeypatch.setattr(tasks, "SessionLocal", _NoDbSession)
    return done


async def test_rebuild_runs_when_dirty_and_consumes_the_flags(builds: list[str]) -> None:
    redis = _FakeRedis()
    redis.data = {queue.REINDEX_DIRTY_KEY: "1", queue.REINDEX_QUEUED_KEY: "1"}
    assert await tasks.rebuild_index({"redis": redis}) == {"ok": True}
    assert builds == ["build"]
    assert redis.data == {}
    assert redis.locked is False


async def test_rebuild_skips_when_nothing_changed(builds: list[str]) -> None:
    result = await tasks.rebuild_index({"redis": _FakeRedis()})
    assert result["skipped"]
    assert builds == []


async def test_forced_rebuild_runs_even_when_clean(builds: list[str]) -> None:
    await tasks.rebuild_index({"redis": _FakeRedis()}, True)
    assert builds == ["build"]


async def test_failed_rebuild_marks_the_index_dirty_again(
    monkeypatch: pytest.MonkeyPatch, builds: list[str]
) -> None:
    async def broken(db: object) -> None:
        raise RuntimeError("storage down")

    monkeypatch.setattr(tasks, "rebuild_repo_index", broken)
    redis = _FakeRedis()
    redis.data = {queue.REINDEX_DIRTY_KEY: "1"}
    with pytest.raises(RuntimeError):
        await tasks.rebuild_index({"redis": redis})
    assert redis.data == {queue.REINDEX_DIRTY_KEY: "1"}
    assert redis.locked is False


async def test_rebuild_waits_for_the_running_one(builds: list[str]) -> None:
    redis = _FakeRedis()
    redis.data = {queue.REINDEX_DIRTY_KEY: "1"}
    redis.locked = True  # another build holds the lock past the wait
    with pytest.raises(Retry):
        await tasks.rebuild_index({"redis": redis})
    assert builds == []
    assert redis.data == {queue.REINDEX_DIRTY_KEY: "1"}
