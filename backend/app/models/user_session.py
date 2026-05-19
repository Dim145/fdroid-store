from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class UserSession(Base, IdMixin, TimestampMixin):
    """A login session, keyed on the refresh-token family.

    One row per "login" event — created when ``/auth/login`` mints the first
    refresh token, and kept alive across rotations (the ``jti`` column tracks
    the *current* refresh token in the family, updated on every rotate). When
    a user revokes a session from the account page we revoke the underlying
    refresh-token chain too.
    """

    __tablename__ = "user_sessions"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # The jti of the *current* refresh token. Updated on each rotation so a
    # session always points to the live token in its family. Indexed for the
    # lookup at refresh time.
    jti: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)

    # Trust signals captured at login time. ``ip_hash`` is a SHA-256 hash of
    # the raw IP — sufficient to distinguish sessions without persisting the
    # raw address. ``user_agent`` is truncated to 255 chars.
    ip_hash: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(255))

    # Last successful refresh — drives the "last seen X minutes ago" label
    # in the UI. Updated on each rotate.
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    # Set when the user revoked the session from the account page (or when
    # an admin force-logged-them-out). The corresponding refresh-token row
    # gets ``revoked_at`` at the same time.
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
