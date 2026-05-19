"""arq worker tasks.

Run with::

    python -m arq app.workers.tasks.WorkerSettings

Available jobs:
  * ``rebuild_index`` — regenerate index-v1.jar / index-v2.json / entry.jar for
    both the public and the private repo variants.
  * ``scan_apks_periodic`` — opt-in cron job that rescans every PUBLISHED apk
    against clamd (no-op unless ``RepoConfig.clamav_scan_periodic`` is on).
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from arq import cron
from arq.connections import RedisSettings
from sqlalchemy import desc, select

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.logging import configure_logging, get_logger
from app.fdroid.repo_builder import rebuild_repo_index
from app.models.apk import Apk, ApkStatus
from app.models.apk_scan import ApkScan, ApkScanStatus
from app.models.repo_config import RepoConfig
from app.storage import get_storage
from app.storage.local import LocalStorage

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


async def scan_apks_periodic(ctx: dict) -> dict:
    """Re-scan every PUBLISHED apk whose last scan is older than 24h.

    No-op when clamd isn't configured at the env level, when the admin
    hasn't enabled ``clamav_scan_periodic``, or when the storage backend
    isn't ``LocalStorage`` (S3 + scan in-place would need a separate
    fetch pipeline — out of scope for now)."""
    if not settings.clamav_available:
        log.info("scan_apks_periodic skipped: CLAMAV_HOST not set")
        return {"skipped": "clamav_not_configured"}

    from app.services.clamav import scan_path

    storage = get_storage()
    if not isinstance(storage, LocalStorage):
        log.info("scan_apks_periodic skipped: non-local storage")
        return {"skipped": "non_local_storage"}

    async with SessionLocal() as db:
        config = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
        if config is None or not config.clamav_scan_periodic:
            log.info("scan_apks_periodic skipped: admin toggle off")
            return {"skipped": "disabled"}

        cutoff = datetime.now(UTC) - timedelta(hours=24)
        # Pull every PUBLISHED apk; client-side filter by latest-scan-time
        # so the SQL stays simple. The repo isn't large enough for the
        # extra trip to matter.
        apks = (
            await db.execute(
                select(Apk).where(Apk.status == ApkStatus.PUBLISHED)
            )
        ).scalars().all()
        scanned = 0
        infected = 0
        errors = 0
        for apk in apks:
            latest = (
                await db.execute(
                    select(ApkScan)
                    .where(ApkScan.apk_id == apk.id)
                    .order_by(desc(ApkScan.created_at))
                    .limit(1)
                )
            ).scalar_one_or_none()
            if latest is not None and latest.created_at >= cutoff:
                continue
            try:
                local = storage.local_path(apk.storage_key)
            except Exception:
                continue
            if not local.exists():
                continue
            result = await scan_path(local)
            row = ApkScan(
                apk_id=apk.id,
                scanner="clamav",
                scanned_at=datetime.now(UTC),
            )
            if result.clean:
                row.status = ApkScanStatus.CLEAN
            elif result.signature:
                row.status = ApkScanStatus.INFECTED
                row.signatures = result.signature
                infected += 1
            else:
                row.status = ApkScanStatus.ERROR
                row.error = result.error
                errors += 1
            db.add(row)
            scanned += 1
        await db.commit()
        log.info(
            "scan_apks_periodic complete",
            scanned=scanned,
            infected=infected,
            errors=errors,
        )
        return {"scanned": scanned, "infected": infected, "errors": errors}


async def startup(ctx: dict) -> None:
    configure_logging()
    log.info("arq worker starting", redis=settings.redis_url)


async def shutdown(ctx: dict) -> None:
    log.info("arq worker shutting down")


class WorkerSettings:
    functions = [rebuild_index, scan_apks_periodic]
    # Run the rescan at 03:00 UTC every day. The function short-circuits
    # at the top when the feature is off, so leaving the cron registered
    # is safe even on deployments that never enable it.
    cron_jobs = [
        cron(scan_apks_periodic, hour={3}, minute={0}, run_at_startup=False),
    ]
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    on_startup = startup
    on_shutdown = shutdown
    # rebuild_index is dedup-coalesced by job_id at enqueue time, so we don't
    # need a high concurrency.
    max_jobs = 2
    job_timeout = 600
    keep_result = 30
