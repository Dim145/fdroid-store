"""Build & sign F-Droid index JAR files using jarsigner."""
from __future__ import annotations

import asyncio
import os
import shutil
import zipfile
from pathlib import Path


class SigningError(RuntimeError):
    """Raised when signing a JAR fails."""


def _resolve_jarsigner() -> str:
    """Locate the ``jarsigner`` binary robustly.

    Invoking it by bare name relies on ``jarsigner`` being on ``PATH`` at
    runtime — fragile across deployments (a custom entrypoint or an
    ``environment:`` override that resets ``PATH`` drops the JDK's bin dir,
    and the resulting ``FileNotFoundError: 'jarsigner'`` is opaque). Resolve
    it explicitly: ``JAVA_HOME/bin`` first (the worker image sets
    ``JAVA_HOME=/opt/jre-min``), then ``PATH``, then the image's bundled JRE.

    Raises :class:`SigningError` with an actionable message if none is found
    — index signing needs a JDK, which only the *worker* image bundles; the
    API image deliberately ships without one.
    """
    candidates: list[str] = []
    java_home = os.environ.get("JAVA_HOME")
    if java_home:
        candidates.append(os.path.join(java_home, "bin", "jarsigner"))
    on_path = shutil.which("jarsigner")
    if on_path:
        candidates.append(on_path)
    candidates.append("/opt/jre-min/bin/jarsigner")  # Dockerfile.worker location
    for path in candidates:
        if path and os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    raise SigningError(
        "jarsigner not found — F-Droid index signing requires a JDK. This "
        "task must run in the WORKER image (which bundles a minimal JRE at "
        "/opt/jre-min and sets JAVA_HOME); the API image has no JDK. "
        f"Searched: {candidates or ['<PATH only>']}"
    )


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
        _resolve_jarsigner(),
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
