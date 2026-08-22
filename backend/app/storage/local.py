from __future__ import annotations

import os
import re
from collections.abc import AsyncIterator
from pathlib import Path
from typing import BinaryIO
from uuid import uuid4

import aiofiles

from app.storage.base import Storage


class LocalStorage(Storage):
    """File-system backend rooted at ``base_path``."""

    CHUNK = 1024 * 1024  # 1 MiB

    def __init__(self, base_path: str | Path) -> None:
        self.base = Path(base_path).resolve()
        self.base.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    def _resolve(self, key: str) -> Path:
        # CodeQL ``py/path-injection`` barrier. The previous shape here —
        # ``(self.base / key).resolve()`` then ``relative_to(self.base)`` —
        # is correct at runtime but the analyser's data-flow tracker does
        # not recognise ``resolve()``/``relative_to`` as a sanitiser, so the
        # caller-supplied key still "reached" the filesystem op. Instead we
        # validate every path segment against a bounded allowlist (letters,
        # digits, ``.`` ``_`` ``-`` only — never ``.``/``..`` on their own,
        # never a separator inside a segment) and then rebuild the path from
        # the hard-coded, already-resolved ``self.base`` via ``joinpath``.
        # The path handed to the FS op is now a constant prefix + allowlisted
        # data, and we deliberately never call ``resolve()``/``realpath()``
        # on the caller string afterward (that would re-introduce the taint
        # the allowlist just stripped). Bounded ``{1,255}`` keeps the regex
        # ReDoS-free. Every real storage key — ``staging/<sha>.apk``,
        # ``fdroid/repo/<pkg>_<vc>.apk``, ``fdroid/repo/icons/<pkg>.png``,
        # ``fdroid/repo/<pkg>/<locale>/phoneScreenshots/<uuid>.png`` — is
        # built server-side from exactly these characters, so the allowlist
        # never rejects a legitimate key.
        if key.startswith("/"):
            raise ValueError("Storage keys must be relative")
        segments = key.split("/")
        for seg in segments:
            if seg in (".", "..") or not re.fullmatch(r"[A-Za-z0-9._-]{1,255}", seg):
                raise ValueError(f"Key escapes storage root: {key!r}")
        return self.base.joinpath(*segments)

    # ------------------------------------------------------------------
    def _tmp_sibling(self, target: Path) -> Path:
        """A unique temp path in the SAME directory as ``target`` so the
        final ``os.replace`` is a same-filesystem atomic rename."""
        return target.with_name(f".{target.name}.{uuid4().hex}.tmp")

    async def put(self, key: str, data: bytes | BinaryIO, content_type: str | None = None) -> None:
        target = self._resolve(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        # Atomic publish: write a sibling temp file, then atomically rename it
        # over the target. A concurrent reader (e.g. the F-Droid serving route
        # streaming index-v2.json while a reindex overwrites it) then always
        # sees the whole old file or the whole new file — never a truncated
        # one. Without this, in-place "wb" truncation hands out a corrupt /
        # short index mid-write.
        tmp = self._tmp_sibling(target)
        try:
            async with aiofiles.open(tmp, "wb") as f:
                if isinstance(data, (bytes, bytearray)):
                    await f.write(data)
                else:
                    while True:
                        chunk = data.read(self.CHUNK)
                        if not chunk:
                            break
                        await f.write(chunk)
            os.replace(tmp, target)
        finally:
            if tmp.exists():
                tmp.unlink(missing_ok=True)

    async def put_stream(self, key: str, source: AsyncIterator[bytes], content_type: str | None = None) -> int:
        target = self._resolve(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._tmp_sibling(target)
        total = 0
        try:
            async with aiofiles.open(tmp, "wb") as f:
                async for chunk in source:
                    if not chunk:
                        continue
                    await f.write(chunk)
                    total += len(chunk)
            os.replace(tmp, target)
        finally:
            if tmp.exists():
                tmp.unlink(missing_ok=True)
        return total

    async def get_bytes(self, key: str) -> bytes:
        target = self._resolve(key)
        async with aiofiles.open(target, "rb") as f:
            return await f.read()

    async def open_stream(self, key: str) -> AsyncIterator[bytes]:
        target = self._resolve(key)

        async def _gen() -> AsyncIterator[bytes]:
            async with aiofiles.open(target, "rb") as f:
                while True:
                    chunk = await f.read(self.CHUNK)
                    if not chunk:
                        break
                    yield chunk

        return _gen()

    async def delete(self, key: str) -> None:
        target = self._resolve(key)
        if target.exists():
            target.unlink()

    async def exists(self, key: str) -> bool:
        return self._resolve(key).exists()

    async def size(self, key: str) -> int:
        return self._resolve(key).stat().st_size

    def local_path(self, key: str) -> Path:
        return self._resolve(key)
