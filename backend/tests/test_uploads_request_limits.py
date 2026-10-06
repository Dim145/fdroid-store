"""Body-size guard for non-upload routes and the IntegrityError → 409 mapping."""
from __future__ import annotations

import re
from collections.abc import AsyncIterator
from typing import Annotated

import httpx
import pytest
from fastapi import Depends, FastAPI, Request
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError

from app.main import UPLOAD_ROUTES, BodySizeLimitMiddleware, app, integrity_error_handler

LIMIT = 1024


class _Login(BaseModel):
    username: str


def _tiny_app() -> tuple[FastAPI, list[str]]:
    calls: list[str] = []
    tiny = FastAPI()
    tiny.add_middleware(BodySizeLimitMiddleware, max_bytes=LIMIT)

    @tiny.post("/api/v1/auth/login")
    async def login(body: _Login) -> dict:
        calls.append("login")
        return {"len": len(body.username)}

    @tiny.post("/api/v1/apks/inspect")
    async def inspect(request: Request) -> dict:
        calls.append("inspect")
        return {"len": len(await request.body())}

    return tiny, calls


def _client(asgi: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=asgi), base_url="http://t")


async def test_oversized_json_is_refused_from_content_length() -> None:
    tiny, calls = _tiny_app()
    async with _client(tiny) as c:
        r = await c.post("/api/v1/auth/login", json={"username": "x" * (2 * LIMIT)})
    assert r.status_code == 413
    assert r.json() == {"detail": "Request body too large"}
    assert calls == []


async def test_oversized_chunked_body_is_refused_while_streaming() -> None:
    tiny, calls = _tiny_app()

    async def chunks() -> AsyncIterator[bytes]:
        yield b'{"username": "'
        for _ in range(4):
            yield b"x" * 512
        yield b'"}'

    async with _client(tiny) as c:
        r = await c.post(
            "/api/v1/auth/login", content=chunks(), headers={"content-type": "application/json"}
        )
    assert r.status_code == 413
    assert calls == []


async def test_small_json_goes_through() -> None:
    tiny, calls = _tiny_app()
    async with _client(tiny) as c:
        r = await c.post("/api/v1/auth/login", json={"username": "alice"})
    assert r.status_code == 200
    assert calls == ["login"]


async def test_upload_routes_are_exempt() -> None:
    tiny, _ = _tiny_app()
    async with _client(tiny) as c:
        r = await c.post("/api/v1/apks/inspect", content=b"a" * (4 * LIMIT))
    assert r.status_code == 200
    assert r.json() == {"len": 4 * LIMIT}


def test_every_multipart_route_of_the_real_app_is_exempt() -> None:
    multipart: list[str] = []
    for path, operations in app.openapi()["paths"].items():
        for operation in operations.values():
            content = (operation.get("requestBody") or {}).get("content", {})
            if "multipart/form-data" in content or "application/x-www-form-urlencoded" in content:
                multipart.append(re.sub(r"\{[^}]+\}", "x", path))
    assert len(multipart) >= 10
    assert [p for p in multipart if not UPLOAD_ROUTES.search(p)] == []
    for json_route in ("/api/v1/auth/login", "/api/v1/apps/import-metadata",
                       "/api/v1/apks/upload-staged/x", "/api/v1/apps/x/screenshots/reorder"):
        assert not UPLOAD_ROUTES.search(json_route)


# --------------------------------------------------------------------------
# IntegrityError → 409
# --------------------------------------------------------------------------
def _conflict() -> IntegrityError:
    return IntegrityError(
        "INSERT INTO apps …", {}, Exception('duplicate key "apps_package_name_key"')
    )


async def _commit_fails() -> AsyncIterator[None]:
    yield
    raise _conflict()  # like get_db's commit at the end of the request


async def test_integrity_errors_become_a_bare_409() -> None:
    tiny = FastAPI()
    tiny.add_exception_handler(IntegrityError, integrity_error_handler)

    @tiny.post("/flush")
    async def flush() -> dict:
        raise _conflict()

    @tiny.post("/commit")
    async def commit(_: Annotated[None, Depends(_commit_fails, scope="function")]) -> dict:
        return {"ok": True}

    async with _client(tiny) as c:
        for path in ("/flush", "/commit"):
            r = await c.post(path)
            assert r.status_code == 409, path
            assert r.json() == {"detail": "Conflict with existing data"}


def test_the_real_app_registers_both() -> None:
    assert IntegrityError in app.exception_handlers
    assert any(m.cls is BodySizeLimitMiddleware for m in app.user_middleware)


@pytest.mark.parametrize("value", [b"abc", b"-1", b""])
async def test_garbage_content_length_does_not_crash(value: bytes) -> None:
    sent: list[dict] = []

    async def inner(scope, receive, send) -> None:  # type: ignore[no-untyped-def]
        sent.append(scope)

    mw = BodySizeLimitMiddleware(inner, max_bytes=LIMIT)

    async def receive() -> dict:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict) -> None:
        pass

    scope = {"type": "http", "path": "/api/v1/auth/login", "headers": [(b"content-length", value)]}
    await mw(scope, receive, send)
    assert sent  # passed through; the server itself rejects a bad header
