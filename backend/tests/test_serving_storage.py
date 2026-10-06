"""S3 backend: ``exists`` only says "missing" for a real 404, and ``put``
streams file objects instead of reading them whole. Stubbed client, no S3."""
from __future__ import annotations

import io
from typing import Any

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from app.storage.s3 import S3Storage


def _client_error(code: str, status: int) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": "x"}, "ResponseMetadata": {"HTTPStatusCode": status}},
        "HeadObject",
    )


class FakeS3:
    def __init__(self, head_error: Exception | None = None) -> None:
        self.head_error = head_error
        self.puts: list[dict[str, Any]] = []
        self.parts: list[bytes] = []
        self.completed = False

    async def __aenter__(self) -> FakeS3:
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        return False

    async def head_object(self, Bucket: str, Key: str) -> dict[str, Any]:
        if self.head_error is not None:
            raise self.head_error
        return {"ContentLength": 1}

    async def put_object(self, **kw: Any) -> None:
        self.puts.append(kw)

    async def create_multipart_upload(self, **kw: Any) -> dict[str, str]:
        return {"UploadId": "u-1"}

    async def upload_part(self, **kw: Any) -> dict[str, str]:
        self.parts.append(kw["Body"])
        return {"ETag": f"e{kw['PartNumber']}"}

    async def complete_multipart_upload(self, **kw: Any) -> None:
        self.completed = True

    async def abort_multipart_upload(self, **kw: Any) -> None:
        raise AssertionError("upload aborted")


def _storage(fake: FakeS3, chunk: int | None = None) -> S3Storage:
    storage = S3Storage(
        bucket="b", endpoint_url="http://s3.invalid", region="us-east-1",
        access_key=None, secret_key=None, path_style=True,
    )
    storage._client = lambda: fake  # type: ignore[method-assign]
    if chunk is not None:
        storage.CHUNK = chunk
    return storage


# --------------------------------------------------------------------------
# exists()
# --------------------------------------------------------------------------
async def test_exists_true() -> None:
    assert await _storage(FakeS3()).exists("k") is True


@pytest.mark.parametrize(("code", "status"), [("404", 404), ("NoSuchKey", 404), ("NotFound", 404)])
async def test_exists_false_only_for_a_missing_key(code: str, status: int) -> None:
    assert await _storage(FakeS3(_client_error(code, status))).exists("k") is False


@pytest.mark.parametrize(
    "error",
    [
        _client_error("403", 403),  # misconfigured credentials / policy
        _client_error("503", 503),  # SlowDown / overloaded
        _client_error("InternalError", 500),
        EndpointConnectionError(endpoint_url="http://s3.invalid"),
        TimeoutError(),
    ],
)
async def test_exists_raises_on_anything_else(error: Exception) -> None:
    with pytest.raises(type(error)):
        await _storage(FakeS3(error)).exists("k")


# --------------------------------------------------------------------------
# put()
# --------------------------------------------------------------------------
class GuardedFile(io.BytesIO):
    """Fails the test if anything tries to read the whole file at once."""

    def __init__(self, data: bytes, limit: int) -> None:
        super().__init__(data)
        self.limit = limit

    def read(self, size: int | None = -1) -> bytes:
        assert size is not None and 0 < size <= self.limit, f"unbounded read({size})"
        return super().read(size)


async def test_small_file_object_is_one_put() -> None:
    fake = FakeS3()
    await _storage(fake, chunk=8).put("k", GuardedFile(b"tiny", limit=8), content_type="x/y")
    assert fake.puts == [{"Bucket": "b", "Key": "k", "Body": b"tiny", "ContentType": "x/y"}]
    assert fake.parts == []


async def test_large_file_object_streams_as_multipart() -> None:
    data = bytes(range(256)) * 3 + b"tail"  # 772 bytes, chunk 100
    fake = FakeS3()
    await _storage(fake, chunk=100).put("apks/x.apk", GuardedFile(data, limit=100))
    assert fake.puts == []
    assert fake.completed
    assert b"".join(fake.parts) == data
    assert all(len(p) >= 100 for p in fake.parts[:-1])  # multipart minimum


async def test_bytes_are_still_one_put() -> None:
    fake = FakeS3()
    await _storage(fake, chunk=4).put("k", b"0123456789")
    assert [p["Body"] for p in fake.puts] == [b"0123456789"]
