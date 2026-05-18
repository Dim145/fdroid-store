from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.mixins import TimestampMixin


class PackageSignerPin(Base, TimestampMixin):
    """Permanent signer pinning per Android ``package_name``.

    The ``App.locked_signer_sha256`` column is good but it lives on the App
    row, so deleting the App (cascade-deletes apks, owner unlink…) also
    removes the signer pin. That opens a "delete + recreate" hijack: a
    different user re-registers the same package with a different signing
    certificate, and F-Droid clients (which pin signers per package) refuse
    to update. The store itself happily serves the new APK.

    This table keeps the pin keyed on the package_name *outside* the App
    lifecycle. Once a signer is locked here, no future App can register
    that package_name with a different signer — the upload is refused.
    """

    __tablename__ = "package_signers"

    # The package name *is* the primary key; one row per Android package.
    package_name: Mapped[str] = mapped_column(String(255), primary_key=True)

    # The pinned cert sha256 (lowercase hex).
    signer_sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    # Optional audit trail of which App row first locked this signer.
    locked_by_app_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("apps.id", ondelete="SET NULL"),
        nullable=True,
    )

    first_locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
