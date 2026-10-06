"""Forge credentials stay on the forge; partial downloads never linger."""
from __future__ import annotations

import tempfile
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from app.services import github_releases as gr

Handler = Callable[[httpx.Request], httpx.Response]


@pytest.fixture(autouse=True)
def _no_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    # Host names in these tests are fake; skip the resolver-based pre-check.
    monkeypatch.setattr(gr, "_resolves_to_blocked", lambda host: False)


def _mock_forge(monkeypatch: pytest.MonkeyPatch, handler: Handler) -> list[httpx.Request]:
    """Route every client the module builds through ``handler``; returns
    the list of requests it saw."""
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    def fake_client(_is_blocked: object, **kwargs: object) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(record), **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(gr, "make_ssrf_client", fake_client)
    return seen


def _asset(
    url: str, *, provider: str, forge_url: str | None, token: str | None = "T0K"  # noqa: S107
) -> gr.ReleaseAsset:
    return gr.ReleaseAsset(
        release_tag="v1",
        release_name=None,
        release_published_at=datetime(2026, 1, 1, tzinfo=UTC),
        is_prerelease=False,
        asset_id=1,
        asset_name="app.apk",
        asset_size=3,
        asset_download_url=url,
        provider=provider,
        auth_token=token,
        forge_url=forge_url,
    )


def _has_credential(request: httpx.Request) -> bool:
    return "authorization" in request.headers or "private-token" in request.headers


async def test_gitlab_link_to_another_host_gets_no_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen = _mock_forge(monkeypatch, lambda r: httpx.Response(200, content=b"apk"))
    path = await gr.download_asset(
        _asset("https://evil.example/app.apk", provider="gitlab", forge_url="https://gitlab.com")
    )
    path.unlink()
    assert not _has_credential(seen[0])


async def test_link_on_the_forge_host_is_authenticated(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _mock_forge(monkeypatch, lambda r: httpx.Response(200, content=b"apk"))
    path = await gr.download_asset(
        _asset("https://gitlab.com/g/p/-/package_files/1/download", provider="gitlab",
               forge_url="https://gitlab.com")
    )
    path.unlink()
    assert seen[0].headers["private-token"] == "T0K"


async def test_stripped_credential_is_never_re_added(monkeypatch: pytest.MonkeyPatch) -> None:
    hops = {
        "/r/app.apk": "https://cdn.example/x",          # forge → elsewhere
        "/x": "https://codeberg.org/back/app.apk",      # … → forge again
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path in hops:
            return httpx.Response(302, headers={"location": hops[request.url.path]})
        return httpx.Response(200, content=b"apk")

    seen = _mock_forge(monkeypatch, handler)
    path = await gr.download_asset(
        _asset("https://codeberg.org/r/app.apk", provider="gitea", forge_url="https://codeberg.org")
    )
    path.unlink()
    assert [str(r.url.host) for r in seen] == ["codeberg.org", "cdn.example", "codeberg.org"]
    assert [_has_credential(r) for r in seen] == [True, False, False]


async def test_same_origin_redirect_keeps_then_cross_origin_drops(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hops = {"/a": "/b", "/b": "https://objects.example/c", "/c": None}

    def handler(request: httpx.Request) -> httpx.Response:
        nxt = hops.get(request.url.path)
        if nxt:
            return httpx.Response(302, headers={"location": nxt})
        return httpx.Response(200, content=b"apk")

    seen = _mock_forge(monkeypatch, handler)
    path = await gr.download_asset(
        _asset("https://ghe.example/a", provider="github", forge_url="https://ghe.example/api/v3")
    )
    path.unlink()
    # The relative redirect resolves against the hop that sent it.
    assert [str(r.url) for r in seen] == [
        "https://ghe.example/a", "https://ghe.example/b", "https://objects.example/c",
    ]
    assert [_has_credential(r) for r in seen] == [True, True, False]


async def test_scheme_downgrade_on_the_forge_host_drops_the_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.scheme == "https":
            return httpx.Response(302, headers={"location": "http://gitlab.com/plain"})
        return httpx.Response(200, content=b"apk")

    seen = _mock_forge(monkeypatch, handler)
    path = await gr.download_asset(
        _asset("https://gitlab.com/x", provider="gitlab", forge_url="https://gitlab.com")
    )
    path.unlink()
    assert [_has_credential(r) for r in seen] == [True, False]


async def test_asset_without_forge_url_downloads_anonymously(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen = _mock_forge(monkeypatch, lambda r: httpx.Response(200, content=b"apk"))
    path = await gr.download_asset(
        _asset("https://gitlab.com/x", provider="gitlab", forge_url=None)
    )
    path.unlink()
    assert not _has_credential(seen[0])


# --------------------------------------------------------------------------
# Server-wide env tokens: canonical public host only
# --------------------------------------------------------------------------
def test_env_token_only_without_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gr.settings, "gitlab_token", "ENV")
    assert gr._resolve_token("gitlab", None, None) == "ENV"
    assert gr._resolve_token("gitlab", None, "https://git.example.org") is None
    assert gr._resolve_token("gitlab", "PAT", "https://git.example.org") == "PAT"


async def test_self_hosted_forge_never_sees_the_env_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(gr.settings, "gitlab_token", "ENV")
    seen = _mock_forge(monkeypatch, lambda r: httpx.Response(200, json=[]))
    assert await gr.find_latest_asset(
        "group/project", asset_pattern=None, include_prereleases=False,
        provider="gitlab", base_url="https://git.example.org",
    ) is None
    assert seen[0].url.host == "git.example.org"
    assert not _has_credential(seen[0])


async def test_canonical_forge_gets_the_env_token_and_binds_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(gr.settings, "gitlab_token", "ENV")
    release = {
        "tag_name": "v2",
        "released_at": "2026-01-01T00:00:00Z",
        "assets": {"links": [{"name": "app.apk", "url": "https://elsewhere.example/app.apk"}]},
    }
    seen = _mock_forge(monkeypatch, lambda r: httpx.Response(200, json=[release]))
    asset = await gr.find_latest_asset(
        "group/project", asset_pattern=None, include_prereleases=False, provider="gitlab",
    )
    assert seen[0].headers["private-token"] == "ENV"
    assert asset is not None
    assert asset.auth_token == "ENV"  # noqa: S105
    assert asset.forge_url == "https://gitlab.com"


# --------------------------------------------------------------------------
# Temp files
# --------------------------------------------------------------------------
class _BrokenStream(httpx.AsyncByteStream):
    async def __aiter__(self) -> AsyncIterator[bytes]:
        yield b"partial apk bytes"
        raise httpx.ReadError("connection reset")


def _track_tempfiles(monkeypatch: pytest.MonkeyPatch) -> list[Path]:
    created: list[Path] = []
    real = tempfile.NamedTemporaryFile

    def tracking(*args: object, **kwargs: object):  # type: ignore[no-untyped-def]
        handle = real(*args, **kwargs)  # type: ignore[call-overload]
        created.append(Path(handle.name))
        return handle

    monkeypatch.setattr(gr.tempfile, "NamedTemporaryFile", tracking)
    return created


async def test_mid_stream_failure_removes_the_partial_file(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = _track_tempfiles(monkeypatch)
    _mock_forge(monkeypatch, lambda r: httpx.Response(200, stream=_BrokenStream()))
    with pytest.raises(gr.GithubReleaseError, match="Download error"):
        await gr.download_asset(_asset("https://gitlab.com/x", provider="gitlab", forge_url=None))
    assert created
    assert not any(p.exists() for p in created)


async def test_over_the_cap_removes_the_partial_file(monkeypatch: pytest.MonkeyPatch) -> None:
    created = _track_tempfiles(monkeypatch)
    with pytest.raises(gr.GithubReleaseError, match="hard cap"):
        await gr._stream_to_tempfile(httpx.Response(200, content=b"x" * 64), cap=16)
    assert created
    assert not any(p.exists() for p in created)
