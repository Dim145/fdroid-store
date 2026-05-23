"""Thin wrapper around arq's redis queue.

Centralized here so route code doesn't need to know about arq at all.
"""
from __future__ import annotations

import uuid

from arq import create_pool
from arq.connections import RedisSettings

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)


def _redis_settings() -> RedisSettings:
    return RedisSettings.from_dsn(settings.redis_url)


async def enqueue_reindex(*, force: bool = False) -> None:
    """Schedule a repo reindex.

    Arq dedupes by ``_job_id`` against both queued *and* recently-finished
    jobs — the result key lingers in redis for ~24h, so a fixed id like
    ``"rebuild_index"`` would silently swallow every enqueue between the
    first run of the day and the result-TTL expiry. Symptom: APKs
    uploaded all day never appear in the F-Droid index until tomorrow.

    To stay useful, we use a **per-minute job id** by default:

      * Multiple events inside the same minute (upload → publish →
        another upload) coalesce into a single rebuild — same intent as
        the old fixed id.
      * Events in different minutes each get their own rebuild because
        the bucket flipped — the 24h result TTL never blocks the next
        bucket.

    ``force=True`` short-circuits to a millisecond-unique id so the admin
    "Trigger reindex" button always actually runs even when the current
    minute's rebuild is already cached.
    """
    import time as _time

    try:
        pool = await create_pool(_redis_settings())
        try:
            if force:
                job_id = f"rebuild_index:manual:{int(_time.time() * 1000)}"
            else:
                bucket = int(_time.time() // 60)
                job_id = f"rebuild_index:{bucket}"
            await pool.enqueue_job("rebuild_index", _job_id=job_id)
        finally:
            await pool.close()
    except Exception as exc:  # noqa: BLE001
        # We don't want a missing redis to break the request — log and move on.
        log.warning("could not enqueue reindex", error=str(exc))


async def enqueue_cve_scan(apk_id: str | uuid.UUID) -> None:
    """Schedule a per-APK SBOM + CVE scan.

    Dedupes within a minute via a bucketed job_id (similar pattern to
    :func:`enqueue_reindex`): rapid bursts of enqueues collapse to a
    single scan, but a manual re-scan a few minutes later still runs.
    Arq's 24h ``keep_result`` would otherwise swallow any second
    enqueue with the same id.
    """
    import time as _time
    import uuid as _uuid

    try:
        pool = await create_pool(_redis_settings())
        try:
            bucket = int(_time.time() // 60)
            job_id = f"scan_apk_cve:{_uuid.UUID(str(apk_id))}:{bucket}"
            await pool.enqueue_job("scan_apk_cve", str(apk_id), _job_id=job_id)
        finally:
            await pool.close()
    except Exception as exc:  # noqa: BLE001
        log.warning("could not enqueue cve scan", error=str(exc), apk_id=str(apk_id))


async def enqueue_clamav_scan() -> bool:
    """Schedule a one-shot full rescan of every published APK.

    Identical to the daily cron run but with ``force=True`` so the toggle
    + 24h-cutoff are bypassed. Coalesced under a fixed job_id — pressing
    the button multiple times in quick succession only queues one run.
    Returns True when the enqueue succeeded, False when Redis was
    unreachable so the caller can surface a 503.
    """
    try:
        pool = await create_pool(_redis_settings())
        try:
            await pool.enqueue_job(
                "scan_apks_periodic",
                True,  # force
                _job_id="scan_apks_manual",
            )
            return True
        finally:
            await pool.close()
    except Exception as exc:  # noqa: BLE001
        log.warning("could not enqueue manual scan", error=str(exc))
        return False


async def enqueue_github_source_scan(source_id: str, *, immediate: bool = False) -> bool:
    """Schedule a one-shot scan of a single GitHub source.

    We deliberately let arq mint a fresh job id every time — the previous
    run's result stays in redis for 24h and would otherwise dedup the
    new enqueue, making the "Scan now" button silently a no-op.
    The cron coordinator enqueues directly with a per-source job id so
    that one run per day per repo is coalesced as expected.
    """
    import time

    try:
        pool = await create_pool(_redis_settings())
        try:
            # job_id encodes the source + epoch ms so every manual trigger
            # is unique while still being grep-friendly in the jobs page.
            await pool.enqueue_job(
                "fetch_github_source",
                source_id,
                _job_id=f"fetch_github_source:{source_id}:{int(time.time() * 1000)}",
            )
            return True
        finally:
            await pool.close()
    except Exception as exc:  # noqa: BLE001
        log.warning("could not enqueue github source scan", error=str(exc))
        return False


async def enqueue_apk_proxy_source_scan(source_id: str) -> bool:
    """Schedule a one-shot scan of a single proxy source.

    Mirrors :func:`enqueue_github_source_scan` — the cron coordinator
    enqueues with a stable per-source job id (one run per cycle coalesced),
    manual triggers use an epoch-suffixed id so the result from the
    previous run doesn't dedupe the new one to a silent no-op.
    """
    import time

    try:
        pool = await create_pool(_redis_settings())
        try:
            await pool.enqueue_job(
                "fetch_apk_proxy_source",
                source_id,
                _job_id=f"fetch_apk_proxy_source:{source_id}:{int(time.time() * 1000)}",
            )
            return True
        finally:
            await pool.close()
    except Exception as exc:  # noqa: BLE001
        log.warning("could not enqueue proxy source scan", error=str(exc))
        return False


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
