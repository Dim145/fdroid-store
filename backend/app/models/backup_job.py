"""Backup / restore job tracking row.

One row per long-running admin backup or restore operation. Rather than
running these jobs synchronously inside the request handler — where a
multi-GB tarball would hold an HTTP request open for minutes and starve
the uvicorn worker pool — we enqueue the work on arq and return a
``job_id``. The SPA polls this row for progress; the worker updates
``phase`` + ``progress_pct`` at each major step.

Lifecycle (kind = ``backup``)::

    pending → running ↘
                        ready ──(GET /download)──→ downloaded
                       ↗
              cancelled (only while not yet ``ready``)
              failed (with ``error_message``)

Lifecycle (kind = ``restore``)::

    pending → running → done
                       ↘
                         failed

The ``passphrase_encrypted`` column carries the user's passphrase from
the API process to the worker process, encrypted at rest with the app's
Fernet key (same primitive used for per-source PATs). It's nulled out
as soon as the worker no longer needs it (right after the encryption /
decryption step) so a stolen DB dump can't replay the passphrase.
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class BackupJobKind(str, enum.Enum):
    BACKUP = "backup"
    RESTORE = "restore"


class BackupJobStatus(str, enum.Enum):
    PENDING = "pending"      # enqueued, worker hasn't picked it up
    RUNNING = "running"      # worker is mid-execution
    READY = "ready"          # backup only: tarball produced, waiting download
    DOWNLOADED = "downloaded"  # backup only: download consumed, file cleaned up
    DONE = "done"            # restore only: applied successfully
    FAILED = "failed"        # ran but error_message is set
    CANCELLED = "cancelled"  # backup only: admin pressed cancel mid-run


class BackupJob(Base, IdMixin, TimestampMixin):
    __tablename__ = "backup_jobs"

    kind: Mapped[BackupJobKind] = mapped_column(
        String(16), nullable=False, index=True
    )

    status: Mapped[BackupJobStatus] = mapped_column(
        String(16), nullable=False, default=BackupJobStatus.PENDING, index=True
    )

    # Free-form phase label (``"pg_dump"``, ``"tar"``, ``"encrypting"``,
    # ``"decrypting"``, ``"applying_db"``, …) so the UI can render
    # something more descriptive than just "running 47%".
    phase: Mapped[str | None] = mapped_column(String(64))

    # 0-100 integer for the progress bar. Coarse — most phases are
    # either atomic or hard to measure (pg_dump is a black-box stream),
    # so the worker bumps the value at phase boundaries rather than
    # trying to track byte counts inside each phase.
    progress_pct: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # Admin who triggered the job. ``ondelete='SET NULL'`` so deleting
    # the user later doesn't wipe the audit trail.
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
    )

    # Backup output file (kind=backup only). Lives under
    # ``settings.backup_tmp_dir/jobs/<id>.tar.enc``. Nulled when the
    # cleanup job removes the file.
    file_path: Mapped[str | None] = mapped_column(String(512))
    file_size: Mapped[int | None] = mapped_column(BigInteger)

    # Restore source file (kind=restore only). The endpoint spools the
    # uploaded body to disk so the worker can seek through it later.
    # Same nulling rule as ``file_path``.
    upload_path: Mapped[str | None] = mapped_column(String(512))

    # When the file ceases to be available. For backups this is
    # ``created_at + 24h``; for restores it's the same — both files
    # get pruned at the same TTL.
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # End-state details. Populated on terminal states (DONE / READY /
    # FAILED). Restore stashes the manifest summary here too.
    error_message: Mapped[str | None] = mapped_column(Text)
    result_summary: Mapped[dict | None] = mapped_column(JSONB)

    # Cancel signalling. The worker polls this between each major step;
    # if True at the next checkpoint, it aborts cleanly. Restores ignore
    # this flag — they're not safely cancellable once the DB wipe has
    # started.
    cancel_requested: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )

    # Passphrase the worker needs to encrypt/decrypt. Stored Fernet-
    # encrypted with the app secret_key so a stolen DB dump alone can't
    # replay it. NULL after the crypto step — only the file ciphertext
    # is needed beyond that point.
    passphrase_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary)

    # Selected component subset as JSON list (``["db", "apks", …]``).
    # Default = all components. Persisted so the history view can
    # render the per-job selection as chips, and so a restore knows
    # what the user actually asked for.
    components_json: Mapped[str] = mapped_column(
        String(256), default='["apks","assets","db","keystore"]', nullable=False
    )
