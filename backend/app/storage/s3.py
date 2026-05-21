from __future__ import annotations

from collections.abc import AsyncIterator
from typing import BinaryIO

import aioboto3
from botocore.config import Config

from app.core.config import settings
from app.storage.base import Storage


class S3Storage(Storage):
    """S3-compatible backend (works with MinIO, Wasabi, Backblaze, ...)."""

    CHUNK = 5 * 1024 * 1024  # 5 MiB — also the S3 multipart minimum

    def __init__(
        self,
        bucket: str,
        endpoint_url: str | None,
        region: str,
        access_key: str | None,
        secret_key: str | None,
        path_style: bool,
        public_base_url: str | None = None,
    ) -> None:
        self.bucket = bucket
        self.endpoint_url = endpoint_url
        self.region = region
        self.access_key = access_key
        self.secret_key = secret_key
        self.path_style = path_style
        self.public_base_url = public_base_url.rstrip("/") if public_base_url else None
        self._session = aioboto3.Session()

    # ------------------------------------------------------------------
    def _client_kwargs(self) -> dict:
        cfg = Config(
            signature_version="s3v4",
            s3={"addressing_style": "path" if self.path_style else "virtual"},
        )
        kwargs: dict = {"region_name": self.region, "config": cfg}
        if self.endpoint_url:
            kwargs["endpoint_url"] = self.endpoint_url
        if self.access_key and self.secret_key:
            kwargs["aws_access_key_id"] = self.access_key
            kwargs["aws_secret_access_key"] = self.secret_key
        return kwargs

    def _client(self):
        return self._session.client("s3", **self._client_kwargs())

    # ------------------------------------------------------------------
    async def put(self, key: str, data: bytes | BinaryIO, content_type: str | None = None) -> None:
        async with self._client() as s3:
            body = data if isinstance(data, (bytes, bytearray)) else data.read()
            extra: dict = {}
            if content_type:
                extra["ContentType"] = content_type
            await s3.put_object(Bucket=self.bucket, Key=key, Body=body, **extra)

    async def put_stream(self, key: str, source: AsyncIterator[bytes], content_type: str | None = None) -> int:
        # Buffer chunks up to CHUNK bytes then upload as multipart. Simpler:
        # accumulate fully in memory if size is small, otherwise multipart.
        async with self._client() as s3:
            extra: dict = {"Bucket": self.bucket, "Key": key}
            if content_type:
                extra["ContentType"] = content_type
            upload = await s3.create_multipart_upload(**extra)
            upload_id = upload["UploadId"]
            parts: list[dict] = []
            buf = bytearray()
            total = 0
            part_no = 1
            try:
                async for chunk in source:
                    if not chunk:
                        continue
                    buf.extend(chunk)
                    total += len(chunk)
                    if len(buf) >= self.CHUNK:
                        resp = await s3.upload_part(
                            Bucket=self.bucket,
                            Key=key,
                            PartNumber=part_no,
                            UploadId=upload_id,
                            Body=bytes(buf),
                        )
                        parts.append({"PartNumber": part_no, "ETag": resp["ETag"]})
                        part_no += 1
                        buf.clear()
                if buf or part_no == 1:
                    resp = await s3.upload_part(
                        Bucket=self.bucket,
                        Key=key,
                        PartNumber=part_no,
                        UploadId=upload_id,
                        Body=bytes(buf),
                    )
                    parts.append({"PartNumber": part_no, "ETag": resp["ETag"]})
                await s3.complete_multipart_upload(
                    Bucket=self.bucket,
                    Key=key,
                    UploadId=upload_id,
                    MultipartUpload={"Parts": parts},
                )
            except Exception:
                await s3.abort_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id)
                raise
        return total

    async def get_bytes(self, key: str) -> bytes:
        async with self._client() as s3:
            resp = await s3.get_object(Bucket=self.bucket, Key=key)
            async with resp["Body"] as stream:
                return await stream.read()

    async def open_stream(self, key: str) -> AsyncIterator[bytes]:
        # We open the client/stream within an async generator so resources are
        # released when iteration stops.
        #
        # aiobotocore 2.x exposes the raw aiohttp ``ClientResponse`` as the
        # body wrapper, whose ``read()`` no longer accepts a chunk-size
        # argument — calling ``await stream.read(N)`` raises
        # ``TypeError: ClientResponse.read() takes 1 positional argument
        # but 2 were given``. The right primitive is the underlying
        # ``StreamReader.iter_chunked`` on ``stream.content``, which
        # yields up-to-N-byte chunks as the network delivers them.
        client_ctx = self._client()

        async def _gen() -> AsyncIterator[bytes]:
            async with client_ctx as s3:
                resp = await s3.get_object(Bucket=self.bucket, Key=key)
                async with resp["Body"] as stream:
                    async for chunk in stream.content.iter_chunked(self.CHUNK):
                        yield chunk

        return _gen()

    async def delete(self, key: str) -> None:
        async with self._client() as s3:
            await s3.delete_object(Bucket=self.bucket, Key=key)

    async def exists(self, key: str) -> bool:
        async with self._client() as s3:
            try:
                await s3.head_object(Bucket=self.bucket, Key=key)
                return True
            except Exception:  # noqa: BLE001 — ClientError 404
                return False

    async def size(self, key: str) -> int:
        async with self._client() as s3:
            resp = await s3.head_object(Bucket=self.bucket, Key=key)
            return int(resp["ContentLength"])

    def public_url(self, key: str) -> str | None:
        if self.public_base_url:
            return f"{self.public_base_url}/{key}"
        if self.endpoint_url:
            base = self.endpoint_url.rstrip("/")
            if self.path_style:
                return f"{base}/{self.bucket}/{key}"
            # virtual-hosted style
            return f"{base.replace('//', f'//{self.bucket}.')}/{key}"
        return None


def s3_storage_from_settings() -> S3Storage:
    return S3Storage(
        bucket=settings.s3_bucket,
        endpoint_url=settings.s3_endpoint_url,
        region=settings.s3_region,
        access_key=settings.s3_access_key,
        secret_key=settings.s3_secret_key,
        path_style=settings.s3_use_path_style,
        public_base_url=settings.s3_public_base_url,
    )
