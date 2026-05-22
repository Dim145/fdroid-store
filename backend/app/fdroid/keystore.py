"""Repo signing key management — generate, import, inspect.

The keystore is a PKCS#12 file at ``settings.keystore_path``. Generation and
inspection are pure-Python through ``cryptography``: the API image carries
no JDK (only the worker does, for signing the F-Droid index with
``apksigner``). The PKCS#12 we emit here is fully compatible with what
``apksigner`` consumes on the worker side — exercised end-to-end by the
"Generate keystore → reindex → APK download" flow in the smoke suite.
"""
from __future__ import annotations

import asyncio
import os
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID


class KeystoreError(RuntimeError):
    """Raised when keystore operations fail."""


@dataclass
class KeystoreInfo:
    present: bool
    path: Path
    alias: str | None = None
    fingerprint_sha256: str | None = None
    not_before: datetime | None = None
    not_after: datetime | None = None


_DNAME_OID_MAP: dict[str, x509.ObjectIdentifier] = {
    "CN": NameOID.COMMON_NAME,
    "OU": NameOID.ORGANIZATIONAL_UNIT_NAME,
    "O": NameOID.ORGANIZATION_NAME,
    "L": NameOID.LOCALITY_NAME,
    "ST": NameOID.STATE_OR_PROVINCE_NAME,
    "S": NameOID.STATE_OR_PROVINCE_NAME,  # JDK keytool accepts both ST and S
    "C": NameOID.COUNTRY_NAME,
    "STREET": NameOID.STREET_ADDRESS,
    "DC": NameOID.DOMAIN_COMPONENT,
    "UID": NameOID.USER_ID,
    "E": NameOID.EMAIL_ADDRESS,
    "EMAILADDRESS": NameOID.EMAIL_ADDRESS,
}


def _parse_dname(dname: str) -> x509.Name:
    """Parse a keytool-style RFC 2253-ish DN into an x509.Name.

    Accepts the same syntax keytool's ``-dname`` flag does:
    comma-separated ``KEY=value`` pairs, case-insensitive keys, optional
    whitespace around the commas. Backslash escapes a literal comma so a
    DN like ``CN=My Corp\\, Inc., O=Acme`` keeps the comma in CN.

    Raises :class:`KeystoreError` on unknown keys or empty values so the
    setup wizard surfaces "C=ZZZZ" typos rather than silently emitting
    a cert with no Country attribute.
    """
    parts: list[str] = []
    buf: list[str] = []
    escaped = False
    for ch in dname:
        if escaped:
            buf.append(ch)
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if ch == ",":
            parts.append("".join(buf))
            buf = []
            continue
        buf.append(ch)
    parts.append("".join(buf))

    attrs: list[x509.NameAttribute] = []
    for raw in parts:
        kv = raw.strip()
        if not kv:
            continue
        if "=" not in kv:
            raise KeystoreError(f"malformed DN component {kv!r} (expected KEY=value)")
        key, _, value = kv.partition("=")
        key = key.strip().upper()
        value = value.strip()
        if not value:
            raise KeystoreError(f"empty value for DN component {key!r}")
        oid = _DNAME_OID_MAP.get(key)
        if oid is None:
            raise KeystoreError(f"unsupported DN component {key!r}")
        attrs.append(x509.NameAttribute(oid, value))
    if not attrs:
        raise KeystoreError("DN must contain at least one component (e.g. CN=...)")
    return x509.Name(attrs)


def _build_keystore_bytes_sync(
    *,
    keystore_password: str,
    alias: str,
    dname: str,
    validity_days: int,
) -> bytes:
    """Synchronous PKCS#12 build. Heavy CPU work (RSA-3072 keygen ≈ 100-300 ms)
    that the caller runs through ``asyncio.to_thread`` so the event loop
    stays free."""
    name = _parse_dname(dname)
    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    now = datetime.now(UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)  # self-signed
        .public_key(key.public_key())
        # Random 64-bit positive integer; keytool's default. SECP / NIST
        # both forbid using 0 or repeating serials within the same
        # subject — a fresh random satisfies both.
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))  # clock-skew slack
        .not_valid_after(now + timedelta(days=validity_days))
        # Mirror keytool's default basicConstraints + keyUsage for a
        # ``-keyalg RSA`` keypair — these are what apksigner / F-Droid
        # clients look for on the leaf cert.
        .add_extension(
            x509.BasicConstraints(ca=False, path_length=None), critical=True
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=True,
                key_encipherment=True,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()),
            critical=False,
        )
        .sign(private_key=key, algorithm=hashes.SHA256())
    )

    # PKCS12 password is bytes; encode UTF-8 to match what keytool wrote
    # historically. ``BestAvailableEncryption`` uses AES-256-CBC + HMAC-
    # SHA256 (the modern PKCS12 profile keytool 17+ writes too), which
    # apksigner / jarsigner have supported since JDK 11.
    pwd_bytes = keystore_password.encode("utf-8")
    encryption = serialization.BestAvailableEncryption(pwd_bytes)
    p12 = pkcs12.serialize_key_and_certificates(
        # ``friendly_name`` is what shows up as the alias when keytool
        # / apksigner list the entries. Must be bytes.
        name=alias.encode("utf-8"),
        key=key,
        cert=cert,
        cas=None,
        encryption_algorithm=encryption,
    )
    return p12


async def generate_keystore(
    path: Path,
    *,
    keystore_password: str,
    alias: str,
    key_password: str,
    dname: str,
    validity_days: int = 365 * 30,
) -> KeystoreInfo:
    """Generate a new PKCS#12 keystore with a single RSA-3072 key.

    Pure-Python implementation (no ``keytool``) so the API image stays
    JDK-free. The worker — which still carries the JDK + ``apksigner``
    for index signing — reads back this same PKCS#12 file at index-
    rebuild time; apksigner has no issue with the format ``cryptography``
    emits (AES-256-CBC encryption + HMAC-SHA256 MAC, PKCS#12 v3).

    NOTE: ``key_password`` is accepted for API compatibility with the
    pre-split wizard but ignored — PKCS#12 only supports a single
    password for the whole store under
    :class:`serialization.BestAvailableEncryption`. Splitting store /
    key passwords would require dropping back to ``CertificateAndKeyPair``
    + a custom KDF, which apksigner doesn't reliably consume. Reject
    distinct passwords at the wizard layer instead.

    Refuses to overwrite an existing file — callers must delete it first.
    """
    if path.exists():
        raise KeystoreError(f"Keystore already exists at {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    # ``key_password`` is silently ignored when distinct from
    # ``keystore_password``. The wizard schema validates equality, but
    # treat them as best-effort here so a future caller that forgets
    # the schema check still gets a usable .p12.
    _ = key_password
    p12_bytes = await asyncio.to_thread(
        _build_keystore_bytes_sync,
        keystore_password=keystore_password,
        alias=alias,
        dname=dname,
        validity_days=validity_days,
    )
    # Write atomically: bytes → tmp → rename. ``open(..., 'xb')`` makes
    # the create+write step itself a race-free O_EXCL, so two concurrent
    # wizard submissions can't both think they succeeded.
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "xb") as fh:
        fh.write(p12_bytes)
    # Tighten perms before the rename so a sidecar process running as a
    # different UID can't read the .p12 bytes and brute-force the
    # password offline (CWE-276).
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, path)
    return await read_keystore_info(path, keystore_password)


async def import_keystore(
    path: Path,
    *,
    content: bytes,
    keystore_password: str,
) -> KeystoreInfo:
    """Atomically write an externally-provided keystore and validate it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(content)
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    try:
        info = await read_keystore_info(tmp, keystore_password)
    except KeystoreError:
        tmp.unlink(missing_ok=True)
        raise
    shutil.move(str(tmp), str(path))
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return info


def _read_keystore_info_sync(path: Path, keystore_password: str) -> KeystoreInfo:
    """Parse a PKCS#12 keystore in-process via ``cryptography``.

    Previously this used ``keytool -list -v`` and parsed the stdout with
    regex. That works correctly but spawns a JVM per call — ~300-500 ms
    on a warm container, several seconds on the first hit after start —
    which made the admin "Dépôt" page noticeably laggy on every open.

    PKCS#12 is a public format the ``cryptography`` package already
    speaks fluently, so we cut out the subprocess hop entirely: read
    bytes, decode, project the four fields the API ultimately returns.
    Typical wall time drops to single-digit milliseconds.

    Blocking work (file I/O + a touch of crypto parsing) but cheap;
    ``read_keystore_info`` runs us in the default threadpool so the
    event loop stays free even for unusually large keystore files.
    """
    try:
        data = path.read_bytes()
        # `load_pkcs12` returns the primary key+cert as ``.cert`` (a
        # PKCS12Certificate wrapper carrying the friendly_name bytes
        # alongside the X.509 cert) plus any extras under
        # ``additional_certs``. The store may be passwordless — encode
        # the empty string identically rather than passing ``None``.
        pwd_bytes = (keystore_password or "").encode("utf-8")
        pfx = pkcs12.load_pkcs12(data, pwd_bytes if pwd_bytes else None)
    except (ValueError, TypeError) as exc:
        raise KeystoreError(f"keystore parse failed — {exc}") from exc

    entry = pfx.cert
    if entry is None:
        raise KeystoreError("keystore has no primary certificate entry")
    cert = entry.certificate
    friendly = entry.friendly_name
    alias = friendly.decode("utf-8") if friendly else None

    fp_hex = cert.fingerprint(hashes.SHA256()).hex()

    # cryptography >= 42 ships ``not_valid_*_utc`` (timezone-aware).
    # The legacy attrs are naive UTC; we paper that over so callers
    # always get a tz-aware datetime regardless of which library
    # version is installed at runtime.
    try:
        not_before = cert.not_valid_before_utc
        not_after = cert.not_valid_after_utc
    except AttributeError:
        not_before = cert.not_valid_before.replace(tzinfo=UTC)
        not_after = cert.not_valid_after.replace(tzinfo=UTC)

    return KeystoreInfo(
        present=True,
        path=path,
        alias=alias,
        fingerprint_sha256=fp_hex,
        not_before=not_before,
        not_after=not_after,
    )


async def read_keystore_info(path: Path, keystore_password: str) -> KeystoreInfo:
    """Return metadata for the primary entry of the PKCS#12 keystore."""
    if not path.exists():
        return KeystoreInfo(present=False, path=path)
    return await asyncio.to_thread(_read_keystore_info_sync, path, keystore_password)


async def delete_keystore(path: Path) -> None:
    """Remove the keystore. Caller is responsible for backups."""
    if path.exists():
        path.unlink()
