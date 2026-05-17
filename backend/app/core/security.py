"""Password hashing, JWT encoding/decoding, API-key hashing helpers."""
from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import settings

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# --------------------------------------------------------------------------
# Passwords
# --------------------------------------------------------------------------
def hash_password(password: str) -> str:
    return _pwd_context.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    return _pwd_context.verify(password, hashed)


# --------------------------------------------------------------------------
# JWT
# --------------------------------------------------------------------------
def _create_token(subject: str, expires_delta: timedelta, token_type: str, extra: dict[str, Any] | None = None) -> str:
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": subject,
        "iat": int(now.timestamp()),
        "exp": int((now + expires_delta).timestamp()),
        "type": token_type,
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)


def create_access_token(subject: str, extra: dict[str, Any] | None = None) -> str:
    return _create_token(
        subject,
        timedelta(minutes=settings.access_token_expire_minutes),
        "access",
        extra,
    )


def create_refresh_token(subject: str) -> str:
    return _create_token(
        subject,
        timedelta(days=settings.refresh_token_expire_days),
        "refresh",
    )


def decode_token(token: str) -> dict[str, Any]:
    """Decode + validate a JWT. Raises ``JWTError`` on failure."""
    return jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_algorithm])


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
    """
    prefix = secrets.token_urlsafe(6).replace("-", "x").replace("_", "y")[:8]
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
    "create_refresh_token",
    "decode_token",
    "generate_api_key",
    "hash_password",
    "parse_api_key",
    "verify_api_key_secret",
    "verify_password",
]
