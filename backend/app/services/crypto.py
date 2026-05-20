"""Symmetric encryption for at-rest secrets.

Used to encrypt per-source PAT tokens before they hit the database.
The key is derived from ``settings.secret_key`` so we don't introduce
a new operator-managed secret — operators rotating the JWT secret
also invalidate stored tokens (which is the correct security posture
since both flow from the same trust root).

Fernet (AES-128-CBC + HMAC-SHA256) is the right primitive here:
authenticated encryption, opinionated key handling, no IV reuse to
worry about, ciphertexts include the IV and HMAC.
"""
from __future__ import annotations

import base64
import hashlib
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    # Fernet wants a 32-byte url-safe base64-encoded key. We pin the
    # derivation to SHA-256 of the secret_key so any change to the
    # operator's SECRET_KEY rotates the encryption key too — that's
    # intentional (see module docstring).
    digest = hashlib.sha256(settings.secret_key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt(plaintext: str) -> bytes:
    """Encrypt a plaintext string. Returns raw ciphertext bytes suitable
    for a ``BYTEA`` column. The plaintext must be a non-empty string."""
    if not isinstance(plaintext, str) or not plaintext:
        raise ValueError("encrypt() expects a non-empty string")
    return _fernet().encrypt(plaintext.encode("utf-8"))


def decrypt(ciphertext: bytes) -> str | None:
    """Decrypt a ciphertext blob. Returns ``None`` if the blob is
    corrupted or the encryption key has changed since it was written —
    callers fall back to the env-var default in that case.

    When a non-empty blob fails to decrypt we log a warning at the
    application level — silently falling through hides the fact that
    per-source tokens are dead after a ``SECRET_KEY`` rotation, which
    would otherwise leave admins puzzled by failing private-repo
    scans for a while.
    """
    if not ciphertext:
        return None
    try:
        return _fernet().decrypt(ciphertext).decode("utf-8")
    except InvalidToken:
        from app.core.logging import get_logger

        get_logger(__name__).warning(
            "fernet decrypt failed — secret_key rotated? "
            "Per-source token is dead, falling back to env-var default"
        )
        return None
