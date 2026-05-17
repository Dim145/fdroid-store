from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class ApiKey(Base, IdMixin, TimestampMixin):
    """Long-lived bearer token attached to a user.

    Used both as a programmatic API credential and as the auth mechanism for
    the F-Droid client to fetch private apps via HTTP Basic auth (username =
    user, password = full API key).
    """
    __tablename__ = "api_keys"

    name: Mapped[str] = mapped_column(String(128), nullable=False)
    prefix: Mapped[str] = mapped_column(String(16), unique=True, nullable=False, index=True)
    hashed_secret: Mapped[str] = mapped_column(String(128), nullable=False)

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Permissions: simple flags. For finer-grained scopes, swap for a list.
    can_download_private: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    can_manage_apps: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user = relationship("User", back_populates="api_keys")

    @property
    def is_active(self) -> bool:
        from datetime import UTC, datetime as _dt
        if self.revoked_at is not None:
            return False
        if self.expires_at is not None and self.expires_at < _dt.now(UTC):
            return False
        return True
