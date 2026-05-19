"""TOTP (RFC 6238) enrolment + verification + recovery codes.

Public surface is intentionally tiny:
  * :func:`begin_enrolment` — stage a new secret on a ``UserTotp`` row
  * :func:`confirm_enrolment` — verify the first code, mark confirmed,
    return recovery codes (only chance to copy them)
  * :func:`disable` — wipe the row
  * :func:`verify` — accept either a 6-digit TOTP code or one of the
    single-use recovery codes; updates ``last_used_at`` on success and
    burns the recovery slot when one matches

The recovery codes are stored as bcrypt hashes (same library used for the
legacy local-password column). 10 codes per user; each is 8 chars
``base32`` for shoulder-surf resistance without being painful to type.
"""
from __future__ import annotations

import base64
import io
import json
import secrets
from datetime import UTC, datetime

import pyotp
from pwdlib import PasswordHash
from pwdlib.hashers.bcrypt import BcryptHasher
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.user_totp import UserTotp


_bcrypt = PasswordHash((BcryptHasher(),))


# 32 chars of base32 = 160 bits, matches pyotp's default.
def _new_secret() -> str:
    return pyotp.random_base32()


def _new_recovery_code() -> str:
    # Crockford-ish base32 without I/O/0/1 confusables, in groups of four
    # for legibility: ``ABCD-EFGH``.
    alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    return "-".join(
        "".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(2)
    )


def _provisioning_uri(secret: str, *, account_name: str, issuer: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(
        name=account_name,
        issuer_name=issuer,
    )


def _qr_data_uri(provisioning_uri: str) -> str:
    """Generate a PNG QR for the otpauth:// URI and return as data: URI.

    Keeps the network round-trip out of enrolment — the client gets the
    QR image inline and can render it immediately."""
    import qrcode

    qr = qrcode.QRCode(box_size=6, border=2)
    qr.add_data(provisioning_uri)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


async def begin_enrolment(
    db: AsyncSession,
    user: User,
    *,
    issuer: str,
) -> dict:
    """Stage a new TOTP secret on the user's row (or overwrite an existing
    unconfirmed one). Returns the secret + QR data URI + provisioning URI
    so the client can render an authenticator-app-friendly screen.

    If the row is already ``confirmed_at != NULL`` we refuse — the user
    must disable first to avoid silently breaking their existing app
    registration.
    """
    row = (
        await db.execute(select(UserTotp).where(UserTotp.user_id == user.id))
    ).scalar_one_or_none()
    if row is not None and row.confirmed_at is not None:
        from fastapi import HTTPException, status

        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="TOTP already enrolled. Disable it first to re-enrol.",
        )

    secret = _new_secret()
    if row is None:
        row = UserTotp(
            user_id=user.id,
            secret=secret,
            recovery_codes_hash="[]",
        )
        db.add(row)
    else:
        row.secret = secret
        row.recovery_codes_hash = "[]"
    await db.flush()

    uri = _provisioning_uri(secret, account_name=user.email, issuer=issuer)
    return {
        "secret": secret,
        "provisioning_uri": uri,
        "qr_data_uri": _qr_data_uri(uri),
    }


def _verify_totp_code(secret: str, code: str) -> bool:
    if not code or not code.strip().isdigit():
        return False
    return pyotp.TOTP(secret).verify(code.strip(), valid_window=1)


async def confirm_enrolment(
    db: AsyncSession,
    user: User,
    *,
    code: str,
) -> list[str]:
    """Verify the first code and mark TOTP confirmed. Returns the freshly
    generated recovery codes; this is the only time they're shown."""
    from fastapi import HTTPException, status

    row = (
        await db.execute(select(UserTotp).where(UserTotp.user_id == user.id))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No TOTP enrolment in progress")
    if not _verify_totp_code(row.secret, code):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid code")
    codes = [_new_recovery_code() for _ in range(10)]
    row.recovery_codes_hash = json.dumps([_bcrypt.hash(c) for c in codes])
    row.confirmed_at = datetime.now(UTC)
    row.last_used_at = datetime.now(UTC)
    await db.flush()
    return codes


async def disable(db: AsyncSession, user: User) -> None:
    row = (
        await db.execute(select(UserTotp).where(UserTotp.user_id == user.id))
    ).scalar_one_or_none()
    if row is not None:
        await db.delete(row)
        await db.flush()


async def is_enrolled(db: AsyncSession, user_id) -> bool:
    """True when the user has a confirmed TOTP row. Staged-but-unconfirmed
    rows don't count — the login flow shouldn't gate on them."""
    row = (
        await db.execute(
            select(UserTotp.confirmed_at).where(UserTotp.user_id == user_id)
        )
    ).scalar_one_or_none()
    return row is not None


async def verify_login(
    db: AsyncSession,
    user: User,
    *,
    code: str,
) -> bool:
    """Verify either a TOTP code or one of the recovery codes for the
    confirmed enrolment of ``user``. Returns True on success and updates
    side-state (``last_used_at``, recovery-slot consumption); False on
    any failure — the caller surfaces a generic 401 so the response
    doesn't leak whether the user has TOTP at all."""
    row = (
        await db.execute(select(UserTotp).where(UserTotp.user_id == user.id))
    ).scalar_one_or_none()
    if row is None or row.confirmed_at is None:
        return False

    code = (code or "").strip()
    if not code:
        return False

    # Path 1: 6-digit TOTP. Cheap to verify; try this first.
    if code.isdigit() and len(code) == 6 and _verify_totp_code(row.secret, code):
        row.last_used_at = datetime.now(UTC)
        return True

    # Path 2: recovery code. Walk the stored hash list looking for a match,
    # burn the slot on hit. Codes are uppercase + dash in the canonical
    # rendering; tolerate lowercase too.
    canonical = code.upper().replace(" ", "")
    try:
        hashes: list[str] = json.loads(row.recovery_codes_hash or "[]")
    except json.JSONDecodeError:
        hashes = []
    for i, h in enumerate(hashes):
        if not h:
            continue
        try:
            if _bcrypt.verify(canonical, h):
                hashes[i] = ""  # burn slot
                row.recovery_codes_hash = json.dumps(hashes)
                row.last_used_at = datetime.now(UTC)
                return True
        except Exception:  # noqa: BLE001
            continue
    return False
