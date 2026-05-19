"""Password hashing, JWT encoding/decoding, API-key hashing helpers."""
from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt as _jwt
from pwdlib import PasswordHash
from pwdlib.hashers.argon2 import Argon2Hasher
from pwdlib.hashers.bcrypt import BcryptHasher

from app.core.config import settings

# Re-exported so other modules can ``except security.JWTError`` without
# pulling PyJWT directly. Its hierarchy: InvalidTokenError covers expired,
# bad-signature, decode-failure, … so it's the right catch-all here.
JWTError = _jwt.InvalidTokenError

# ``Argon2Hasher`` is listed first so new hashes use argon2 (memory-hard,
# stronger by today's standard); ``BcryptHasher`` stays in the tuple so
# rows hashed with the old passlib+bcrypt setup keep verifying. pwdlib
# dispatches by hash prefix, so the upgrade is transparent to callers.
_password_hash = PasswordHash((Argon2Hasher(), BcryptHasher()))


# --------------------------------------------------------------------------
# Passwords
# --------------------------------------------------------------------------
def _bcrypt_safe(password: str) -> str:
    """bcrypt 5 raises ``ValueError`` on inputs > 72 bytes (it used to
    silently truncate). Argon2 has no such limit, but for legacy hashes
    verified via the bcrypt path we still need to cap. Truncating on the
    bytes boundary (and dropping a stray UTF-8 continuation) matches what
    passlib effectively did for the original hash, so old rows verify
    identically.
    """
    encoded = password.encode("utf-8")
    if len(encoded) <= 72:
        return password
    return encoded[:72].decode("utf-8", errors="ignore")


def hash_password(password: str) -> str:
    return _password_hash.hash(_bcrypt_safe(password))


def verify_password(password: str, hashed: str) -> bool:
    return _password_hash.verify(_bcrypt_safe(password), hashed)


# --------------------------------------------------------------------------
# JWT
# --------------------------------------------------------------------------
def _create_token(
    subject: str,
    expires_delta: timedelta,
    token_type: str,
    extra: dict[str, Any] | None = None,
    *,
    jti: str | None = None,
) -> str:
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": subject,
        "iat": int(now.timestamp()),
        "exp": int((now + expires_delta).timestamp()),
        "type": token_type,
        "jti": jti or secrets.token_urlsafe(16),
    }
    if extra:
        payload.update(extra)
    return _jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)


def create_access_token(subject: str, extra: dict[str, Any] | None = None) -> str:
    return _create_token(
        subject,
        timedelta(minutes=settings.access_token_expire_minutes),
        "access",
        extra,
    )


def create_refresh_token(subject: str, jti: str) -> str:
    """Refresh tokens always carry a ``jti`` that maps to a persisted
    ``refresh_tokens`` row. The auth service marks the row consumed on use
    and refuses re-use — that's what gives us rotation + revocation."""
    return _create_token(
        subject,
        timedelta(days=settings.refresh_token_expire_days),
        "refresh",
        jti=jti,
    )


def create_mfa_challenge_token(subject: str, expires_minutes: int = 5) -> str:
    """Short-lived token issued by /auth/login when the account has TOTP
    enrolled. The client returns it alongside the 6-digit code to
    /auth/login/mfa. The token is stateless: the only data we need to
    re-bind the request to the user is ``sub``, plus the type discriminator
    so it can't be replayed against /auth/refresh or /auth/login."""
    return _create_token(
        subject,
        timedelta(minutes=expires_minutes),
        "mfa_challenge",
    )


def decode_token(token: str) -> dict[str, Any]:
    """Decode + validate a JWT. Raises ``JWTError`` on failure."""
    return _jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_algorithm])


# --------------------------------------------------------------------------
# API keys
# --------------------------------------------------------------------------
# Format: fdr_<prefix>_<secret>
#   - prefix is short, stored in DB to allow quick lookup
#   - secret is hashed (sha256) and stored. Only the prefix is searchable.
API_KEY_PROTO = "fdr"


def generate_api_key() -> tuple[str, str, str]:
    """Returns ``(full_key, prefix, hashed_secret)``.

    The full key is shown to the user once and must be stored client-side;
    only the hashed secret is persisted.

    Prefix entropy bumped from ~48 bits to 96 bits (16 hex chars from a
    64-byte raw seed) — the old ``token_urlsafe(6) → 8-char truncate +
    -/_ collapse`` produced a biased 48-bit space at risk of unique-
    constraint collisions on large instances and a narrow enumeration
    window through the F-Droid serve path (CWE-330).
    """
    prefix = secrets.token_hex(8)  # 16 hex chars, 64 bits
    secret = secrets.token_urlsafe(32)
    full = f"{API_KEY_PROTO}_{prefix}_{secret}"
    return full, prefix, _hash_api_secret(secret)


def parse_api_key(full: str) -> tuple[str, str] | None:
    """Return ``(prefix, secret)`` if the key is well-formed, else None."""
    parts = full.split("_", 2)
    if len(parts) != 3 or parts[0] != API_KEY_PROTO:
        return None
    return parts[1], parts[2]


def verify_api_key_secret(secret: str, hashed: str) -> bool:
    return secrets.compare_digest(_hash_api_secret(secret), hashed)


def _hash_api_secret(secret: str) -> str:
    # We use plain SHA-256 — the secret is high-entropy random already; bcrypt
    # would add cost on every authenticated repo request.
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


__all__ = [
    "JWTError",
    "create_access_token",
    "create_mfa_challenge_token",
    "create_refresh_token",
    "decode_token",
    "generate_api_key",
    "hash_password",
    "parse_api_key",
    "verify_api_key_secret",
    "verify_password",
]
