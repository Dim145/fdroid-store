"""Parse an APK file: manifest metadata + signing certificate.

Pure-Python parse: ``androguard`` handles the binary AndroidManifest.xml
and also exposes the signing certificates via
``get_certificates_v{1,2,3}()`` (asn1crypto Certificate objects). The
SHA-256 of the leaf certificate's DER encoding matches the value
``apksigner verify --print-certs`` emits — empirically validated against
APKs signed under v1, v2 and v3 schemes. We hash directly instead of
shelling out, which keeps the API image free of the JDK + apksigner
binary (only the worker carries them, for signing the F-Droid index).

NOTE on signature *validation*: this function ONLY extracts the cert
fingerprint. It does not cryptographically validate the APK's
signature. The downstream F-Droid client re-verifies at install time,
and our cross-app signer-pin check catches the practical attack
(same package name → must keep the same signer), so we accept that
trade-off in exchange for shedding the apksigner dep on the API side.
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


def _signer_cert_sha256(apk: APK) -> str:
    """SHA-256 of the leaf signing certificate, lowercase hex.

    Walks the modern → legacy signature schemes (v3 → v2 → v1) and
    returns the first one that yields a certificate. The DER bytes of
    the first cert in that chain match what ``apksigner verify
    --print-certs`` reports as the signer fingerprint.

    Raises :class:`ApkParseError` if no scheme produced a certificate
    — an unsigned APK has no business in an F-Droid repo.
    """
    # Prefer the newest scheme that signed this APK. F-Droid clients use
    # the same precedence: an APK signed under v3 is verified by v3; the
    # older blocks are present but the v3 leaf is what apksigner reports.
    for getter in (apk.get_certificates_v3, apk.get_certificates_v2, apk.get_certificates_v1):
        try:
            certs = getter() or []
        except Exception:  # noqa: BLE001
            certs = []
        if certs:
            # asn1crypto's Certificate.dump() returns the DER-encoded
            # bytes — what apksigner hashes.
            try:
                der = certs[0].dump()
            except Exception as exc:  # noqa: BLE001
                raise ApkParseError(f"could not extract signer DER: {exc}") from exc
            return hashlib.sha256(der).hexdigest().lower()
    raise ApkParseError("APK has no v1/v2/v3 signing certificate")


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
    # Path-injection barrier. Two previous attempts (
    # ``Path.resolve().relative_to`` and ``os.path.realpath +
    # startswith``) gave correct runtime semantics but CodeQL's
    # ``py/path-injection`` data-flow tracker didn't propagate the
    # sanitisation across them. The pattern below — regex allowlist on
    # the basename, then reconstruction of the final path from a
    # constant prefix + the validated basename — is the strongest
    # barrier shape the analyser recognises: the path used by the
    # downstream FS op is now built from a hard-coded directory plus
    # data that has passed an explicit allowlist, so no caller-supplied
    # string reaches ``open`` / ``isfile`` directly.
    #
    # Strict allowlist + path reconstruction. Every legitimate caller
    # builds the input through ``tempfile.NamedTemporaryFile(...,
    # suffix='.apk')``: ``save_upload_to_temp`` / ``_download_apk`` use
    # the default ``tmp`` prefix, while ``_materialise_staged_apk`` uses
    # ``prefix='fdroid-staged-'``. So a real basename is
    # ``{tmp|fdroid-staged-}<random>.apk`` — letters, digits, ``_`` and
    # ``-`` only, never ``.`` or a path separator. The class below
    # allows exactly those and rejects everything else. (``-`` is safe:
    # only ``.`` and ``/`` enable traversal, and both stay excluded — so
    # allowing ``-`` keeps the barrier's anti-traversal guarantee intact.)
    #
    # Three design points:
    #
    # * Bounded quantifier ``{1,128}`` (rather than ``+``) — tempfile
    #   basenames are ~10 chars; capping at 128 makes the pattern
    #   provably ReDoS-free, which is what CodeQL's
    #   ``py/polynomial-redos`` ruleset wants to see on a regex
    #   fed user input.
    #
    # * ``.`` is OUT of the bracket class — keeps the class disjoint
    #   from the literal ``\.apk`` suffix (no backtracking ambiguity)
    #   AND rules out ``..`` / ``.`` sequences in the basename so the
    #   reconstructed ``safe_path`` can't traverse out of the tmpdir.
    #
    # * The reconstructed ``safe_path`` is built from a hard-coded
    #   prefix (``tempfile.gettempdir()``) joined to the
    #   allowlist-validated basename. Nothing caller-supplied reaches
    #   the downstream ``os.path.isfile`` directly — which is the
    #   barrier shape CodeQL's ``py/path-injection`` recognises. We
    #   deliberately do NOT call ``os.path.realpath`` on the original
    #   ``path`` anywhere after this point: re-touching the
    #   caller-supplied string re-introduces the taint that the
    #   regex barrier just stripped.
    basename = os.path.basename(str(path))
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}\.apk", basename):
        raise ApkParseError(
            "APK basename must be a tempfile-style filename"
        )
    safe_path = os.path.join(tempfile.gettempdir(), basename)
    if not os.path.isfile(safe_path):
        raise ApkParseError(f"APK not found at {safe_path}")
    p = Path(safe_path)

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

    # Pure-Python — extracted from the already-parsed ``apk`` object so
    # we don't re-open the file. See ``_signer_cert_sha256`` for the
    # equivalence to ``apksigner verify --print-certs``.
    signer_sha = _signer_cert_sha256(apk)

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
