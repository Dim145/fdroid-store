"""Re-parse stored APKs in place.

Used when the parser was buggy or a new field is added: we don't want to
force users to re-upload — we re-stream each APK from storage through the
current parser and rewrite the cached metadata in the DB.

Also re-extracts each app's icon from its latest published APK (unless the
admin has set a custom icon, which is sticky by design).
"""
from __future__ import annotations

import io
import tempfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlalchemy import select

from app.core.logging import get_logger
from app.fdroid.apk_parser import ApkMetadata, ApkParseError, parse_apk
from app.models.apk import Apk, ApkStatus
from app.models.app import App
from app.storage import get_storage

log = get_logger(__name__)


@dataclass
class RescanResult:
    rescanned_apks: int = 0
    icons_refreshed: int = 0
    failed: list[str] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.failed is None:
            self.failed = []


async def _download_apk(storage_key: str) -> Path:
    """Stream an APK from storage to a temp file. Caller deletes."""
    storage = get_storage()
    tmp = tempfile.NamedTemporaryFile(suffix=".apk", delete=False)
    tmp_path = Path(tmp.name)
    try:
        stream = await storage.open_stream(storage_key)
        async for chunk in stream:
            tmp.write(chunk)
    finally:
        tmp.close()
    return tmp_path


def _icon_to_png_bytes(raw: bytes) -> bytes:
    """Normalize an extracted icon to a 512×512 max RGBA PNG."""
    with Image.open(io.BytesIO(raw)) as img:
        rgba = img.convert("RGBA")
        rgba.thumbnail((512, 512), Image.LANCZOS)
        out = io.BytesIO()
        rgba.save(out, format="PNG", optimize=True)
        return out.getvalue()


async def rescan_app(
    db: AsyncSession,
    app: App,
) -> RescanResult:
    """Re-parse every published APK of one App and refresh its icon.

    Assumes ``app.apks`` is eager-loaded. Mutations are flushed but not
    committed — the caller owns the transaction.
    """
    result = RescanResult()
    storage = get_storage()
    latest_with_icon: tuple[int, bytes] | None = None  # (version_code, raw_icon)

    for apk in app.apks:
        if apk.status != ApkStatus.PUBLISHED:
            continue
        try:
            tmp_path = await _download_apk(apk.storage_key)
        except Exception as exc:  # noqa: BLE001
            result.failed.append(f"{apk.file_name}: download failed: {exc}")
            continue
        try:
            meta: ApkMetadata = await parse_apk(tmp_path)
            apk.permissions = meta.permissions
            apk.features = meta.features
            apk.native_code = meta.native_code
            apk.locales = meta.locales
            result.rescanned_apks += 1
            if meta.icon_data:
                if latest_with_icon is None or apk.version_code > latest_with_icon[0]:
                    latest_with_icon = (apk.version_code, meta.icon_data)
        except ApkParseError as exc:
            result.failed.append(f"{apk.file_name}: {exc}")
        except Exception as exc:  # noqa: BLE001
            result.failed.append(f"{apk.file_name}: {exc}")
        finally:
            tmp_path.unlink(missing_ok=True)

    # Refresh icon from the most-recent APK that carried one. Custom icons
    # are sticky: an admin upload via /apps/{id}/icon won't be overwritten.
    if latest_with_icon and not app.icon_is_custom:
        try:
            png = _icon_to_png_bytes(latest_with_icon[1])
            icon_key = f"icons/{app.package_name}.png"
            await storage.put(icon_key, png, content_type="image/png")
            app.icon_path = icon_key
            result.icons_refreshed += 1
        except Exception as exc:  # noqa: BLE001
            result.failed.append(f"{app.package_name} icon: {exc}")

    await db.flush()
    return result


async def rescan_all_apps(db: AsyncSession) -> RescanResult:
    apps = (
        await db.execute(
            select(App).options(selectinload(App.apks))
        )
    ).scalars().unique().all()
    combined = RescanResult()
    for app in apps:
        r = await rescan_app(db, app)
        combined.rescanned_apks += r.rescanned_apks
        combined.icons_refreshed += r.icons_refreshed
        combined.failed.extend(r.failed)
    return combined
