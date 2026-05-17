from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class InviteCode(Base, IdMixin, TimestampMixin):
    """Single-use invitation token that unlocks signup when the repo's
    registration policy is ``invite``.

    Codes are admin-generated, persist until consumed (or until ``expires_at``
    if set), and are deleted on revoke. We keep the row around after use so
    audit history survives — ``used_at`` + ``used_by_user_id`` tell the admin
    which code went to which account.
    """

    __tablename__ = "invite_codes"

    # The opaque string the user types. Kept short enough to share verbally /
    # over chat without copy-paste pain.
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=False)

    # Free-form admin label, e.g. "for Alice".
    note: Mapped[str | None] = mapped_column(String(255))

    # Who minted the code. NULL only if the admin user was later deleted.
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    # Optional expiry; NULL means "valid until consumed".
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Set when the code is redeemed during signup. After this point the code
    # cannot be reused.
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    used_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    @property
    def is_usable(self) -> bool:
        if self.used_at is not None:
            return False
        if self.expires_at is not None and self.expires_at < datetime.now(UTC):
            return False
        return True
