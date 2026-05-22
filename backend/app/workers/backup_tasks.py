"""arq tasks for the admin Backup / Restore feature.

Each task corresponds to one row of ``backup_jobs``. The API handler
creates the row (status=PENDING) + enqueues the task; the worker picks
it up, runs the heavy lifting, and persists progress + final state
back to the row.

Three tasks live here:

* :func:`run_backup_job`     — builds + encrypts the tarball
* :func:`run_restore_job`    — decrypts + applies a backup
* :func:`cleanup_expired_backups` — hourly cron that prunes files past
                                     their TTL and marks the rows
                                     ``DOWNLOADED`` (so the UI can hide
                                     the download button gracefully)
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select, update

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.models.backup_job import BackupJob, BackupJobKind, BackupJobStatus
from app.services.backup import (
    ALL_COMPONENTS,
    BackupError,
    build_and_encrypt,
    decrypt_and_apply,
)
from app.services.crypto import decrypt as fernet_decrypt

log = get_logger(__name__)


def _job_file_path(job_id: uuid.UUID) -> Path:
    """Disk location of a backup output file. We tuck them under a
    ``jobs/`` subdir of the backup temp volume so the cleanup cron
    can scan a single directory."""
    parent = Path(settings.backup_tmp_dir) / "jobs"
    parent.mkdir(parents=True, exist_ok=True)
    return parent / f"{job_id}.tar.enc"


async def _set_job_state(
    job_id: uuid.UUID,
    *,
    status: BackupJobStatus | None = None,
    phase: str | None = None,
    progress_pct: int | None = None,
    file_path: str | None = None,
    file_size: int | None = None,
    upload_path: str | None = None,
    error_message: str | None = None,
    result_summary: dict | None = None,
    started_at: datetime | None = None,
    completed_at: datetime | None = None,
    clear_passphrase: bool = False,
) -> None:
    """Atomic-ish DB update keyed on ``job_id``. Each progress tick goes
    through here so the UI's poll endpoint sees current state."""
    values: dict = {}
    if status is not None:
        values["status"] = status
    if phase is not None:
        values["phase"] = phase
    if progress_pct is not None:
        values["progress_pct"] = progress_pct
    if file_path is not None:
        values["file_path"] = file_path
    if file_size is not None:
        values["file_size"] = file_size
    if upload_path is not None:
        values["upload_path"] = upload_path
    if error_message is not None:
        values["error_message"] = error_message
    if result_summary is not None:
        values["result_summary"] = result_summary
    if started_at is not None:
        values["started_at"] = started_at
    if completed_at is not None:
        values["completed_at"] = completed_at
    if clear_passphrase:
        values["passphrase_encrypted"] = None
    if not values:
        return
    async with SessionLocal() as db:
        await db.execute(
            update(BackupJob).where(BackupJob.id == job_id).values(**values)
        )
        await db.commit()


async def _is_cancelled(job_id: uuid.UUID) -> bool:
    async with SessionLocal() as db:
        row = (
            await db.execute(
                select(BackupJob.cancel_requested).where(BackupJob.id == job_id)
            )
        ).scalar_one_or_none()
    return bool(row)


def _make_progress_cb(job_id: uuid.UUID, loop: asyncio.AbstractEventLoop):
    """Bridge between the sync worker-thread calls inside
    :func:`build_and_encrypt` / :func:`decrypt_and_apply` and the async
    DB updates. Uses ``run_coroutine_threadsafe`` so the callback can
    fire from any thread the executor schedules it on."""

    def cb(phase: str, pct: int) -> None:
        fut = asyncio.run_coroutine_threadsafe(
            _set_job_state(job_id, phase=phase, progress_pct=pct),
            loop,
        )
        try:
            fut.result(timeout=10)
        except Exception as exc:  # noqa: BLE001
            log.warning("progress update failed", error=str(exc))

    return cb


def _make_cancel_cb(job_id: uuid.UUID, loop: asyncio.AbstractEventLoop):
    def cb() -> bool:
        fut = asyncio.run_coroutine_threadsafe(_is_cancelled(job_id), loop)
        try:
            return fut.result(timeout=5)
        except Exception:  # noqa: BLE001
            return False

    return cb


# ---------------------------------------------------------------------------
# Backup
# ---------------------------------------------------------------------------
async def run_backup_job(ctx: dict, job_id: str) -> dict:
    """Worker entry-point for the backup pipeline. Reads the job row,
    pulls the encrypted passphrase + repo metadata, runs the build,
    persists progress + final state."""
    jid = uuid.UUID(job_id)
    loop = asyncio.get_running_loop()

    async with SessionLocal() as db:
        row = (await db.execute(select(BackupJob).where(BackupJob.id == jid))).scalar_one_or_none()
        if row is None:
            log.warning("backup job vanished before pickup", job_id=job_id)
            return {"ok": False, "reason": "missing"}
        if row.status not in (BackupJobStatus.PENDING, BackupJobStatus.RUNNING):
            log.info("backup job not in startable state", job_id=job_id, status=row.status)
            return {"ok": False, "reason": "not_startable"}

        passphrase = fernet_decrypt(row.passphrase_encrypted) if row.passphrase_encrypted else None
        if not passphrase:
            await _set_job_state(
                jid,
                status=BackupJobStatus.FAILED,
                phase="failed",
                progress_pct=0,
                error_message="passphrase missing or unreadable (secret_key rotated?)",
                completed_at=datetime.now(UTC),
                clear_passphrase=True,
            )
            return {"ok": False, "reason": "passphrase"}

        from app.models.repo_config import RepoConfig

        repo = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
        repo_id = str(repo.id) if repo else "repo"

    backend_version = _backend_version_str()
    out_path = _job_file_path(jid)

    # Components live on the row as JSON; an old row (or a corrupt one)
    # falls back to "all" so a glitchy upgrade can't accidentally produce
    # an empty backup.
    try:
        import json as _json

        wanted = set(_json.loads(row.components_json) or list(ALL_COMPONENTS))
    except Exception:  # noqa: BLE001
        wanted = set(ALL_COMPONENTS)
    components = (wanted & set(ALL_COMPONENTS)) or set(ALL_COMPONENTS)

    await _set_job_state(
        jid,
        status=BackupJobStatus.RUNNING,
        phase="starting",
        progress_pct=1,
        started_at=datetime.now(UTC),
    )

    progress = _make_progress_cb(jid, loop)
    cancelled = _make_cancel_cb(jid, loop)

    def runner() -> None:
        build_and_encrypt(
            passphrase=passphrase,
            out_path=out_path,
            repo_id=repo_id,
            backend_version=backend_version,
            components=components,
            progress=progress,
            cancelled=cancelled,
        )

    try:
        await loop.run_in_executor(None, runner)
    except BackupError as exc:
        if str(exc) == "__CANCELLED__":
            await _set_job_state(
                jid,
                status=BackupJobStatus.CANCELLED,
                phase="cancelled",
                completed_at=datetime.now(UTC),
                clear_passphrase=True,
            )
            return {"ok": False, "cancelled": True}
        await _set_job_state(
            jid,
            status=BackupJobStatus.FAILED,
            phase="failed",
            error_message=str(exc)[:1000],
            completed_at=datetime.now(UTC),
            clear_passphrase=True,
        )
        log.warning("backup failed", job_id=job_id, error=str(exc))
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        await _set_job_state(
            jid,
            status=BackupJobStatus.FAILED,
            phase="failed",
            error_message=str(exc)[:1000],
            completed_at=datetime.now(UTC),
            clear_passphrase=True,
        )
        log.exception("backup failed unexpectedly", job_id=job_id)
        return {"ok": False, "error": str(exc)}

    size = out_path.stat().st_size if out_path.exists() else 0
    await _set_job_state(
        jid,
        status=BackupJobStatus.READY,
        phase="ready",
        progress_pct=100,
        file_path=str(out_path),
        file_size=size,
        completed_at=datetime.now(UTC),
        clear_passphrase=True,
    )
    return {"ok": True, "file_size": size}


# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------
async def run_restore_job(ctx: dict, job_id: str) -> dict:
    jid = uuid.UUID(job_id)
    loop = asyncio.get_running_loop()

    async with SessionLocal() as db:
        row = (await db.execute(select(BackupJob).where(BackupJob.id == jid))).scalar_one_or_none()
        if row is None:
            log.warning("restore job vanished before pickup", job_id=job_id)
            return {"ok": False, "reason": "missing"}
        passphrase = fernet_decrypt(row.passphrase_encrypted) if row.passphrase_encrypted else None
        upload_path = Path(row.upload_path) if row.upload_path else None

    if not passphrase or not upload_path or not upload_path.exists():
        await _set_job_state(
            jid,
            status=BackupJobStatus.FAILED,
            phase="failed",
            error_message="upload missing or passphrase unreadable",
            completed_at=datetime.now(UTC),
            clear_passphrase=True,
        )
        return {"ok": False, "reason": "input"}

    # Components for restore come from the row too (same JSON format).
    # Empty / corrupt → restore all that the manifest contains.
    try:
        import json as _json

        wanted_restore = set(_json.loads(row.components_json) or list(ALL_COMPONENTS))
    except Exception:  # noqa: BLE001
        wanted_restore = set(ALL_COMPONENTS)
    restore_components = wanted_restore & set(ALL_COMPONENTS) or None

    await _set_job_state(
        jid,
        status=BackupJobStatus.RUNNING,
        phase="starting",
        progress_pct=1,
        started_at=datetime.now(UTC),
    )

    progress = _make_progress_cb(jid, loop)

    def runner() -> dict:
        return decrypt_and_apply(
            src_encrypted=upload_path,
            passphrase=passphrase,
            components=restore_components,
            progress=progress,
        )

    try:
        summary = await loop.run_in_executor(None, runner)
    except BackupError as exc:
        await _set_job_state(
            jid,
            status=BackupJobStatus.FAILED,
            phase="failed",
            error_message=str(exc)[:1000],
            completed_at=datetime.now(UTC),
            clear_passphrase=True,
        )
        log.warning("restore failed", job_id=job_id, error=str(exc))
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        await _set_job_state(
            jid,
            status=BackupJobStatus.FAILED,
            phase="failed",
            error_message=str(exc)[:1000],
            completed_at=datetime.now(UTC),
            clear_passphrase=True,
        )
        log.exception("restore failed unexpectedly", job_id=job_id)
        return {"ok": False, "error": str(exc)}

    # Upload file isn't needed past here. Drop it now so the cleanup
    # cron has less to do, and so a failed-then-rerun cycle doesn't
    # reapply the same body.
    try:
        upload_path.unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        pass

    await _set_job_state(
        jid,
        status=BackupJobStatus.DONE,
        phase="done",
        progress_pct=100,
        result_summary=summary,
        completed_at=datetime.now(UTC),
        clear_passphrase=True,
        upload_path="",  # we removed the file
    )
    return {"ok": True, "summary": summary}


# ---------------------------------------------------------------------------
# Cleanup cron
# ---------------------------------------------------------------------------
async def cleanup_expired_backups(ctx: dict) -> dict:
    """Hourly job:

    * remove backup output files past ``expires_at`` + mark their rows
      DOWNLOADED so the UI hides the download button gracefully
    * mark rows stuck in PENDING / RUNNING for > 2 hours as FAILED
      (handles worker crashes mid-job AND rows brought back to life
      by a restore — these never advance because no live worker owns
      them)
    * orphan-clean any ``backup-tmp/jobs`` files without a DB row
    """
    from datetime import timedelta as _timedelta

    removed_files = 0
    marked_rows = 0
    stuck_rows = 0
    now = datetime.now(UTC)

    # Stuck-job recovery first — flipping these to FAILED lets the next
    # admin enqueue request through (the 409 check rejects on
    # pending/running) and unblocks the UI.
    stuck_threshold = now - _timedelta(hours=2)
    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(BackupJob).where(
                    BackupJob.status.in_(
                        [BackupJobStatus.PENDING.value, BackupJobStatus.RUNNING.value]
                    ),
                    BackupJob.created_at <= stuck_threshold,
                )
            )
        ).scalars().all()
        for row in rows:
            row.status = BackupJobStatus.FAILED  # type: ignore[assignment]
            row.phase = "stuck"
            row.error_message = (
                "job stuck — worker likely crashed or row was restored from an "
                "older backup. Re-enqueue if needed."
            )
            row.completed_at = now
            row.passphrase_encrypted = None
            stuck_rows += 1
        if stuck_rows:
            await db.commit()

    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(BackupJob).where(
                    BackupJob.expires_at.is_not(None),
                    BackupJob.expires_at <= now,
                    BackupJob.status.in_(
                        [
                            BackupJobStatus.READY.value,
                            BackupJobStatus.DONE.value,
                            BackupJobStatus.FAILED.value,
                            BackupJobStatus.CANCELLED.value,
                        ]
                    ),
                )
            )
        ).scalars().all()
        for row in rows:
            if row.file_path:
                try:
                    Path(row.file_path).unlink(missing_ok=True)
                    removed_files += 1
                except Exception:  # noqa: BLE001
                    pass
                row.file_path = None
                if row.status == BackupJobStatus.READY:
                    row.status = BackupJobStatus.DOWNLOADED  # type: ignore[assignment]
                    marked_rows += 1
            if row.upload_path:
                try:
                    Path(row.upload_path).unlink(missing_ok=True)
                    removed_files += 1
                except Exception:  # noqa: BLE001
                    pass
                row.upload_path = None
        await db.commit()

    # Orphan files (no row points at them — e.g. crash mid-write).
    jobs_dir = Path(settings.backup_tmp_dir) / "jobs"
    if jobs_dir.is_dir():
        async with SessionLocal() as db:
            known = {
                str(r) for r in (
                    await db.execute(
                        select(BackupJob.file_path).where(BackupJob.file_path.is_not(None))
                    )
                ).scalars().all()
            } | {
                str(r) for r in (
                    await db.execute(
                        select(BackupJob.upload_path).where(BackupJob.upload_path.is_not(None))
                    )
                ).scalars().all()
            }
        for path in jobs_dir.iterdir():
            if not path.is_file():
                continue
            if str(path) in known:
                continue
            # Belt-and-braces: only remove files older than 24 h so we
            # don't kill an in-flight write. ``st_mtime`` is the right
            # signal — the file is rewritten only at job completion.
            try:
                mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
            except Exception:  # noqa: BLE001
                continue
            if (now - mtime).total_seconds() < 24 * 3600:
                continue
            try:
                path.unlink()
                removed_files += 1
            except Exception:  # noqa: BLE001
                pass

    return {
        "removed_files": removed_files,
        "marked_rows": marked_rows,
        "stuck_rows": stuck_rows,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _backend_version_str() -> str:
    try:
        from importlib.metadata import version as _v

        return _v("fdroid-store-backend")
    except Exception:  # noqa: BLE001
        return "unknown"
