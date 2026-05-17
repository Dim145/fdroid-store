"""Parse an APK file: manifest metadata + signing certificate.

We use ``androguard`` for the binary AndroidManifest.xml and shell out to
``apksigner`` (Android SDK) to obtain the SHA-256 of the signing cert. Why
both: androguard's cert extraction has historically lagged behind v2/v3/v4
APK signature schemes; apksigner is the source of truth.
"""
from __future__ import annotations

import asyncio
import hashlib
import re
import subprocess
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
    """Return SHA-256 of the APK signer certificate, as lowercase hex."""
    proc = await asyncio.create_subprocess_exec(
        "apksigner", "verify", "--print-certs", str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise ApkParseError(
            f"apksigner failed (rc={proc.returncode}): {err.decode('utf-8', 'replace')}"
        )
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

    Heavy work runs in a thread so the event loop stays responsive on large
    APKs.
    """
    p = Path(path)
    if not p.exists():
        raise ApkParseError(f"APK not found at {p}")

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

    icon_data: bytes | None = None
    icon_ext: str | None = None
    try:
        icon_name = apk.get_app_icon()
        if icon_name:
            raw = apk.get_file(icon_name)
            if raw:
                icon_data = raw
                lower = icon_name.lower()
                if lower.endswith(".png"):
                    icon_ext = "png"
                elif lower.endswith(".webp"):
                    icon_ext = "webp"
                elif lower.endswith(".jpg") or lower.endswith(".jpeg"):
                    icon_ext = "jpg"
                elif lower.endswith(".xml"):
                    # adaptive icon (vector). We skip it; admin can upload one.
                    icon_data = None
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
        features=_flatten_names(apk.get_features()),
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


def verify_apksigner_available() -> bool:
    """Return True if the apksigner binary is on PATH."""
    try:
        r = subprocess.run(
            ["apksigner", "--version"],
            capture_output=True, text=True, timeout=10, check=False,
        )
        return r.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
