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
