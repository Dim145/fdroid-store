"""Build & sign F-Droid index JAR files using jarsigner."""
from __future__ import annotations

import asyncio
import os
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
    #
    # ``-storepass:env`` / ``-keypass:env`` keep the secret out of argv —
    # otherwise it shows up in ``ps`` / ``/proc/<pid>/cmdline`` (CWE-214).
    # The path is prefixed with ``./`` so a filename starting with ``-``
    # can't be mistaken for a flag (CWE-88 defence in depth). jarsigner
    # doesn't honour the standard ``--`` argv separator.
    jar_arg = str(jar_path)
    if not jar_arg.startswith("/") and not jar_arg.startswith("./"):
        jar_arg = "./" + jar_arg
    cmd = [
        "jarsigner",
        "-keystore", str(keystore_path),
        "-storepass:env", "FDROID_STOREPASS",
        "-keypass:env", "FDROID_STOREPASS",
        "-sigalg", "SHA256withRSA",
        "-digestalg", "SHA-256",
        "-storetype", "PKCS12",
        jar_arg,
        alias,
    ]
    env = os.environ.copy()
    env["FDROID_STOREPASS"] = keystore_password
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    try:
        # 60 s is comfortably above any legitimate index-signing run. A
        # corrupt JAR that makes jarsigner spin would otherwise hold a
        # worker indefinitely.
        out, err = await asyncio.wait_for(proc.communicate(), timeout=60.0)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise SigningError("jarsigner timed out") from None
    if proc.returncode != 0:
        raise SigningError(
            f"jarsigner failed (rc={proc.returncode}): "
            f"{(err or out).decode('utf-8', 'replace')[:512]}"
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
