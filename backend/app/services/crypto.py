"""Symmetric encryption for at-rest secrets.

Used to encrypt per-source PAT tokens (and backup passphrases) before they
hit the database. The key is derived from ``settings.secret_key`` so we
don't introduce a new operator-managed secret — operators rotating the JWT
secret also invalidate stored tokens (which is the correct security posture
since both flow from the same trust root).

Fernet (AES-128-CBC + HMAC-SHA256) is the right primitive here:
authenticated encryption, opinionated key handling, no IV reuse to
worry about, ciphertexts include the IV and HMAC.

Key derivation (v2): the Fernet key is derived with **HKDF-SHA256** using a
fixed salt + ``info`` label rather than a bare ``SHA-256(secret_key)``.
``secret_key`` is ALSO the JWT signing key, so a plain hash gave the at-rest
cipher and the token signer keys with no domain separation — HKDF with a
distinct ``info`` guarantees the two subkeys can't coincide. The legacy
SHA-256 key is retained for *decryption only* (via ``MultiFernet``) so data
written before this change keeps decrypting; new writes always use the v2
key. Nothing has to be re-encrypted, and the "rotate SECRET_KEY → stored
secrets die" property is preserved (both keys flow from ``secret_key``).
"""
from __future__ import annotations

import base64
import hashlib
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.core.config import settings

# Fixed (non-secret) HKDF parameters. HKDF's guarantee is key *separation*,
# not salt secrecy — the salt only needs to be a stable, unique label.
_HKDF_SALT = b"fdroid-store/at-rest-secrets/v2"
_HKDF_INFO = b"fernet-key"


@lru_cache(maxsize=1)
def _legacy_fernet() -> Fernet:
    # Pre-v2 derivation: raw SHA-256(secret_key). Kept ONLY so ciphertexts
    # written before the HKDF migration still decrypt — never used to encrypt.
    digest = hashlib.sha256(settings.secret_key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


@lru_cache(maxsize=1)
def _hkdf_fernet() -> Fernet:
    # v2 derivation: HKDF-SHA256 over secret_key with a distinct info label,
    # so this key is cryptographically separated from the JWT HMAC key that
    # also comes from secret_key.
    key = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_HKDF_SALT,
        info=_HKDF_INFO,
    ).derive(settings.secret_key.encode("utf-8"))
    return Fernet(base64.urlsafe_b64encode(key))


@lru_cache(maxsize=1)
def _cipher() -> MultiFernet:
    # Encrypts with the FIRST key (v2/HKDF); decrypts by trying each in turn,
    # so legacy SHA-256 ciphertexts still open transparently.
    return MultiFernet([_hkdf_fernet(), _legacy_fernet()])


def encrypt(plaintext: str) -> bytes:
    """Encrypt a plaintext string. Returns raw ciphertext bytes suitable
    for a ``BYTEA`` column. The plaintext must be a non-empty string."""
    if not isinstance(plaintext, str) or not plaintext:
        raise ValueError("encrypt() expects a non-empty string")
    return _cipher().encrypt(plaintext.encode("utf-8"))


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
        return _cipher().decrypt(ciphertext).decode("utf-8")
    except InvalidToken:
        from app.core.logging import get_logger

        get_logger(__name__).warning(
            "fernet decrypt failed — secret_key rotated? "
            "Per-source token is dead, falling back to env-var default"
        )
        return None
