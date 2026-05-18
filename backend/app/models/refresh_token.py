from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class RefreshToken(Base, IdMixin, TimestampMixin):
    """Persisted refresh-token state for rotation + re-use detection.

    Stateless JWT refresh tokens are convenient but leave no defender
    visibility: a stolen token works for up to ``refresh_token_expire_days``
    and the victim has no way to revoke it. We persist one row per minted
    refresh token, mark it ``used_at`` when redeemed, and link the
    replacement via ``parent_jti``. If the same row is presented twice
    (re-use), we revoke the entire chain — the legitimate user's session
    breaks but so does the attacker's.

    Following OAuth 2.0 Security BCP (RFC 9700 §2.2.2).
    """

    __tablename__ = "refresh_tokens"

    # The ``jti`` claim embedded in the JWT itself; the lookup key on
    # /auth/refresh. Indexed for the typical "lookup by id" hot path.
    jti: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # The jti of the refresh token this one replaced (set on rotation). NULL
    # for the original token minted at login. Lets us walk the chain and
    # revoke every descendant when a re-use is detected.
    parent_jti: Mapped[str | None] = mapped_column(String(64), index=True)

    # Wall-clock the row was either consumed (rotation) or proactively
    # revoked (password change, family-wide invalidation, admin disable).
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
