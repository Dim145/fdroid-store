"""arq worker tasks.

Run with::

    python -m arq app.workers.tasks.WorkerSettings

Available jobs:
  * ``rebuild_index`` — regenerate index-v1.jar / index-v2.json / entry.jar for
    both the public and the private repo variants.
"""
from __future__ import annotations

from arq.connections import RedisSettings

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.logging import configure_logging, get_logger
from app.fdroid.repo_builder import rebuild_repo_index

log = get_logger(__name__)


async def rebuild_index(ctx: dict) -> dict:
    async with SessionLocal() as db:
        try:
            await rebuild_repo_index(db)
            await db.commit()
            return {"ok": True}
        except Exception as exc:
            await db.rollback()
            log.exception("rebuild_index failed", error=str(exc))
            raise


async def startup(ctx: dict) -> None:
    configure_logging()
    log.info("arq worker starting", redis=settings.redis_url)


async def shutdown(ctx: dict) -> None:
    log.info("arq worker shutting down")


class WorkerSettings:
    functions = [rebuild_index]
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    on_startup = startup
    on_shutdown = shutdown
    # rebuild_index is dedup-coalesced by job_id at enqueue time, so we don't
    # need a high concurrency.
    max_jobs = 2
    job_timeout = 600
    keep_result = 30
