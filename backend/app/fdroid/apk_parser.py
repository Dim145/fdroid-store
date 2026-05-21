"""Parse an APK file: manifest metadata + signing certificate.

We use ``androguard`` for the binary AndroidManifest.xml and shell out to
``apksigner`` (Android SDK) to obtain the SHA-256 of the signing cert. Why
both: androguard's cert extraction has historically lagged behind v2/v3/v4
APK signature schemes; apksigner is the source of truth.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from androguard.core.apk import APK


@dataclass
class ApkMetadata:
    package_name: str
    version_code: int
    version_name: str
    min_sdk: int | None
    target_sdk: int | None
    max_sdk: int | None
    permissions: list[str] = field(default_factory=list)
    features: list[str] = field(default_factory=list)
    native_code: list[str] = field(default_factory=list)
    locales: list[str] = field(default_factory=list)
    signer_sha256: str = ""  # cert fingerprint, hex lowercase
    sha256: str = ""         # file content hash, hex lowercase
    size_bytes: int = 0
    app_name: str | None = None
    icon_data: bytes | None = None
    icon_extension: str | None = None


class ApkParseError(RuntimeError):
    """Raised when an APK file cannot be parsed."""


# Pattern: "SHA-256 digest: 49 8e af ... b3"
_APKSIGNER_HEX = re.compile(r"SHA-256 digest:\s*([0-9a-fA-F\s]+)")


def _sha256_file(path: Path) -> tuple[str, int]:
    h = hashlib.sha256()
    size = 0
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


async def _apksigner_cert_sha256(path: Path) -> str:
    """Return SHA-256 of the APK signer certificate, as lowercase hex.

    Defensive against:
      * paths whose basename starts with ``-`` — we prefix with ``./`` so
        the argument can never look like a flag, no matter what the
        binary's parser tolerates (CWE-88).
      * malformed APKs that make the JVM hang — ``asyncio.wait_for`` caps
        wall-clock at 60 s and kills the process on timeout (CWE-400).
    """
    path_arg = str(path)
    if not path_arg.startswith("/") and not path_arg.startswith("./"):
        path_arg = "./" + path_arg
    proc = await asyncio.create_subprocess_exec(
        "apksigner", "verify", "--print-certs", path_arg,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=60.0)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise ApkParseError("apksigner timed out") from None
    if proc.returncode != 0:
        # Truncate + strip control bytes — apksigner's stderr can echo
        # attacker-influenced bytes from the APK, and we don't want them
        # in our error response or logs (CWE-209).
        raw = err.decode("utf-8", "replace")[:512]
        safe = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", raw)
        raise ApkParseError(f"apksigner failed (rc={proc.returncode}): {safe}")
    text = out.decode("utf-8", "replace")
    m = _APKSIGNER_HEX.search(text)
    if not m:
        raise ApkParseError("apksigner output did not contain a SHA-256 digest")
    return re.sub(r"\s+", "", m.group(1)).lower()


def _safe_int(v) -> int | None:
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


async def parse_apk(path: str | Path) -> ApkMetadata:
    """Parse an APK at ``path`` and return its metadata.

    Heavy work runs in a thread so the event loop stays responsive on
    large APKs.

    ``path`` must resolve to a regular file under the system temp
    directory. Every caller in the codebase already feeds us such a
    path (either ``save_upload_to_temp`` from the upload endpoints or
    ``_download_apk`` from the rescan service — both use
    ``tempfile.NamedTemporaryFile``), but enforcing it here gives us
    two things:

    1. A loud failure if a future caller ever passes an
       arbitrary user-controlled path by mistake.
    2. An explicit sanitiser that CodeQL's ``py/path-injection``
       tracker recognises, so the upload-derived path provably
       cannot escape the tmpdir before it reaches androguard's
       ``APK(str(p))`` (CWE-22 / CWE-23 defence-in-depth).
    """
    # Canonicalise with ``os.path.realpath`` and gate access with an
    # explicit ``startswith`` against the OS temp dir. This particular
    # pair is the path-injection barrier shape CodeQL's python ruleset
    # recognises (see PathInjectionQuery.qll in github/codeql);
    # ``Path.resolve().relative_to()`` is semantically equivalent but
    # currently isn't tracked as a sanitiser by the analyser.
    #
    # ``str(path)`` because ``realpath`` only accepts str / bytes on
    # older runtimes; on 3.13 a ``Path`` works but the explicit cast
    # is harmless and keeps the contract clear.
    candidate = os.path.realpath(str(path))
    tmpdir = os.path.realpath(tempfile.gettempdir())
    if not (candidate == tmpdir or candidate.startswith(tmpdir + os.sep)):
        raise ApkParseError(
            "APK path must be inside the system temp directory"
        )
    if not os.path.isfile(candidate):
        raise ApkParseError(f"APK not found at {candidate}")
    p = Path(candidate)

    def _read() -> tuple[APK, str, int]:
        apk = APK(str(p))
        if not apk.is_valid_APK():
            raise ApkParseError("Not a valid APK")
        sha, size = _sha256_file(p)
        return apk, sha, size

    apk, sha, size = await asyncio.to_thread(_read)

    # Native ABIs are reflected by directories under lib/ in the APK. We list
    # them straight from the zip to avoid androguard API drift.
    abis: set[str] = set()
    try:
        for entry in apk.get_files():
            if entry.startswith("lib/"):
                parts = entry.split("/")
                if len(parts) >= 2 and parts[1]:
                    abis.add(parts[1])
    except Exception:  # noqa: BLE001
        pass

    # Permissions / features may come back as dicts in some androguard
    # versions; normalize to plain strings.
    def _flatten_names(values) -> list[str]:
        out: list[str] = []
        for v in values or []:
            if isinstance(v, dict):
                name = v.get("name") or v.get("@android:name")
                if name:
                    out.append(str(name))
            elif v:
                out.append(str(v))
        return sorted(set(out))

    # F-Droid uses ``features`` to compute device compatibility: any entry it
    # finds is treated as REQUIRED. So we must only include features that
    # the manifest actually marks as required (or doesn't qualify, since
    # ``android:required`` defaults to "true"). Optional features like
    # ``android.hardware.camera2`` with ``required="false"`` MUST be left
    # out, otherwise phones without that hardware are flagged incompatible.
    required_features: set[str] = set()
    try:
        manifest_xml = apk.get_android_manifest_xml()
        root = manifest_xml if hasattr(manifest_xml, "iter") else manifest_xml.getroot()
        android_name = "{http://schemas.android.com/apk/res/android}name"
        android_required = "{http://schemas.android.com/apk/res/android}required"
        for elt in root.iter("uses-feature"):
            name = elt.get(android_name)
            if not name:
                continue
            required_attr = (elt.get(android_required) or "true").strip().lower()
            if required_attr != "false":
                required_features.add(name)
    except Exception as exc:  # noqa: BLE001
        # Worst case (parsing breaks): keep nothing rather than mark every
        # feature required and break compatibility for all users.
        required_features = set()

    icon_data: bytes | None = None
    icon_ext: str | None = None

    # androguard returns whatever resource it finds first; on modern apps that
    # is usually mipmap-anydpi-v26 → an XML adaptive icon, which is useless
    # to us. We walk the standard density ladder from highest to lowest and
    # grab the first raster (PNG/WebP/JPEG) we hit.
    _RASTER_EXT = {"png": "png", "webp": "webp", "jpg": "jpg", "jpeg": "jpg"}
    _DENSITY_LADDER = [640, 480, 320, 240, 160, 120]
    try:
        candidates: list[str] = []
        # Default call first (cheap, usually wins for legacy apps)
        primary = apk.get_app_icon()
        if primary:
            candidates.append(primary)
        for dpi in _DENSITY_LADDER:
            try:
                got = apk.get_app_icon(max_dpi=dpi)
            except Exception:  # noqa: BLE001
                continue
            if got and got not in candidates:
                candidates.append(got)

        for icon_name in candidates:
            lower = icon_name.lower()
            ext_name = lower.rsplit(".", 1)[-1] if "." in lower else ""
            ext = _RASTER_EXT.get(ext_name)
            if ext is None:
                continue  # XML adaptive icons & friends — try next density
            raw = apk.get_file(icon_name)
            if raw:
                icon_data = raw
                icon_ext = ext
                break
    except Exception:  # noqa: BLE001
        icon_data = None

    signer_sha = await _apksigner_cert_sha256(p)

    try:
        locales = sorted(set(apk.get_languages_and_regions() or []))
    except Exception:  # noqa: BLE001
        locales = []

    meta = ApkMetadata(
        package_name=apk.get_package(),
        version_code=int(apk.get_androidversion_code() or 0),
        version_name=str(apk.get_androidversion_name() or ""),
        min_sdk=_safe_int(apk.get_min_sdk_version()),
        target_sdk=_safe_int(apk.get_target_sdk_version()),
        max_sdk=_safe_int(apk.get_max_sdk_version()),
        permissions=_flatten_names(apk.get_permissions()),
        features=sorted(required_features),
        native_code=sorted(abis),
        locales=locales,
        signer_sha256=signer_sha,
        sha256=sha,
        size_bytes=size,
        app_name=apk.get_app_name() or None,
        icon_data=icon_data,
        icon_extension=icon_ext,
    )

    if not meta.package_name:
        raise ApkParseError("APK is missing a package name")
    if meta.version_code <= 0:
        raise ApkParseError("APK has invalid versionCode")

    return meta


async def verify_apksigner_available() -> bool:
    """Return True if the apksigner binary is on PATH.

    Async to avoid blocking the event loop — sync ``subprocess.run`` here
    would freeze every other request for the duration of the JVM start.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "apksigner", "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            await asyncio.wait_for(proc.wait(), timeout=10)
        except asyncio.TimeoutError:
            proc.kill()
            return False
        return proc.returncode == 0
    except FileNotFoundError:
        return False
