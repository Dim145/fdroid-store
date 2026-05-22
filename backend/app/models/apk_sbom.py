"""SBOM + CVE scan tracking, one ``ApkSbom`` row per Apk and one
``ApkCve`` row per vulnerability finding.

The actual scan lives in :mod:`app.workers.cve_tasks`; here we only
describe the persistent shape the API + UI consume.
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class ApkSbomStatus(str, enum.Enum):
    """Lifecycle of the per-APK SBOM scan.

    ``pending``   — row created but the worker hasn't picked it up.
    ``scanning``  — worker is running trivy.
    ``done``      — scan completed; ``cve_summary`` reflects the findings.
    ``failed``    — trivy returned an error; ``error_message`` holds it.
    ``skipped``   — feature was disabled when this row was created
                     (kept so a re-enable on the toggle has a row to
                     mark stale + re-enqueue).
    """

    PENDING = "pending"
    SCANNING = "scanning"
    DONE = "done"
    FAILED = "failed"
    SKIPPED = "skipped"


class ApkSeverity(str, enum.Enum):
    """Mirror Trivy / NVD ratings. ``UNKNOWN`` covers findings without
    a CVSS assignment yet."""

    UNKNOWN = "UNKNOWN"
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class ApkSbom(Base, IdMixin, TimestampMixin):
    __tablename__ = "apk_sboms"
    __table_args__ = (
        UniqueConstraint("apk_id", name="uq_apk_sboms_apk_id"),
    )

    apk_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("apks.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    status: Mapped[ApkSbomStatus] = mapped_column(
        String(16), default=ApkSbomStatus.PENDING, nullable=False, index=True
    )

    # Tool version recorded at scan time. Useful when a CVE comes back
    # negative on an old DB but positive on a refreshed one — the
    # admin can compare versions to know if a rescan would help.
    trivy_version: Mapped[str | None] = mapped_column(String(32))

    # CycloneDX (Trivy's default for our usage). Stored as JSONB so the
    # admin can grep it via PG operators without re-parsing.
    sbom_json: Mapped[dict | None] = mapped_column(JSONB)

    # Per-severity counts, pre-aggregated at scan time so the UI
    # doesn't have to fan-out a query of ``apk_cves`` for the chip
    # render. ``{"CRITICAL": 0, "HIGH": 2, …}`` shape.
    cve_summary: Mapped[dict | None] = mapped_column(JSONB)

    # Set on terminal states.
    scanned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_message: Mapped[str | None] = mapped_column(Text)

    apk = relationship("Apk")
    cves = relationship(
        "ApkCve",
        back_populates="sbom",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class ApkCve(Base, IdMixin, TimestampMixin):
    """Individual CVE finding within a SBOM scan.

    Trivy's output for a finding includes the CVE id, severity, the
    affected package (Maven coordinates for embedded JARs, library
    name for native libs), the fixed version when known, and a list
    of references (NVD, GitHub Advisory, etc.). We keep the original
    references as a JSONB list so a future UI redesign can pick
    whichever subset it wants.
    """

    __tablename__ = "apk_cves"

    sbom_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("apk_sboms.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    cve_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    severity: Mapped[ApkSeverity] = mapped_column(
        String(16), default=ApkSeverity.UNKNOWN, nullable=False, index=True
    )
    # CVSS v3 base score (0.0-10.0) when Trivy has one. Used by the UI
    # to sort findings of the same severity, and to surface ``cvss``
    # as an extra column.
    cvss_score: Mapped[float | None] = mapped_column()
    # Package + version that the scanner identified as vulnerable.
    package_name: Mapped[str | None] = mapped_column(String(256))
    installed_version: Mapped[str | None] = mapped_column(String(64))
    fixed_version: Mapped[str | None] = mapped_column(String(64))
    title: Mapped[str | None] = mapped_column(String(512))
    description: Mapped[str | None] = mapped_column(Text)
    # JSONB list of upstream advisory URLs. NULL when the scanner
    # didn't include any.
    references_json: Mapped[list | None] = mapped_column(JSONB)

    sbom = relationship("ApkSbom", back_populates="cves")
