"""Hostile APK layouts are refused cheaply, before androguard pays for them."""
from __future__ import annotations

import io
import struct
import tempfile
import threading
import zipfile
import zlib
from collections.abc import Iterator
from pathlib import Path

import pytest
from apkInspector.headers import ZipEntry

from app.fdroid import apk_parser
from app.fdroid.apk_parser import ApkParseError, parse_apk


def _deflate(data: bytes) -> bytes:
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    return c.compress(data) + c.flush()


def _zip(entries: list[tuple[str, bytes, int, int]], *, between: bytes = b"") -> bytes:
    """Minimal ZIP from ``(name, payload, method, declared_size)``; the
    declared size may lie. ``between`` goes before the central directory
    (where an APK Signing Block lives)."""
    body, cd = bytearray(), bytearray()
    for name, payload, method, declared in entries:
        raw_name = name.encode()
        offset = len(body)
        body += struct.pack(
            "<4sHHHHHIIIHH", b"PK\x03\x04", 20, 0, method, 0, 0, 0,
            len(payload), declared, len(raw_name), 0,
        ) + raw_name + payload
        cd += struct.pack(
            "<4sHHHHHHIIIHHHHHII", b"PK\x01\x02", 20, 20, 0, method, 0, 0, 0,
            len(payload), declared, len(raw_name), 0, 0, 0, 0, 0, offset,
        ) + raw_name
    body += between
    eocd = struct.pack(
        "<4sHHHHIIH", b"PK\x05\x06", 0, 0, len(entries), len(entries), len(cd), len(body), 0,
    )
    return bytes(body + cd + eocd)


@pytest.fixture
def tmp_apk() -> Iterator[callable]:
    """Write bytes to a tempfile-style ``*.apk`` (what parse_apk accepts)."""
    paths: list[Path] = []

    def write(data: bytes) -> Path:
        with tempfile.NamedTemporaryFile(suffix=".apk", delete=False) as fh:
            fh.write(data)
        paths.append(Path(fh.name))
        return paths[-1]

    yield write
    for p in paths:
        p.unlink(missing_ok=True)


async def test_deflate_bomb_manifest_is_refused(tmp_apk) -> None:
    bomb = _deflate(b"\0" * (apk_parser._MANIFEST_MAX + 1))
    path = tmp_apk(_zip([("AndroidManifest.xml", bomb, 8, apk_parser._MANIFEST_MAX + 1)]))
    with pytest.raises(ApkParseError, match="inflates past"):
        await parse_apk(path)


async def test_bomb_with_lying_declared_size_is_refused_while_inflating(tmp_apk) -> None:
    bomb = _deflate(b"\0" * (apk_parser._MANIFEST_MAX + 1))
    path = tmp_apk(_zip([("AndroidManifest.xml", bomb, 8, 1000)]))
    with pytest.raises(ApkParseError, match="inflates past"):
        await parse_apk(path)


async def test_trailing_data_after_the_zip_end_record_is_refused(tmp_apk) -> None:
    data = _zip([("AndroidManifest.xml", b"<manifest/>", 0, 11)]) + b"\x01" * (70 * 1024)
    with pytest.raises(ApkParseError, match="data after"):
        await parse_apk(tmp_apk(data))


async def test_signing_block_with_too_many_pairs_is_refused(tmp_apk) -> None:
    pairs = struct.pack("<QI", 4, 0x42726577) * (apk_parser._SIG_BLOCK_MAX_PAIRS + 1)
    size = len(pairs) + 24
    block = struct.pack("<Q", size) + pairs + struct.pack("<Q", size) + b"APK Sig Block 42"
    data = _zip([("AndroidManifest.xml", b"<manifest/>", 0, 11)], between=block)
    with pytest.raises(ApkParseError, match="Signing Block"):
        await parse_apk(tmp_apk(data))


def test_central_directory_walk_stops_at_the_entry_cap() -> None:
    record = struct.pack(
        "<4sHHHHHHIIIHHHHHII", b"PK\x01\x02", 20, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    )
    with pytest.raises(ApkParseError, match="more than 65535 entries"):
        apk_parser._check_entry_count(io.BytesIO(record * (apk_parser._MAX_ENTRIES + 1)), 0)
    apk_parser._check_entry_count(io.BytesIO(record * apk_parser._MAX_ENTRIES), 0)


def test_bounded_reader_matches_apkinspector_on_normal_entries() -> None:
    # Guards against apkInspector API drift: same bytes as its own reader.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("stored.bin", b"s" * 5000, compress_type=zipfile.ZIP_STORED)
        z.writestr(
            "deflated.bin", b"d" * 50000 + bytes(range(256)), compress_type=zipfile.ZIP_DEFLATED
        )
        z.writestr("empty.bin", b"", compress_type=zipfile.ZIP_DEFLATED)
    stock = ZipEntry.parse(io.BytesIO(buf.getvalue()), True)
    bounded = apk_parser._BoundedZipEntry(
        stock.zip, stock.eocd, stock.central_directory, stock.local_headers
    )
    for name in ("stored.bin", "deflated.bin", "empty.bin"):
        assert bounded.read(name) == stock.read(name)
    with pytest.raises(KeyError):
        bounded.read("missing.bin")


async def test_androguard_errors_become_parse_errors(tmp_apk) -> None:
    # A truncated second end record: apkInspector picks it and its
    # struct.unpack blows up — a 400, not a 500.
    data = _zip([("AndroidManifest.xml", b"<manifest/>", 0, 11)]) + b"PK\x05\x06" + b"\0" * 10
    with pytest.raises(ApkParseError, match="Malformed APK"):
        await parse_apk(tmp_apk(data))


async def test_the_whole_parse_runs_off_the_event_loop(monkeypatch, tmp_apk) -> None:
    seen: list[threading.Thread] = []

    def fake_parse(p: Path) -> str:
        seen.append(threading.current_thread())
        return "parsed"

    monkeypatch.setattr(apk_parser, "_parse_sync", fake_parse)
    assert await parse_apk(tmp_apk(b"x" * 64)) == "parsed"
    assert seen and seen[0] is not threading.main_thread()
