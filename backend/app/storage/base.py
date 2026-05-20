"""Storage abstraction.

Backends implement the same async interface so callers don't care whether the
file lives on local disk or in S3-compatible object storage.

Keys are forward-slash separated paths, never starting with ``/``:
    apks/com.example.app/com.example.app_42.apk
    icons/com.example.app.42.png
    repo/index-v1.jar

Backends can also stream from local disk: the local backend exposes
:meth:`local_path` which the HTTP layer uses to hand off serving to nginx via
``X-Accel-Redirect``.
"""
from __future__ import annotations

import abc
from collections.abc import AsyncIterator
from pathlib import Path
from typing import BinaryIO


class Storage(abc.ABC):
    """Async storage interface."""

    @abc.abstractmethod
    async def put(self, key: str, data: bytes | BinaryIO, content_type: str | None = None) -> None: ...

    @abc.abstractmethod
    async def put_stream(self, key: str, source: AsyncIterator[bytes], content_type: str | None = None) -> int:
        """Stream-write `source` to `key`. Returns the total bytes written."""

    @abc.abstractmethod
    async def get_bytes(self, key: str) -> bytes: ...

    @abc.abstractmethod
    async def open_stream(self, key: str) -> AsyncIterator[bytes]: ...

    @abc.abstractmethod
    async def delete(self, key: str) -> None: ...

    @abc.abstractmethod
    async def exists(self, key: str) -> bool: ...

    @abc.abstractmethod
    async def size(self, key: str) -> int: ...

    # Optional hooks ----------------------------------------------------------
    def local_path(self, key: str) -> Path | None:
        """Return the on-disk path if the backend supports direct serving."""
        return None

    def public_url(self, key: str) -> str | None:
        """Return a public URL if the backend serves files itself (e.g. S3)."""
        return None
