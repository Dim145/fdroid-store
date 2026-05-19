"""Minimal async clamd client.

We only need INSTREAM (stream-from-memory scan) because every APK we'd
hand the scanner is already a local tmpfile we open and read. Going
through a Unix socket / shared volume would couple us to the deployment
topology; INSTREAM works against any clamd reachable over TCP.

Protocol (from ``man clamd``):

  1. Connect, send ``zINSTREAM\\0``
  2. Stream payload as chunks: ``<be32 length><bytes>`` repeated
  3. Mark end-of-stream: ``<be32 0>``
  4. Read a single text reply:
       ``stream: OK``                       → clean
       ``stream: <SignatureName> FOUND``    → infected
       ``stream: <error description> ERROR``→ scanner error
"""
from __future__ import annotations

import asyncio
import struct
from dataclasses import dataclass
from pathlib import Path

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)


@dataclass
class ScanResult:
    """Outcome of a single scan attempt."""

    clean: bool
    """True only when clamd returned ``OK``. False on infected, error, or
    transport failure."""

    signature: str | None
    """Signature name on a hit (``stream: <name> FOUND``); None otherwise."""

    error: str | None
    """Free-form error message when the scan couldn't complete (clamd
    unreachable, protocol error, size cap hit). The caller decides whether
    that's a soft failure (log + continue) or a hard one (block upload)."""


_CHUNK = 64 * 1024  # 64 KiB — comfortably below clamd's StreamMaxLength


async def _scan_stream(host: str, port: int, fh, *, size_bytes: int = 0) -> ScanResult:
    # 20 s base + 1 s per MB on the wire. Scales with the file: 12 MB APK
    # → ~32 s, 75 MB APK → ~95 s. ClamAV's INSTREAM throughput on a single
    # core is roughly 1-2 MB/s for compressed archives, so this gives the
    # scanner ~2× headroom before we kill the connection.
    mb = max(0, size_bytes) // (1024 * 1024)
    timeout_s = max(30.0, 20.0 + float(mb))
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=5.0
        )
    except Exception as exc:  # noqa: BLE001
        return ScanResult(clean=False, signature=None, error=f"connect failed: {exc}")
    try:
        writer.write(b"zINSTREAM\0")
        max_bytes = settings.clamav_max_stream_mb * 1024 * 1024
        sent = 0
        while True:
            chunk = fh.read(_CHUNK)
            if not chunk:
                break
            sent += len(chunk)
            if sent > max_bytes:
                writer.close()
                try:
                    await writer.wait_closed()
                except Exception:  # noqa: BLE001
                    pass
                return ScanResult(
                    clean=False,
                    signature=None,
                    error=f"file exceeds CLAMAV_MAX_STREAM_MB ({settings.clamav_max_stream_mb} MiB)",
                )
            writer.write(struct.pack(">I", len(chunk)))
            writer.write(chunk)
            try:
                await asyncio.wait_for(writer.drain(), timeout=10.0)
            except asyncio.TimeoutError:
                return ScanResult(clean=False, signature=None, error="drain timeout")
        # Zero-length chunk = end-of-stream.
        writer.write(struct.pack(">I", 0))
        await writer.drain()
        try:
            reply = await asyncio.wait_for(reader.readline(), timeout=timeout_s)
        except asyncio.TimeoutError:
            return ScanResult(clean=False, signature=None, error="scan timeout")
        text = reply.decode("utf-8", errors="replace").strip().rstrip("\0")
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass

    if not text:
        return ScanResult(clean=False, signature=None, error="empty reply")
    # Typical replies: ``stream: OK``, ``stream: Eicar-Test-Signature FOUND``,
    # ``stream: COMMAND READ TIMED OUT ERROR``.
    body = text.split(":", 1)[1].strip() if ":" in text else text
    if body == "OK":
        return ScanResult(clean=True, signature=None, error=None)
    if body.endswith(" FOUND"):
        return ScanResult(clean=False, signature=body[:-6].strip(), error=None)
    if body.endswith(" ERROR"):
        return ScanResult(clean=False, signature=None, error=body[:-6].strip())
    return ScanResult(clean=False, signature=None, error=f"unexpected reply: {text}")


async def scan_path(path: Path) -> ScanResult:
    """Stream the file at ``path`` to clamd and return the result.

    The feature is gated on ``settings.clamav_available`` at the caller
    side; we don't double-check here because tests inject a fake host.
    """
    host = settings.clamav_host
    if not host:
        return ScanResult(
            clean=False,
            signature=None,
            error="CLAMAV_HOST is not set",
        )
    port = settings.clamav_port
    try:
        size_bytes = path.stat().st_size
    except OSError:
        size_bytes = 0
    with path.open("rb") as fh:
        return await _scan_stream(host, port, fh, size_bytes=size_bytes)


async def ping() -> bool:
    """Trivial reachability check (used by the admin "Test connection"
    button). Sends ``zPING\\0`` and expects ``PONG``."""
    if not settings.clamav_host:
        return False
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(settings.clamav_host, settings.clamav_port),
            timeout=3.0,
        )
    except Exception:  # noqa: BLE001
        return False
    try:
        writer.write(b"zPING\0")
        await writer.drain()
        reply = await asyncio.wait_for(reader.readline(), timeout=3.0)
        return reply.strip().rstrip(b"\0") == b"PONG"
    except Exception:  # noqa: BLE001
        return False
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass
