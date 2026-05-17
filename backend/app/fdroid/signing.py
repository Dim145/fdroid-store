"""Build & sign F-Droid index JAR files using jarsigner."""
from __future__ import annotations

import asyncio
import zipfile
from pathlib import Path


class SigningError(RuntimeError):
    """Raised when signing a JAR fails."""


def make_jar(jar_path: Path, entries: dict[str, bytes]) -> None:
    """Create an unsigned JAR with ``entries`` mapping file-name -> content.

    F-Droid index JARs typically contain a single JSON entry
    (``index-v1.json`` or ``entry.json``).
    """
    jar_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(jar_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in entries.items():
            zi = zipfile.ZipInfo(name)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(zi, content)


async def sign_jar(
    jar_path: Path,
    *,
    keystore_path: Path,
    keystore_password: str,
    alias: str,
    key_password: str,
) -> None:
    """Sign the JAR in place using jarsigner.

    F-Droid clients verify with SHA-256/RSA. We use jarsigner's default
    parameters (which match what fdroidserver produces).
    """
    # In PKCS12 keystores, keytool always sets the key password equal to the
    # store password (it warns about this when you try to differ). So we use
    # the store password for both here — passing different ones makes
    # jarsigner think the alias is not a private-key entry.
    cmd = [
        "jarsigner",
        "-keystore", str(keystore_path),
        "-storepass", keystore_password,
        "-keypass", keystore_password,
        "-sigalg", "SHA256withRSA",
        "-digestalg", "SHA-256",
        "-storetype", "PKCS12",
        str(jar_path),
        alias,
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise SigningError(
            f"jarsigner failed (rc={proc.returncode}): "
            f"{(err or out).decode('utf-8', 'replace')}"
        )


async def build_and_sign_jar(
    jar_path: Path,
    entries: dict[str, bytes],
    *,
    keystore_path: Path,
    keystore_password: str,
    alias: str,
    key_password: str,
) -> None:
    """Convenience: build the JAR then sign it."""
    make_jar(jar_path, entries)
    await sign_jar(
        jar_path,
        keystore_path=keystore_path,
        keystore_password=keystore_password,
        alias=alias,
        key_password=key_password,
    )
