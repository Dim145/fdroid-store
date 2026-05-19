from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class UserTotp(Base, IdMixin, TimestampMixin):
    """TOTP (RFC 6238) second factor for a user account.

    One row per user, created when they start enrolment and finalised
    (``confirmed_at`` set) when the first valid code is verified. While
    ``confirmed_at`` is NULL the user is still in mid-enrolment — login does
    not require the second factor yet, but the secret stays staged.

    ``recovery_codes_hash`` is the JSON-encoded list of bcrypt hashes for the
    10 single-use backup codes shown to the user once at enrolment. Each one
    is wiped (string → empty) on use; verification accepts any non-empty
    hash whose bcrypt matches.
    """

    __tablename__ = "user_totp"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )

    # Base32 TOTP secret. 32 chars covers RFC 6238 §4 (160 bits, the SHA-1
    # default). Stored as plaintext — the secret is only useful with the
    # user's account, and encrypting it server-side wouldn't add real
    # defence-in-depth (the same DB row also defines whether MFA is
    # required, so a DB compromise already wins).
    secret: Mapped[str] = mapped_column(String(64), nullable=False)

    # Set on first successful code verification — that's when 2FA becomes
    # mandatory for this account. NULL = staged (enrolment started, not
    # confirmed).
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # JSON array of bcrypt hashes for the recovery codes. Empty string in a
    # slot means "consumed". When every slot is empty the user has burned
    # all backups and should regenerate.
    recovery_codes_hash: Mapped[str] = mapped_column(Text, default="[]", nullable=False)

    # Last time a code (TOTP or recovery) was successfully used. Drives the
    # account-page "last used" line.
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
