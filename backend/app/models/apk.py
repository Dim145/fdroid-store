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

    status: Mapped[ApkStatus] = mapped_column(
        Enum(ApkStatus, name="apk_status"),
        default=ApkStatus.UPLOADED,
        nullable=False,
    )
    rejection_reason: Mapped[str | None] = mapped_column(String(512))

    # Free-form release notes shown to users. Editable after upload via
    # PATCH /api/v1/apks/{id}. Surfaces as v2 ``versions.<sha>.whatsNew`` and
    # the v1 app-level ``localized.<locale>.whatsNew`` (for the latest one).
    whats_new: Mapped[str | None] = mapped_column(Text)

    uploaded_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    app = relationship("App", back_populates="apks")
