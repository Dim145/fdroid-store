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

Untrusted input: androguard's ZIP backend (apkInspector) inflates whole
entries with an unbounded ``zlib.decompress`` and ignores the declared
size, so a ~400 KiB APK with a deflate-bomb manifest costs >1 GiB of RAM;
and its v2/v3 signature lookup scans backwards one byte at a time, so
trailing junk after the ZIP end record burns ~40 s of CPU per 200 MB.
Every entry read goes through :class:`_BoundedZipEntry` and the file
layout is checked before androguard sees it.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import re
import struct
import tempfile
import zlib
from dataclasses import dataclass, field
from pathlib import Path

from androguard.core.apk import APK
from apkInspector.headers import ZipEntry

# Inflated-size ceilings. The manifest is a few hundred KiB even for huge
# apps; anything else androguard reads (resources.arsc, icons, signature
# files) gets a generous cap that still bounds a deflate bomb.
_MANIFEST_MAX = 8 * 1024 * 1024
_ENTRY_MAX = 64 * 1024 * 1024
_ICON_MAX = 4 * 1024 * 1024
_ENTRY_LIMITS = {"AndroidManifest.xml": _MANIFEST_MAX}

# The ZIP end-of-central-directory record is 22 bytes plus a comment of at
# most 64 KiB, so it always sits within this distance of the end of a
# well-formed archive — which holds at most 65535 entries without ZIP64.
_EOCD_SIG = b"PK\x05\x06"
_EOCD_MIN = 22
_EOCD_WINDOW = _EOCD_MIN + 0xFFFF
_MAX_ENTRIES = 0xFFFF
# Real APK Signing Blocks hold a handful of ID-value pairs (v2, v3, v3.1,
# padding, source stamp…).
_SIG_BLOCK_MAGIC = b"APK Sig Block 42"
_SIG_BLOCK_MAX_PAIRS = 64


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


class _BoundedZipEntry(ZipEntry):
    """apkInspector's ``ZipEntry`` — androguard's ZIP backend — with a
    ceiling on how much an entry may inflate to.

    Mirrors ``apkInspector.extract.extract_file_based_on_header_info``
    (sizes from the local header unless zero there, deflate for method 8,
    the stored / deflate guesses for a bogus method) but never inflates
    more than ``limit + 1`` bytes, whatever the headers claim.
    """

    def read(self, name: str, save: bool = False, *, limit: int | None = None) -> bytes:
        cap = limit or _ENTRY_LIMITS.get(name, _ENTRY_MAX)
        local = self.get_local_header_dict(name)
        central = self.get_central_directory_entry_dict(name)
        if local["compressed_size"] == 0 or local["uncompressed_size"] == 0:
            compressed_size = central["compressed_size"]
            uncompressed_size = central["uncompressed_size"]
        else:
            compressed_size = local["compressed_size"]
            uncompressed_size = local["uncompressed_size"]
        method = local["compression_method"]
        data_offset = (
            central["relative_offset_of_local_file_header"]
            + 30
            + local["file_name_length"]
            + local["extra_field_length"]
        )
        if method == 0 or (method != 8 and compressed_size == uncompressed_size):
            return self._read_stored(name, data_offset, uncompressed_size, cap)
        self.zip.seek(data_offset)
        inflater = zlib.decompressobj(-15)
        data = inflater.decompress(self.zip.read(compressed_size), cap + 1)
        if len(data) > cap:
            raise ApkParseError(f"{name} inflates past {cap} bytes")
        if method == 8:
            if not inflater.eof:
                raise ApkParseError(f"{name}: truncated deflate stream")
            return data
        if inflater.eof and not inflater.unused_data and not inflater.unconsumed_tail:
            return data
        # Bogus method that isn't clean deflate either: apkInspector falls
        # back to reading the bytes as stored.
        return self._read_stored(name, data_offset, uncompressed_size, cap)

    def _read_stored(self, name: str, offset: int, size: int, cap: int) -> bytes:
        # Stored bytes can't amplify (they are already in memory), but the
        # per-entry ceiling still applies — a 100 MiB "manifest" isn't one.
        if name in _ENTRY_LIMITS and size > cap:
            raise ApkParseError(f"{name} is larger than {cap} bytes")
        self.zip.seek(offset)
        return self.zip.read(size)


class _BoundedAPK(APK):
    """androguard ``APK`` whose every entry read goes through
    :class:`_BoundedZipEntry`. The swap happens in ``_apk_analysis`` — the
    hook ``__init__`` runs right after indexing the ZIP and before reading
    the first entry (the manifest)."""

    def _apk_analysis(self) -> None:
        z = self.zip
        self.zip = _BoundedZipEntry(z.zip, z.eocd, z.central_directory, z.local_headers)
        super()._apk_analysis()


def _check_zip_layout(path: Path) -> None:
    """Refuse ZIP layouts that make androguard burn CPU or memory before it
    reads a single entry:

    * the end-of-central-directory record must sit where the ZIP spec puts
      it (within 22 B + 64 KiB of the end) — androguard's v2/v3 signature
      lookup scans backwards from the end one byte at a time;
    * at most 65535 entries (the most a non-ZIP64 archive — so any APK
      Android installs — can hold); apkInspector builds ~1.4 KiB of Python
      objects per entry, ~3 GiB for a 200 MB archive of empty entries;
    * an APK Signing Block holds a handful of ID-value pairs — androguard
      checks each pair against all the previous ones (quadratic).
    """
    size = path.stat().st_size
    if size < _EOCD_MIN:
        raise ApkParseError("Not a valid APK")
    with path.open("rb") as fh:
        fh.seek(max(0, size - _EOCD_WINDOW))
        tail = fh.read()
        # androguard probes offsets ``size - 22`` downwards, apkInspector
        # takes the last signature anywhere in the file.
        eocd = tail.rfind(_EOCD_SIG, 0, len(tail) - _EOCD_MIN + len(_EOCD_SIG))
        if eocd == -1:
            raise ApkParseError("Not a valid APK: no ZIP end record, or data after it")
        last = tail.rfind(_EOCD_SIG)
        if len(tail) - last >= 20:
            _check_entry_count(fh, int.from_bytes(tail[last + 16:last + 20], "little"))
        _check_signing_block(fh, size, int.from_bytes(tail[eocd + 16:eocd + 20], "little"))


def _check_entry_count(fh, cd_offset: int) -> None:
    """Walk the central directory the way apkInspector does (record after
    record while the signature matches) and refuse past ``_MAX_ENTRIES``."""
    fh.seek(cd_offset)
    entries = 0
    while True:
        header = fh.read(46)
        if len(header) < 46 or header[:4] != b"PK\x01\x02":
            return
        entries += 1
        if entries > _MAX_ENTRIES:
            raise ApkParseError(f"APK has more than {_MAX_ENTRIES} entries")
        name_len, extra_len, comment_len = struct.unpack("<HHH", header[28:34])
        fh.seek(name_len + extra_len + comment_len, os.SEEK_CUR)


def _check_signing_block(fh, size: int, cd_offset: int) -> None:
    """Count the ID-value pairs of the APK Signing Block that sits right
    before the central directory, exactly as androguard walks them."""
    if cd_offset < 24 or cd_offset > size:
        return  # androguard gives up on its own
    fh.seek(cd_offset - 24)
    footer = fh.read(24)
    if footer[8:] != _SIG_BLOCK_MAGIC:
        return
    block_size = int.from_bytes(footer[:8], "little")
    block_start = cd_offset - block_size - 8
    if block_start < 0:
        return
    fh.seek(block_start)
    if int.from_bytes(fh.read(8), "little") != block_size:
        return  # androguard raises BrokenAPKError on its own
    end = cd_offset - 24
    pairs = 0
    while fh.tell() < end:
        header = fh.read(12)
        if len(header) < 12:
            return
        pairs += 1
        if pairs > _SIG_BLOCK_MAX_PAIRS:
            raise ApkParseError("APK Signing Block has too many entries")
        pair_size = int.from_bytes(header[:8], "little")
        if pair_size < 4:
            return  # androguard reads to the end of the file and stops
        fh.seek(pair_size - 4, os.SEEK_CUR)


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
    return await asyncio.to_thread(_parse_sync, p)


def _parse_sync(p: Path) -> ApkMetadata:
    """The whole parse — layout checks, androguard, signer extraction
    (a backwards scan of the file), icon lookup, manifest walk — as one
    blocking call for a worker thread. Whatever androguard raises on a
    malformed archive becomes an :class:`ApkParseError`, i.e. a 400 for the
    upload endpoints instead of a 500."""
    try:
        return _extract_metadata(p)
    except ApkParseError:
        raise
    except Exception as exc:
        raise ApkParseError(f"Malformed APK ({type(exc).__name__}): {str(exc)[:200]}") from exc


def _extract_metadata(p: Path) -> ApkMetadata:
    _check_zip_layout(p)
    apk = _BoundedAPK(str(p))
    if not apk.is_valid_APK():
        raise ApkParseError("Not a valid APK")
    sha, size = _sha256_file(p)

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
            # An oversized / bomb icon just means no icon, not a failed parse.
            raw = apk.zip.read(icon_name, limit=_ICON_MAX)
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
