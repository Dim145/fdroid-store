"""arq worker tasks.

Run with::

    python -m arq app.workers.tasks.WorkerSettings

Available jobs:
  * ``rebuild_index`` — regenerate index-v1.jar / index-v2.json / entry.jar for
    both the public and the private repo variants.
  * ``scan_apks_periodic`` — opt-in cron job that rescans every PUBLISHED apk
    against clamd (no-op unless ``RepoConfig.clamav_scan_periodic`` is on).
  * ``scan_github_sources_periodic`` — daily coordinator that enqueues a
    ``fetch_github_source`` per enabled :class:`GithubSource`.
  * ``fetch_github_source`` — poll one GitHub repo and import the latest
    matching release as a new APK.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from arq import cron
from arq.connections import RedisSettings
from sqlalchemy import desc, select
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.logging import configure_logging, get_logger
from app.fdroid.repo_builder import rebuild_repo_index
from app.models.apk import Apk, ApkStatus
from app.models.apk_scan import ApkScan, ApkScanStatus
from app.models.app import App
from app.models.github_source import GithubSource, GithubSourceStatus
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


async def scan_apks_periodic(ctx: dict, force: bool = False) -> dict:
    """Re-scan every PUBLISHED apk whose last scan is older than 24h.

    No-op when clamd isn't configured at the env level or when the
    storage backend isn't ``LocalStorage`` (S3 + scan in-place would
    need a separate fetch pipeline — out of scope for now).

    The ``clamav_scan_periodic`` admin toggle gates the *recurring* cron
    run; manual triggers from /admin/scans set ``force=True`` so an
    operator can validate the setup before flipping the daily switch on.
    """
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
        if not force and (config is None or not config.clamav_scan_periodic):
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
            # Manual triggers rescan everything; cron runs only refresh
            # rows older than 24h (or never-scanned).
            if not force and latest is not None and latest.created_at >= cutoff:
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


async def scan_github_sources_periodic(ctx: dict) -> dict:
    """Coordinator: enqueue a per-source scan for every enabled GitHub source.

    We deliberately split the work into one job per repo so each scan
    appears individually in /admin/jobs and a failing source doesn't
    take down the others. Disabled sources are skipped — flipping the
    toggle is the supported way to pause auto-imports without losing
    the configuration.
    """
    from arq import create_pool

    async with SessionLocal() as db:
        sources = (
            await db.execute(
                select(GithubSource).where(GithubSource.enabled.is_(True))
            )
        ).scalars().all()

    if not sources:
        log.info("scan_github_sources: nothing to do")
        return {"queued": 0}

    pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
    try:
        queued = 0
        for s in sources:
            sid = str(s.id)
            await pool.enqueue_job(
                "fetch_github_source",
                sid,
                _job_id=f"fetch_github_source:{sid}",
            )
            queued += 1
    finally:
        await pool.close()
    log.info("scan_github_sources queued", queued=queued)
    return {"queued": queued}


async def fetch_github_source(ctx: dict, source_id: str) -> dict:
    """Poll one GitHub repo and import the latest matching release.

    The result dict is what the admin sees in /admin/jobs (Recent runs).
    We aim to keep it short and human-readable: status (imported / up-to-date
    / skipped / error), tag, asset name, version_code when applicable.

    Errors are persisted on the source row (``last_status=ERROR``,
    ``last_error=<msg>``) so the user sees them on their app page even
    after the job result has rotated out of redis.
    """
    from app.api.v1.apks import attach_apk_to_app, parse_or_400
    from app.services.audit import write_event
    from app.services.github_releases import (
        GithubReleaseError,
        download_asset,
        find_latest_asset,
    )
    from app.services.queue import enqueue_reindex

    try:
        sid = uuid.UUID(source_id)
    except ValueError:
        log.warning("fetch_github_source: invalid source_id", source_id=source_id)
        return {"status": "error", "error": "invalid source id"}

    async with SessionLocal() as db:
        source = (
            await db.execute(
                select(GithubSource)
                .options(selectinload(GithubSource.app).selectinload(App.apks))
                .where(GithubSource.id == sid)
            )
        ).scalar_one_or_none()
        if source is None:
            log.warning("fetch_github_source: source vanished", source_id=source_id)
            return {"status": "error", "error": "source not found"}
        app = source.app
        if app is None:
            return {"status": "error", "error": "app not found"}

        # Re-fetch owner separately so attach_apk_to_app has a uploader.
        from app.models.user import User
        owner = None
        if app.owner_id is not None:
            owner = (
                await db.execute(select(User).where(User.id == app.owner_id))
            ).scalar_one_or_none()
        if owner is None:
            await _mark_source_error(
                db, source, "App has no owner — cannot attribute uploads"
            )
            await db.commit()
            return {"status": "error", "error": "app owner missing"}

        # Decrypt the per-source token. ``decrypt`` returns None when
        # the blob is empty or the key has rotated — both paths fall
        # through to the env-var default inside ``find_latest_asset``.
        from app.services.crypto import decrypt as _decrypt

        per_source_token = _decrypt(source.access_token_encrypted)

        # ---- 1. Probe the forge for the latest eligible release --------
        try:
            asset = await find_latest_asset(
                source.repo,
                asset_pattern=source.asset_pattern,
                include_prereleases=source.include_prereleases,
                provider=source.provider.value,
                base_url=source.base_url,
                token=per_source_token,
            )
        except GithubReleaseError as exc:
            await _mark_source_error(db, source, str(exc))
            await db.commit()
            return {"status": "error", "repo": source.repo, "error": str(exc)}

        source.last_scanned_at = datetime.now(UTC)

        if asset is None:
            source.last_status = GithubSourceStatus.UP_TO_DATE
            source.last_error = None
            await db.commit()
            log.info("fetch_github_source: no matching release", repo=source.repo)
            return {"status": "up_to_date", "repo": source.repo, "note": "no matching asset"}

        # Already imported this exact tag — no-op.
        if source.last_release_tag == asset.release_tag:
            source.last_status = GithubSourceStatus.UP_TO_DATE
            source.last_error = None
            source.last_release_published_at = asset.release_published_at
            await db.commit()
            return {
                "status": "up_to_date",
                "repo": source.repo,
                "tag": asset.release_tag,
            }

        # ---- 2. Download the asset to a tmpfile ------------------------
        try:
            tmp_path = await download_asset(asset)
        except GithubReleaseError as exc:
            await _mark_source_error(db, source, f"Download failed: {exc}")
            await db.commit()
            return {"status": "error", "repo": source.repo, "error": str(exc)}

        # ---- 3. Parse + persist as an APK (same path as manual upload) -
        try:
            try:
                meta = await parse_or_400(tmp_path)
            except Exception as exc:  # noqa: BLE001
                await _mark_source_error(
                    db, source, f"APK parsing failed: {getattr(exc, 'detail', str(exc))}"
                )
                await db.commit()
                return {"status": "error", "repo": source.repo, "error": "parse_failed"}

            # Pre-flight: same version_code already in this app? Mark
            # imported tag so we don't loop forever on a known release.
            already_present = any(a.version_code == meta.version_code for a in app.apks)
            if already_present:
                source.last_status = GithubSourceStatus.SKIPPED
                source.last_release_tag = asset.release_tag
                source.last_release_published_at = asset.release_published_at
                source.last_error = (
                    f"Release {asset.release_tag} skipped: versionCode "
                    f"{meta.version_code} already exists in this app"
                )
                await db.commit()
                return {
                    "status": "skipped",
                    "repo": source.repo,
                    "tag": asset.release_tag,
                    "reason": "version_code_present",
                }

            try:
                apk = await attach_apk_to_app(
                    db,
                    app=app,
                    tmp_path=tmp_path,
                    meta=meta,
                    uploader=owner,
                )
            except Exception as exc:  # noqa: BLE001
                detail = getattr(exc, "detail", None) or str(exc)
                await _mark_source_error(db, source, f"Import rejected: {detail}")
                await write_event(
                    db,
                    action="github_source.import_failed",
                    actor=None,
                    target_type="app",
                    target_id=app.id,
                    summary=f"Import from {source.repo} ({asset.release_tag}) rejected",
                    payload={"repo": source.repo, "tag": asset.release_tag, "error": detail},
                )
                await db.commit()
                return {"status": "error", "repo": source.repo, "error": detail}

            source.last_status = GithubSourceStatus.IMPORTED
            source.last_release_tag = asset.release_tag
            source.last_release_published_at = asset.release_published_at
            source.last_error = None

            # Retention enforcement — same hook as the manual upload
            # path so the worker can't grow an app unbounded by
            # cron-driven imports.
            from app.services.apk_eviction import evict_oldest_if_needed
            await evict_oldest_if_needed(db, app=app, actor_id=owner.id)

            await write_event(
                db,
                action="github_source.imported",
                actor=None,
                target_type="app",
                target_id=app.id,
                summary=(
                    f"Imported {asset.asset_name} from {source.repo} "
                    f"({asset.release_tag}) as versionCode {meta.version_code}"
                ),
                payload={
                    "repo": source.repo,
                    "tag": asset.release_tag,
                    "asset": asset.asset_name,
                    "version_code": meta.version_code,
                    "version_name": meta.version_name,
                },
            )
            await db.commit()
        finally:
            tmp_path.unlink(missing_ok=True)

    # Index rebuild outside of the DB transaction to keep the row commit
    # tight. Best-effort: a stale index gets refreshed on the next change.
    if apk.status == ApkStatus.PUBLISHED:
        await enqueue_reindex()

    return {
        "status": "imported",
        "repo": source.repo,
        "tag": asset.release_tag,
        "asset": asset.asset_name,
        "version_code": meta.version_code,
    }


async def _mark_source_error(db, source: GithubSource, message: str) -> None:
    """Record a failure on the source row. Caller commits."""
    source.last_status = GithubSourceStatus.ERROR
    source.last_error = (message or "")[:2000]
    source.last_scanned_at = datetime.now(UTC)


async def startup(ctx: dict) -> None:
    configure_logging()
    log.info("arq worker starting", redis=settings.redis_url)


async def shutdown(ctx: dict) -> None:
    log.info("arq worker shutting down")


from app.workers.backup_tasks import (
    cleanup_expired_backups,
    run_backup_job,
    run_restore_job,
)
from app.workers.cve_tasks import scan_apk_cve


class WorkerSettings:
    functions = [
        rebuild_index,
        scan_apks_periodic,
        scan_github_sources_periodic,
        fetch_github_source,
        # Admin backup feature — actual work runs out-of-band so the
        # API stays responsive on multi-GB repos. See
        # ``app/workers/backup_tasks.py`` for the per-task semantics.
        run_backup_job,
        run_restore_job,
        cleanup_expired_backups,
        # Per-APK SBOM + CVE scanning via trivy. Auto-enqueued when
        # an APK reaches PARSED; short-circuits when the feature is
        # disabled in RepoConfig.
        scan_apk_cve,
    ]
    # Run the rescan at 03:00 UTC every day. The function short-circuits
    # at the top when the feature is off, so leaving the cron registered
    # is safe even on deployments that never enable it.
    # GitHub scan runs at 04:00 UTC to spread the load away from clamav.
    # Backup cleanup runs hourly at :30 (off-peak vs. the scans above).
    cron_jobs = [
        cron(scan_apks_periodic, hour={3}, minute={0}, run_at_startup=False),
        cron(scan_github_sources_periodic, hour={4}, minute={0}, run_at_startup=False),
        cron(cleanup_expired_backups, minute={30}, run_at_startup=False),
    ]
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    on_startup = startup
    on_shutdown = shutdown
    # rebuild_index is dedup-coalesced by job_id at enqueue time, so we don't
    # need a high concurrency.
    max_jobs = 2
    # Backups on large repos can run for tens of minutes; bump the timeout
    # generously so a real-world repo finishes inside one job lifetime.
    # The cancel flag stays the operator's escape hatch for unresponsive runs.
    job_timeout = 3600
    # Keep finished-job results in Redis for 24h so the admin "Recent runs"
    # page survives restarts and idle periods. 30s (the prior value) made
    # the history vanish almost immediately after every run.
    keep_result = 86400
