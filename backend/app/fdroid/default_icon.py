"""Generate a default repo icon when no custom one has been uploaded.

We don't bundle a binary asset; instead we synthesize a simple 256x256 PNG
with the letter "fS" on the F-Droid green. Admins replace it from the UI.
"""
from __future__ import annotations

import io
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

_FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]


def _load_font(size: int) -> ImageFont.ImageFont:
    for path in _FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except Exception:  # noqa: BLE001
                continue
    return ImageFont.load_default()


def generate_default_repo_icon(size: int = 256, text: str = "fS") -> bytes:
    """Return a freshly-generated PNG as raw bytes."""
    img = Image.new("RGB", (size, size), (39, 174, 96))  # F-Droid-ish green
    draw = ImageDraw.Draw(img)
    font = _load_font(size // 2)
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        w = bbox[2] - bbox[0]
        h = bbox[3] - bbox[1]
        x = (size - w) // 2 - bbox[0]
        y = (size - h) // 2 - bbox[1]
    except AttributeError:
        # default bitmap font fallback
        w, h = draw.textsize(text, font=font)  # type: ignore[attr-defined]
        x = (size - w) // 2
        y = (size - h) // 2
    draw.text((x, y), text, fill=(255, 255, 255), font=font)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
