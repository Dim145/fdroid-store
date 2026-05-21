"""Repo signing key management — generate, import, inspect.

The keystore is a PKCS#12 file at ``settings.keystore_path``. We use the JDK's
``keytool`` for generation and inspection (no Python equivalent that handles
JKS/P12 well enough for jarsigner to read).
"""
from __future__ import annotations

import asyncio
import os
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.serialization import pkcs12


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


async def _run(
    cmd: list[str],
    input_bytes: bytes | None = None,
    env_extra: dict[str, str] | None = None,
    timeout: float = 60.0,
) -> tuple[int, str, str]:
    """Run an external command. ``env_extra`` is merged into the child env
    so secrets (keystore password) can be passed via ``-storepass:env NAME``
    instead of plaintext argv (visible in ``/proc/<pid>/cmdline``).
    ``timeout`` enforces an upper bound on wall-clock — the JVM tools occasionally
    hang on corrupt inputs and the previous unbounded ``communicate()`` let
    a single bad APK pin a worker indefinitely."""
    env: dict[str, str] | None = None
    if env_extra:
        env = os.environ.copy()
        env.update(env_extra)
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE if input_bytes else None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(input_bytes), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise KeystoreError(f"command {cmd[0]} timed out after {timeout}s")
    return proc.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


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

    Refuses to overwrite an existing file — callers must delete it first.
    """
    if path.exists():
        raise KeystoreError(f"Keystore already exists at {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    # ``-storepass:env`` / ``-keypass:env`` read the value from the child's
    # env vars instead of argv, so the secret never appears in ps / /proc/
    # <pid>/cmdline (CWE-214).
    cmd = [
        "keytool", "-genkeypair",
        # Force the JVM's SecureRandom to /dev/urandom. Default on modern
        # JVMs is already file:/dev/urandom, but on the jlink'd minimal
        # JRE we ship the java.security policy isn't always picked up
        # reliably — under low entropy keytool blocks on /dev/random and
        # the subprocess.communicate() hits its timeout instead of ever
        # returning a clean error.
        "-J-Djava.security.egd=file:/dev/urandom",
        "-keystore", str(path),
        "-storetype", "PKCS12",
        "-storepass:env", "FDROID_STOREPASS",
        "-keypass:env", "FDROID_KEYPASS",
        "-alias", alias,
        "-keyalg", "RSA",
        "-keysize", "3072",
        "-validity", str(validity_days),
        "-dname", dname,
    ]
    rc, out, err = await _run(
        cmd,
        env_extra={"FDROID_STOREPASS": keystore_password, "FDROID_KEYPASS": key_password},
    )
    if rc != 0:
        # keytool sometimes dies without writing anything to stderr (signal
        # kill, native crash). Surfacing only ``err or out`` would then
        # show the harmless "Generating ... RSA key pair" banner that's
        # already on stdout and tell the operator nothing. Include rc and
        # both streams so the real cause is visible.
        bits = [f"rc={rc}"]
        if err.strip():
            bits.append(f"stderr: {err.strip()}")
        if out.strip():
            bits.append(f"stdout: {out.strip()}")
        raise KeystoreError("keytool genkeypair failed — " + " | ".join(bits))
    # File ends up readable by group/world under the default umask; tighten
    # to 0600 so a sidecar process running as a different UID can't read
    # the .p12 bytes and brute-force the password offline (CWE-276).
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
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
