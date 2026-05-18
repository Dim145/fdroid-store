"""Safe helpers for handling untrusted uploads.

Two surfaces are unified here so every endpoint enforces the same limits:

  * ``read_capped(upload, max_bytes)`` — drain an UploadFile while refusing
    payloads larger than ``max_bytes``. Starlette spools to disk past
    ~1 MiB, but a 10 GB read would still load everything to RAM. The
    helper aborts with ``413 Request Entity Too Large`` as soon as it
    sees an over-budget chunk.

  * ``normalize_image(raw, max_size)`` — validate, decompression-bomb
    check, and re-encode an image to PNG. Format-whitelisted so a
    crafted TIFF (libtiff CVE surface) can't reach the PIL decoder.
    Runs in a worker thread because the actual decode + thumbnail is
    CPU-bound and would otherwise block the event loop on multi-MP JPEGs.
"""
from __future__ import annotations

import asyncio
import io
import warnings

from fastapi import HTTPException, UploadFile, status
from PIL import Image

# Anything above this is almost certainly a decompression bomb. A 25 MP
# image at 4 bytes/pixel decodes to ~100 MB of RAM — enough headroom for
# legitimate photography, low enough that a 10 GB malloc is rejected.
Image.MAX_IMAGE_PIXELS = 25_000_000

# Promote PIL's bomb warning to an error so ``Image.open`` raises instead
# of silently logging. This catches both ``DecompressionBombWarning`` and
# truncated-image cases where PIL tries to recover.
warnings.simplefilter("error", Image.DecompressionBombWarning)

# Only the formats the F-Droid client actually consumes. PIL's auto-detect
# would otherwise happily try to decode a TIFF / EPS / GIF whose codec is
# the historical source of every Pillow CVE.
_ALLOWED_FORMATS = ("PNG", "JPEG", "WEBP")


async def read_capped(upload: UploadFile, max_bytes: int) -> bytes:
    """Read an UploadFile into memory, refusing payloads larger than the cap.

    Streams chunks rather than ``await upload.read()`` so a 10 GB POST
    body doesn't get committed to RAM before we even check the size.
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(64 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Upload exceeds the {max_bytes} byte limit",
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _normalize_image_sync(raw: bytes, max_size: tuple[int, int]) -> bytes:
    """Pure-sync image normalisation. Kept as a helper so the async wrapper
    can dispatch it via ``asyncio.to_thread``."""
    try:
        # ``formats`` restricts PIL's auto-detect to the whitelisted codecs.
        with Image.open(io.BytesIO(raw), formats=_ALLOWED_FORMATS) as probe:
            probe.verify()
        img = Image.open(io.BytesIO(raw), formats=_ALLOWED_FORMATS).convert("RGBA")
    except Image.DecompressionBombWarning as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Image is too large to decode safely",
        ) from exc
    except Exception as exc:  # noqa: BLE001 — PIL throws many subclasses
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File is not a valid image",
        ) from exc
    img.thumbnail(max_size, Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


async def normalize_image(raw: bytes, max_size: tuple[int, int]) -> bytes:
    """Async wrapper: run the synchronous decode in a worker thread."""
    return await asyncio.to_thread(_normalize_image_sync, raw, max_size)
