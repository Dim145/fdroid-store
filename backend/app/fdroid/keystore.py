"""Repo signing key management — generate, import, inspect.

The keystore is a PKCS#12 file at ``settings.keystore_path``. We use the JDK's
``keytool`` for generation and inspection (no Python equivalent that handles
JKS/P12 well enough for jarsigner to read).
"""
from __future__ import annotations

import asyncio
import os
import re
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


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


_FINGERPRINT_RE = re.compile(r"SHA256:\s*([0-9A-Fa-f:]+)")
# Pattern: "Valid from: Thu Jan 01 00:00:00 UTC 2026 until: ..."
_VALIDITY_RE = re.compile(r"Valid from:\s+(.+?)\s+until:\s+(.+)$", re.MULTILINE)


def _parse_keytool_date(raw: str) -> datetime | None:
    # Example: "Thu Jan 01 00:00:00 UTC 2026"
    for fmt in ("%a %b %d %H:%M:%S %Z %Y", "%a %b %d %H:%M:%S %z %Y"):
        try:
            return datetime.strptime(raw.strip(), fmt)
        except ValueError:
            continue
    return None


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
        raise KeystoreError(f"keytool genkeypair failed: {err or out}")
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


async def read_keystore_info(path: Path, keystore_password: str) -> KeystoreInfo:
    """Return metadata for the (first) entry of the keystore."""
    if not path.exists():
        return KeystoreInfo(present=False, path=path)
    rc, out, err = await _run(
        [
            "keytool", "-list", "-v",
            "-keystore", str(path),
            "-storetype", "PKCS12",
            "-storepass:env", "FDROID_STOREPASS",
        ],
        env_extra={"FDROID_STOREPASS": keystore_password},
    )
    if rc != 0:
        raise KeystoreError(f"keytool -list failed: {err or out}")

    alias_match = re.search(r"Alias name:\s*(\S+)", out)
    fp_match = _FINGERPRINT_RE.search(out)
    validity_match = _VALIDITY_RE.search(out)

    not_before = _parse_keytool_date(validity_match.group(1)) if validity_match else None
    not_after = _parse_keytool_date(validity_match.group(2)) if validity_match else None
    fp = fp_match.group(1).replace(":", "").lower() if fp_match else None

    return KeystoreInfo(
        present=True,
        path=path,
        alias=alias_match.group(1) if alias_match else None,
        fingerprint_sha256=fp,
        not_before=not_before,
        not_after=not_after,
    )


async def delete_keystore(path: Path) -> None:
    """Remove the keystore. Caller is responsible for backups."""
    if path.exists():
        path.unlink()
