"""WebAuthn / FIDO2 credential pinned to a user account.

One row per (user, authenticator) pair. ``credential_id`` is the spec's
``rawId`` (base64url-encoded for transport but stored as raw bytes here);
the ``public_key`` is the COSE-encoded key returned by ``py_webauthn`` at
registration and consumed at assertion time. The ``sign_count`` is the
spec's clone-detection counter — every assertion must come in with a
strictly greater value than what's stored, or the authenticator has
likely been duplicated. We update it after every successful assertion.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class WebAuthnCredential(Base, IdMixin, TimestampMixin):
    __tablename__ = "webauthn_credentials"
    __table_args__ = (
        # The spec mandates credential IDs are globally unique. Enforcing
        # uniqueness DB-side means an attacker can't replay a captured
        # credential ID against a different account.
        UniqueConstraint("credential_id", name="uq_webauthn_credentials_credential_id"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # The authenticator's raw credential ID. Length is up to 1023 bytes per
    # the spec, in practice ~16-256.
    credential_id: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)

    # COSE-encoded public key. py_webauthn returns this as bytes at
    # registration and accepts the same bytes at assertion.
    public_key: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)

    # Anti-clone counter. ``BigInteger`` because the spec allows 32-bit values
    # and PG INT tops out at ~2.1B — extremely unlikely to wrap in practice
    # but cheaper to overshoot now than migrate later.
    sign_count: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)

    # JSON-encoded list of ``AuthenticatorTransport`` strings (``"usb"``,
    # ``"nfc"``, ``"ble"``, ``"internal"``, ``"hybrid"``). Stored as text to
    # keep the schema portable; the API layer parses/serialises around it.
    transports_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)

    # Human label the user picks at enrolment ("YubiKey 5C", "iPhone Face ID",
    # …). Used purely for the /account UI's list — never trusted by the
    # crypto layer.
    label: Mapped[str] = mapped_column(String(100), nullable=False)

    # Set on every successful assertion. NULL until the credential has been
    # used at least once (i.e. just-registered ones).
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
