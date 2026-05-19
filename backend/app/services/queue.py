"""Thin wrapper around arq's redis queue.

Centralized here so route code doesn't need to know about arq at all.
"""
from __future__ import annotations

from arq import create_pool
from arq.connections import RedisSettings

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)


def _redis_settings() -> RedisSettings:
    return RedisSettings.from_dsn(settings.redis_url)


async def enqueue_reindex() -> None:
    """Schedule a repo reindex. Multiple enqueues coalesce naturally because
    arq deduplicates by job_id."""
    try:
        pool = await create_pool(_redis_settings())
        try:
            await pool.enqueue_job("rebuild_index", _job_id="rebuild_index")
        finally:
            await pool.close()
    except Exception as exc:  # noqa: BLE001
        # We don't want a missing redis to break the request — log and move on.
        log.warning("could not enqueue reindex", error=str(exc))


async def queue_snapshot() -> dict:
    """Best-effort introspection for the admin "Jobs" page.

    Reads three arq lists from redis directly so we can show:
      * ``queued``   — number of jobs waiting on the default queue
      * ``in_progress`` — jobs currently being handled by a worker
      * ``recent`` — last few result keys with their status/duration

    Returns an empty snapshot when redis is unreachable rather than
    raising — the page degrades gracefully instead of erroring out.
    """
    import time

    snap: dict = {"available": False, "queued": 0, "in_progress": 0, "recent": []}
    try:
        pool = await create_pool(_redis_settings())
        try:
            # arq's default queue name is ``arq:queue`` and result keys are
            # prefixed with ``arq:result:``. ``arq:in-progress:<jti>`` rows
            # are set by an active worker; they're plain SET keys.
            queued = await pool.zcard("arq:queue")
            in_progress_keys = await pool.keys("arq:in-progress:*")
            result_keys = await pool.keys("arq:result:*")
            recent_keys = sorted(result_keys)[-10:]
            recent: list[dict] = []
            for key in recent_keys:
                raw = await pool.get(key)
                if raw is None:
                    continue
                # arq encodes result rows with msgpack. We optimistically
                # decode and pull a handful of well-known fields; if the
                # blob is unparseable we just surface the key.
                try:
                    from arq.jobs import deserialize_result

                    parsed = deserialize_result(raw, deserializer=None)
                    if parsed is None:
                        continue
                    recent.append({
                        "function": parsed.function,
                        "success": parsed.success,
                        "start_time": (
                            parsed.start_time.isoformat() if parsed.start_time else None
                        ),
                        "finish_time": (
                            parsed.finish_time.isoformat() if parsed.finish_time else None
                        ),
                        "duration_ms": (
                            int((parsed.finish_time - parsed.start_time).total_seconds() * 1000)
                            if parsed.finish_time and parsed.start_time
                            else None
                        ),
                        "result_str": (
                            str(parsed.result)[:200] if parsed.result is not None else None
                        ),
                    })
                except Exception:  # noqa: BLE001
                    recent.append({"raw_key": key.decode() if isinstance(key, bytes) else key})
            snap.update(
                available=True,
                queued=int(queued or 0),
                in_progress=len(in_progress_keys or []),
                recent=list(reversed(recent)),
                observed_at=int(time.time()),
            )
        finally:
            await pool.close()
    except Exception as exc:  # noqa: BLE001
        log.warning("queue_snapshot failed", error=str(exc))
        snap["error"] = str(exc)[:200]
    return snap
