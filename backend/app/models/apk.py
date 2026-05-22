from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class ApkStatus(str, enum.Enum):
    UPLOADED = "uploaded"      # binary stored, not yet parsed
    PARSED = "parsed"          # metadata extracted
    PENDING_REVIEW = "pending_review"
    PUBLISHED = "published"
    REJECTED = "rejected"


class ReproducibilityStatus(str, enum.Enum):
    """Declarative + optionally-verified state of an APK's reproducibility.

    ``unknown``        — nobody's looked yet (default for new uploads).
    ``not_attempted``  — uploader / admin opted out (e.g. build chain
                          isn't deterministic by design).
    ``verified``       — SHA-256 of this APK matches the reference hash
                          the uploader / admin supplied.
    ``failed``         — comparison ran but the hash didn't match.

    The actual file hash is already on :attr:`Apk.sha256`; the reference
    is what we compare against. This matches the F-Droid Reproducible
    Builds workflow where the canonical source (often the F-Droid build
    server) publishes the expected hash and verifiers cross-check.
    """

    UNKNOWN = "unknown"
    NOT_ATTEMPTED = "not_attempted"
    VERIFIED = "verified"
    FAILED = "failed"
    DELETED = "deleted"


class Apk(Base, IdMixin, TimestampMixin):
    """A single APK binary attached to an :class:`App`.

    The storage layer holds the actual file; this row holds metadata extracted
    from the manifest plus the file's hash and storage location.
    """
    __tablename__ = "apks"
    __table_args__ = (
        UniqueConstraint("app_id", "version_code", name="uq_apk_app_version_code"),
        UniqueConstraint("sha256", name="uq_apk_sha256"),
    )

    app_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("apps.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # File on disk / S3
    storage_key: Mapped[str] = mapped_column(String(512), nullable=False)
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    # Extracted manifest fields
    version_code: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    version_name: Mapped[str] = mapped_column(String(128), nullable=False)
    min_sdk: Mapped[int | None] = mapped_column(Integer)
    target_sdk: Mapped[int | None] = mapped_column(Integer)
    max_sdk: Mapped[int | None] = mapped_column(Integer)

    # Signing certificate of the APK itself (different from the repo signing
    # key). Stored to detect package-name hijacking attempts.
    signer_sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    # JSON-serialized lists. We keep these as JSON columns so SQL stays simple;
    # F-Droid index generation reads them back as-is.
    permissions: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    features: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    native_code: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    locales: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    # F-Droid anti-features (NonFreeNet, NonFreeAdd, KnownVuln, Tracking, …).
    # Surfaced as warnings in F-Droid clients. Edited by admins, not extracted
    # from the APK itself. Empty list = no flags. We could attach a reason
    # string per flag (the v2 spec allows it) but admins overwhelmingly leave
    # those empty in practice, so we keep this simple.
    anti_features: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)

    status: Mapped[ApkStatus] = mapped_column(
        Enum(ApkStatus, name="apk_status"),
        default=ApkStatus.UPLOADED,
        nullable=False,
    )
    rejection_reason: Mapped[str | None] = mapped_column(String(512))

    # Release notes shown to users, keyed by BCP47 locale. Editable after
    # upload via PATCH /api/v1/apks/{id}. Surfaces as v2
    # ``versions.<sha>.whatsNew`` (the dict shape the spec expects) and the
    # v1 app-level ``localized.<locale>.whatsNew`` block, where every locale
    # in the dict gets its own entry on the highest-versionCode APK that
    # has notes. Empty dict and NULL are equivalent — both mean "no notes".
    whats_new: Mapped[dict | None] = mapped_column(JSON)

    uploaded_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # ------------------------------------------------------------------
    # Reproducible Builds tracking
    # ------------------------------------------------------------------
    # Per-APK status (see ReproducibilityStatus). Default ``UNKNOWN`` so
    # legacy rows pre-dating this column show up as "not yet checked"
    # rather than as a positive claim of any kind.
    reproducibility_status: Mapped[ReproducibilityStatus] = mapped_column(
        String(16),
        default=ReproducibilityStatus.UNKNOWN,
        nullable=False,
        index=True,
    )
    # Lowercase hex SHA-256 of the reference build (typically published
    # by the upstream F-Droid build farm, or by the developer's CI).
    # ``apk.sha256`` is the hash of *our* upload; comparing the two is
    # how ``VERIFIED`` is decided. NULL = no reference recorded yet.
    reproducibility_reference_sha256: Mapped[str | None] = mapped_column(String(64))
    # Optional pointer to where the reference was sourced — typically
    # a URL of the upstream F-Droid hash file or a CI artifact. Bound
    # to http/https schemes on the API side; the column itself accepts
    # any short string so we can store a free-form descriptor.
    reproducibility_reference_url: Mapped[str | None] = mapped_column(String(512))
    # When the last comparison / declaration happened. NULL until the
    # first time the status is set explicitly.
    reproducibility_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    # Free-form notes (e.g. "Build server differs in dx timestamps,
    # ignoring"). Capped so the column stays sortable + indexable.
    reproducibility_notes: Mapped[str | None] = mapped_column(String(1000))

    app = relationship("App", back_populates="apks")
