from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class ApkScanStatus(str, enum.Enum):
    PENDING = "pending"   # queued, scanner not run yet
    CLEAN = "clean"       # scan completed, no signatures hit
    INFECTED = "infected" # at least one signature hit (see signatures column)
    ERROR = "error"       # scan errored out (clamd unreachable, parse error, …)


class ApkScan(Base, IdMixin, TimestampMixin):
    """A scanner pass over an APK file.

    One row per scan attempt — the table grows on each rescan, so we keep
    the timeline for audit. The *current* state of an APK is the most
    recent row for its ``apk_id`` (ORDER BY created_at DESC LIMIT 1).
    """

    __tablename__ = "apk_scans"

    apk_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("apks.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Scanner slug — ``clamav`` for now, room to add others (``virustotal``,
    # …) later without touching the schema.
    scanner: Mapped[str] = mapped_column(String(32), default="clamav", nullable=False)

    status: Mapped[ApkScanStatus] = mapped_column(
        Enum(ApkScanStatus, name="apk_scan_status"),
        default=ApkScanStatus.PENDING,
        nullable=False,
    )

    # Comma-joined signature names returned by the scanner on a hit. NULL
    # for clean / error states. Kept as Text so different scanners with
    # their own naming conventions all fit.
    signatures: Mapped[str | None] = mapped_column(Text)

    # Free-form last-line-of-output, populated on ERROR — useful for
    # debugging connectivity to clamd or a malformed APK.
    error: Mapped[str | None] = mapped_column(Text)

    # Wall-clock the scanner returned a verdict (or the error was raised).
    # Distinct from ``created_at`` (when the row was inserted), since for
    # async scans the two diverge.
    scanned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
