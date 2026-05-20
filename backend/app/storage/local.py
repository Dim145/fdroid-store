from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import BinaryIO

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
        if key.startswith("/"):
            raise ValueError("Storage keys must be relative")
        target = (self.base / key).resolve()
        # Make sure we can't escape the base via "../" traversal.
        try:
            target.relative_to(self.base)
        except ValueError as exc:
            raise ValueError(f"Key escapes storage root: {key!r}") from exc
        return target

    # ------------------------------------------------------------------
    async def put(self, key: str, data: bytes | BinaryIO, content_type: str | None = None) -> None:
        target = self._resolve(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        async with aiofiles.open(target, "wb") as f:
            if isinstance(data, (bytes, bytearray)):
                await f.write(data)
            else:
                while True:
                    chunk = data.read(self.CHUNK)
                    if not chunk:
                        break
                    await f.write(chunk)

    async def put_stream(self, key: str, source: AsyncIterator[bytes], content_type: str | None = None) -> int:
        target = self._resolve(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        total = 0
        async with aiofiles.open(target, "wb") as f:
            async for chunk in source:
                if not chunk:
                    continue
                await f.write(chunk)
                total += len(chunk)
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
