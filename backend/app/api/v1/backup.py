"""Admin backup + restore endpoints (mounted under ``/admin/backup``).

The heavy work runs out-of-band on the arq worker (see
:mod:`app.workers.backup_tasks`). These endpoints just enqueue jobs,
list them, surface progress, and stream the finished file back to the
admin when ready.

Endpoints
---------

POST   /admin/backup                          — kick off a new backup
POST   /admin/backup/restore                  — kick off a restore (multipart upload)
GET    /admin/backup/jobs                     — list the 20 most recent jobs
GET    /admin/backup/jobs/{id}                — single-job status (UI polls)
POST   /admin/backup/jobs/{id}/cancel         — cancel a backup mid-run
GET    /admin/backup/jobs/{id}/download       — stream the ready file, mark consumed
"""
from __future__ import annotations

import logging
import shutil
import tempfile
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any

from arq import create_pool
from arq.connections import RedisSettings
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import desc, select

import json

from app.api.deps import DbSession, get_current_admin
from app.core.config import settings
from app.models.backup_job import BackupJob, BackupJobKind, BackupJobStatus
from app.models.user import User
from app.services.audit import write_event
from app.services.backup import ALL_COMPONENTS
from app.services.crypto import encrypt as fernet_encrypt

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
BACKUP_TTL = timedelta(hours=24)
HISTORY_LIMIT = 20


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class BackupCreateRequest(BaseModel):
    passphrase: str = Field(min_length=12, max_length=512)
    # Subset of {"db", "keystore", "assets", "apks"}. Empty list →
    # "default to all" (treated as the unrestricted backup). Anything
    # outside the known set is filtered out below.
    components: list[str] = Field(default_factory=list)


class JobRead(BaseModel):
    id: str
    kind: str
    status: str
    phase: str | None = None
    progress_pct: int
    created_at: str
    started_at: str | None = None
    completed_at: str | None = None
    expires_at: str | None = None
    error_message: str | None = None
    result_summary: dict[str, Any] | None = None
    file_size: int | None = None
    created_by_username: str | None = None
    cancellable: bool = False
    downloadable: bool = False
    components: list[str] = []


class JobListResponse(BaseModel):
    items: list[JobRead]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
async def _enqueue(name: str, *args: Any, job_id: str | None = None) -> None:
    """Enqueue an arq job. Wrapping the pool open/close here keeps the
    endpoint code terse and stops a pool-creation failure from masking
    the actual error."""
    pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
    try:
        await pool.enqueue_job(name, *args, _job_id=job_id)
    finally:
        await pool.close()


def _serialize(job: BackupJob, *, created_by_username: str | None = None) -> JobRead:
    status = (
        job.status.value if hasattr(job.status, "value") else str(job.status)
    )
    kind = job.kind.value if hasattr(job.kind, "value") else str(job.kind)
    cancellable = (
        kind == BackupJobKind.BACKUP.value
        and status in (BackupJobStatus.PENDING.value, BackupJobStatus.RUNNING.value)
    )
    downloadable = (
        kind == BackupJobKind.BACKUP.value
        and status == BackupJobStatus.READY.value
        and bool(job.file_path)
    )
    try:
        components = json.loads(job.components_json or "[]")
        if not isinstance(components, list):
            components = []
    except Exception:  # noqa: BLE001
        components = []
    return JobRead(
        id=str(job.id),
        kind=kind,
        status=status,
        phase=job.phase,
        progress_pct=int(job.progress_pct or 0),
        created_at=job.created_at.isoformat(),
        started_at=job.started_at.isoformat() if job.started_at else None,
        completed_at=job.completed_at.isoformat() if job.completed_at else None,
        expires_at=job.expires_at.isoformat() if job.expires_at else None,
        error_message=job.error_message,
        result_summary=job.result_summary,
        file_size=job.file_size,
        created_by_username=created_by_username,
        cancellable=cancellable,
        downloadable=downloadable,
        components=components,
    )


def _normalise_components(raw: list[str]) -> list[str]:
    """Whittle a user-supplied list down to known components, preserving
    insertion order for the audit trail but stripping duplicates."""
    out: list[str] = []
    seen: set[str] = set()
    for c in raw:
        if c in ALL_COMPONENTS and c not in seen:
            out.append(c)
            seen.add(c)
    return out


async def _another_in_flight(db: Any) -> BackupJob | None:
    """Returns the existing pending/running job if any. Concurrency
    policy is hard-refusal: a 409 with the existing job_id is more
    actionable than silently queueing."""
    row = (
        await db.execute(
            select(BackupJob)
            .where(
                BackupJob.status.in_(
                    [
                        BackupJobStatus.PENDING.value,
                        BackupJobStatus.RUNNING.value,
                    ]
                )
            )
            .order_by(desc(BackupJob.created_at))
            .limit(1)
        )
    ).scalar_one_or_none()
    return row


# ---------------------------------------------------------------------------
# POST /admin/backup
# ---------------------------------------------------------------------------
@router.post("", response_model=JobRead, status_code=status.HTTP_202_ACCEPTED)
async def create_backup(
    payload: BackupCreateRequest,
    db: DbSession,
    admin: Annotated[User, Depends(get_current_admin)],
) -> JobRead:
    in_flight = await _another_in_flight(db)
    if in_flight is not None:
        # 409 carries the existing job id so the SPA can jump straight
        # to its progress view without re-querying.
        raise HTTPException(
            status_code=409,
            detail={
                "code": "backup_in_flight",
                "job_id": str(in_flight.id),
                "kind": in_flight.kind.value if hasattr(in_flight.kind, "value") else str(in_flight.kind),
            },
        )

    selected = _normalise_components(payload.components) or sorted(ALL_COMPONENTS)
    now = datetime.now(UTC)
    job = BackupJob(
        kind=BackupJobKind.BACKUP,
        status=BackupJobStatus.PENDING,
        phase="queued",
        progress_pct=0,
        created_by_id=admin.id,
        expires_at=now + BACKUP_TTL,
        passphrase_encrypted=fernet_encrypt(payload.passphrase),
        components_json=json.dumps(sorted(selected)),
    )
    db.add(job)
    await write_event(
        db,
        action="backup.enqueued",
        actor=admin,
        target_type="backup_job",
        target_id=job.id,
        summary="backup job enqueued",
    )
    await db.commit()
    await db.refresh(job)

    try:
        await _enqueue("run_backup_job", str(job.id))
    except Exception as exc:  # noqa: BLE001
        logger.warning("could not enqueue backup job, marking failed", exc_info=exc)
        job.status = BackupJobStatus.FAILED
        job.phase = "failed"
        job.error_message = f"queue unreachable: {exc}"
        job.completed_at = datetime.now(UTC)
        job.passphrase_encrypted = None
        await db.commit()

    return _serialize(job, created_by_username=admin.username)


# ---------------------------------------------------------------------------
# POST /admin/backup/restore
# ---------------------------------------------------------------------------
@router.post("/restore", response_model=JobRead, status_code=status.HTTP_202_ACCEPTED)
async def create_restore(
    db: DbSession,
    admin: Annotated[User, Depends(get_current_admin)],
    file: Annotated[UploadFile, File(description="Encrypted backup tarball")],
    passphrase: Annotated[str, Form(min_length=1, max_length=512)],
    confirm: Annotated[str, Form()] = "",
    # Repeated form field: ``components=db&components=apks``. FastAPI's
    # Form binding hands us a list directly. Empty → restore everything
    # the manifest contains.
    components: Annotated[list[str], Form()] = [],  # noqa: B006
) -> JobRead:
    if confirm != "RESTORE":
        raise HTTPException(
            status_code=400,
            detail="Restore confirmation token missing. Set the 'confirm' field to 'RESTORE'.",
        )
    in_flight = await _another_in_flight(db)
    if in_flight is not None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "backup_in_flight",
                "job_id": str(in_flight.id),
                "kind": in_flight.kind.value if hasattr(in_flight.kind, "value") else str(in_flight.kind),
            },
        )

    # Spool the upload to disk so the worker can seek through it later.
    jobs_dir = Path(settings.backup_tmp_dir) / "jobs"
    jobs_dir.mkdir(parents=True, exist_ok=True)
    job_id = uuid.uuid4()
    upload_path = jobs_dir / f"{job_id}.upload.enc"
    try:
        with open(upload_path, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
    except Exception as exc:  # noqa: BLE001
        upload_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"upload failed: {exc}") from exc

    selected = _normalise_components(components)
    # For restore, an empty selection means "apply everything in the manifest".
    # We persist an empty list to signal that.
    now = datetime.now(UTC)
    job = BackupJob(
        id=job_id,
        kind=BackupJobKind.RESTORE,
        status=BackupJobStatus.PENDING,
        phase="queued",
        progress_pct=0,
        created_by_id=admin.id,
        expires_at=now + BACKUP_TTL,
        upload_path=str(upload_path),
        passphrase_encrypted=fernet_encrypt(passphrase),
        components_json=json.dumps(sorted(selected)),
    )
    db.add(job)
    await write_event(
        db,
        action="backup.restore_enqueued",
        actor=admin,
        target_type="backup_job",
        target_id=job.id,
        summary="restore job enqueued",
    )
    await db.commit()
    await db.refresh(job)

    try:
        await _enqueue("run_restore_job", str(job.id))
    except Exception as exc:  # noqa: BLE001
        logger.warning("could not enqueue restore job, marking failed", exc_info=exc)
        job.status = BackupJobStatus.FAILED
        job.phase = "failed"
        job.error_message = f"queue unreachable: {exc}"
        job.completed_at = datetime.now(UTC)
        job.passphrase_encrypted = None
        await db.commit()

    return _serialize(job, created_by_username=admin.username)


# ---------------------------------------------------------------------------
# GET /admin/backup/jobs — recent history
# ---------------------------------------------------------------------------
@router.get("/jobs", response_model=JobListResponse)
async def list_jobs(
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> JobListResponse:
    rows = (
        await db.execute(
            select(BackupJob, User.username)
            .outerjoin(User, BackupJob.created_by_id == User.id)
            .order_by(desc(BackupJob.created_at))
            .limit(HISTORY_LIMIT)
        )
    ).all()
    items = [_serialize(j, created_by_username=u) for (j, u) in rows]
    return JobListResponse(items=items)


# ---------------------------------------------------------------------------
# GET /admin/backup/jobs/{id} — single job (UI polls)
# ---------------------------------------------------------------------------
@router.get("/jobs/{job_id}", response_model=JobRead)
async def get_job(
    job_id: uuid.UUID,
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> JobRead:
    row = (
        await db.execute(
            select(BackupJob, User.username)
            .outerjoin(User, BackupJob.created_by_id == User.id)
            .where(BackupJob.id == job_id)
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="job not found")
    job, username = row
    return _serialize(job, created_by_username=username)


# ---------------------------------------------------------------------------
# POST /admin/backup/jobs/{id}/cancel
# ---------------------------------------------------------------------------
@router.post("/jobs/{job_id}/cancel", response_model=JobRead)
async def cancel_job(
    job_id: uuid.UUID,
    db: DbSession,
    admin: Annotated[User, Depends(get_current_admin)],
) -> JobRead:
    job = (
        await db.execute(select(BackupJob).where(BackupJob.id == job_id))
    ).scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    if job.kind != BackupJobKind.BACKUP and (
        not hasattr(job.kind, "value") or job.kind.value != "backup"
    ):
        # Restores are non-cancellable mid-flight (DB wipe + dump apply is
        # not a safely-interruptible operation).
        raise HTTPException(
            status_code=400, detail="restore jobs cannot be cancelled mid-run"
        )
    if job.status not in (BackupJobStatus.PENDING, BackupJobStatus.RUNNING) and (
        not hasattr(job.status, "value")
        or job.status.value not in ("pending", "running")
    ):
        raise HTTPException(
            status_code=400, detail=f"job is already in state {job.status}"
        )
    job.cancel_requested = True
    await write_event(
        db,
        action="backup.cancel_requested",
        actor=admin,
        target_type="backup_job",
        target_id=job.id,
        summary="admin requested backup cancel",
    )
    await db.commit()
    await db.refresh(job)
    return _serialize(job, created_by_username=admin.username)


# ---------------------------------------------------------------------------
# GET /admin/backup/jobs/{id}/download
# ---------------------------------------------------------------------------
@router.get("/jobs/{job_id}/download")
async def download_job(
    job_id: uuid.UUID,
    db: DbSession,
    admin: Annotated[User, Depends(get_current_admin)],
):
    job = (
        await db.execute(select(BackupJob).where(BackupJob.id == job_id))
    ).scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    status_val = job.status.value if hasattr(job.status, "value") else str(job.status)
    if status_val != "ready":
        raise HTTPException(
            status_code=400,
            detail=f"job is not ready for download (state={status_val})",
        )
    if not job.file_path or not Path(job.file_path).is_file():
        raise HTTPException(status_code=410, detail="backup file has been cleaned up")

    # Filename embeds the repo id and creation timestamp — visible in the
    # admin's download manager so multiple backups don't collide.
    created = job.created_at.strftime("%Y-%m-%d-%H%M%S")
    filename = f"fdroid-store-backup-{created}-{str(job.id)[:8]}.tar.enc"

    # Mark the row downloaded synchronously so a parallel request can't
    # also pull the file before cleanup. The actual file removal happens
    # after the response is sent — schedule it via FastAPI's BackgroundTasks
    # so the client receives the body in full first.
    file_path = job.file_path
    job.status = BackupJobStatus.DOWNLOADED  # type: ignore[assignment]
    job.phase = "downloaded"
    job.completed_at = datetime.now(UTC)
    job.file_path = None
    await write_event(
        db,
        action="backup.downloaded",
        actor=admin,
        target_type="backup_job",
        target_id=job.id,
        summary="backup file downloaded by admin",
    )
    await db.commit()

    def _cleanup() -> None:
        try:
            Path(file_path).unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass

    response = FileResponse(
        path=file_path,
        media_type="application/octet-stream",
        filename=filename,
        headers={"Content-Encoding": "identity"},
    )
    # FileResponse's BackgroundTask attribute runs after the response is
    # fully sent. Use it for the unlink so the client always gets the
    # bytes before we delete.
    from starlette.background import BackgroundTask

    response.background = BackgroundTask(_cleanup)
    return response
