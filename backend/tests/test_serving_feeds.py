"""RSS / Atom feeds (``app.api.v1.feeds``): private-mode gate, no package
oracle on the per-app feed, API-key scope, links, and SQL-side filtering."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.dialects import postgresql

from app.api.v1 import feeds
from app.core.config import settings
from app.core.database import get_db
from app.models.apk import ApkStatus
from app.models.app import AppStatus, AppVisibility
from app.models.user import UserRole

T0 = datetime(2020, 1, 1, tzinfo=UTC)
T1 = datetime(2026, 9, 1, tzinfo=UTC)


class _Scalars:
    def __init__(self, rows: list[Any]) -> None:
        self.rows = rows

    def all(self) -> list[Any]:
        return self.rows


class _Result:
    def __init__(self, value: Any) -> None:
        self._value = value

    def scalar_one_or_none(self) -> Any:
        return self._value

    def scalars(self) -> _Scalars:
        return _Scalars(self._value)


class FakeDb:
    def __init__(self, *results: Any) -> None:
        self.results = list(results)
        self.statements: list[Any] = []

    async def execute(self, stmt: Any) -> _Result:
        self.statements.append(stmt)
        if not self.results:
            raise AssertionError(f"unexpected query: {stmt}")
        return _Result(self.results.pop(0))


def _sql(stmt: Any) -> str:
    return str(
        stmt.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True})
    )


@pytest.fixture(autouse=True)
def _urls(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "public_app_url", "https://store.example/")
    monkeypatch.setattr(settings, "public_api_url", "https://api.store.example")


def _app(**kw: Any) -> SimpleNamespace:
    fields: dict[str, Any] = {
        "id": uuid.uuid4(),
        "package_name": "org.example.app",
        "name": "Example",
        "summary": "An example",
        "owner_id": uuid.uuid4(),
        "visibility": AppVisibility.PUBLIC,
        "status": AppStatus.PUBLISHED,
        "created_at": T0,
        "first_published_at": T1,
        "last_published_at": T1,
        "apks": [],
    }
    fields.update(kw)
    return SimpleNamespace(**fields)


# --------------------------------------------------------------------------
# Links
# --------------------------------------------------------------------------
def test_links_point_at_the_web_app_and_the_api() -> None:
    assert feeds._app_link("org.example.app") == "https://store.example/apps/org.example.app"
    assert feeds._self_link("/feed/new") == "https://api.store.example/api/v1/feed/new"
    entry = feeds._atom_entry(_app(), T1, "")
    assert 'href="https://store.example/apps/org.example.app"' in entry
    assert "/fdroid/repo" not in entry


async def test_new_feed_shows_first_publication_and_absolute_self_link() -> None:
    db = FakeDb([_app()])
    resp = await feeds.feed_new(
        db=db, request=SimpleNamespace(headers={}), format="atom",
        category=None, author=None, nsfw="off", limit=20,
    )
    body = resp.body.decode()
    assert '<link rel="self" href="https://api.store.example/api/v1/feed/new"/>' in body
    assert "<updated>2026-09-01T00:00:00Z</updated>" in body  # first_published_at
    assert "2020-01-01" not in body  # not the draft's created_at


# --------------------------------------------------------------------------
# SQL: filters before LIMIT, publication order
# --------------------------------------------------------------------------
async def _loader_sql(**kw: Any) -> str:
    db = FakeDb([])
    params: dict[str, Any] = {
        "order_by": feeds.func.coalesce(feeds.App.first_published_at, feeds.App.created_at),
        "category": None,
        "author": None,
        "nsfw_visible": False,
        "limit": 20,
    }
    params.update(kw)
    await feeds._load_apps_for_feed(db, **params)
    (stmt,) = db.statements
    return _sql(stmt)


async def test_filters_run_in_sql_before_the_limit() -> None:
    sql = await _loader_sql(category="Games", author="Alice")
    where, _, tail = sql.partition("ORDER BY")
    assert "json_array_elements_text" in where
    assert "lower(btrim(nsfw_flag.value)) = 'nsfw'" in where
    assert "NOT (EXISTS" in where
    assert "categories.name = 'Games'" in where
    assert "apps.author_name = 'Alice'" in where
    assert "coalesce(apps.first_published_at, apps.created_at) DESC" in tail
    assert tail.rstrip().endswith("LIMIT 20")  # no over-fetch


async def test_nsfw_on_drops_the_nsfw_filter() -> None:
    sql = await _loader_sql(nsfw_visible=True)
    assert "nsfw" not in sql
    assert "categories" not in sql


async def test_nsfw_predicate_tolerates_non_array_json() -> None:
    sql = _sql(feeds.select(feeds.App.id).where(feeds._has_nsfw_apk()))
    assert "json_typeof(apks.anti_features) = 'array'" in sql
    assert "json_build_array()" in sql
    assert "apks.app_id = apps.id" in sql


# --------------------------------------------------------------------------
# Private-app feed gate
# --------------------------------------------------------------------------
async def test_admin_viewer_sees_private_apps() -> None:
    admin = SimpleNamespace(id=uuid.uuid4(), role=UserRole.ADMIN)
    assert await feeds._can_see_private_app(FakeDb(), _app(), admin, None)


async def test_api_key_needs_the_private_scope() -> None:
    app = _app(visibility=AppVisibility.PRIVATE)
    key = SimpleNamespace(user_id=app.owner_id, can_download_private=False)
    # Not even a lookup: the key isn't allowed to read private apps at all.
    assert not await feeds._can_see_private_app(FakeDb(), app, None, key)


async def test_api_key_of_a_disabled_owner_is_refused() -> None:
    app = _app(visibility=AppVisibility.PRIVATE)
    key = SimpleNamespace(user_id=app.owner_id, can_download_private=True)
    owner = SimpleNamespace(id=app.owner_id, role=UserRole.UPLOADER, is_active=False)
    assert not await feeds._can_see_private_app(FakeDb(owner), app, None, key)
    owner.is_active = True
    assert await feeds._can_see_private_app(FakeDb(owner), app, None, key)


async def _release_feed(db: FakeDb, *, viewer=None, api_key=None, package="org.example.app"):
    return await feeds.feed_app_releases(
        package, db=db, request=SimpleNamespace(headers={}),
        viewer=viewer, api_key=api_key, format="atom", limit=20,
    )


@pytest.mark.parametrize(
    "found",
    [
        None,  # unknown package
        _app(visibility=AppVisibility.PRIVATE),  # private, exists
        _app(status=AppStatus.ARCHIVED),  # taken down
    ],
)
async def test_anonymous_probe_cannot_tell_private_from_unknown(found) -> None:
    with pytest.raises(HTTPException) as exc:
        await _release_feed(FakeDb(found))
    assert exc.value.status_code == 401
    assert exc.value.headers == {"WWW-Authenticate": 'Basic realm="fdroid-store"'}


async def test_authenticated_but_not_entitled_is_a_404_like_unknown() -> None:
    viewer = SimpleNamespace(id=uuid.uuid4(), role=UserRole.USER)
    for db in (FakeDb(None), FakeDb(_app(visibility=AppVisibility.PRIVATE), None)):
        with pytest.raises(HTTPException) as exc:
            await _release_feed(db, viewer=viewer)
        assert exc.value.status_code == 404


async def test_owner_reads_their_private_release_feed() -> None:
    owner = SimpleNamespace(id=uuid.uuid4(), role=UserRole.UPLOADER)
    apk = SimpleNamespace(
        id=uuid.uuid4(), status=ApkStatus.PUBLISHED, version_code=3, version_name="1.3",
        whats_new={"en-US": "Fixes"}, created_at=T1,
    )
    app = _app(visibility=AppVisibility.PRIVATE, owner_id=owner.id, apks=[apk])
    resp = await _release_feed(FakeDb(app), viewer=owner)
    body = resp.body.decode()
    assert "Example v1.3 (3)" in body
    assert "https://api.store.example/api/v1/feed/apps/org.example.app" in body


# --------------------------------------------------------------------------
# Private mode: the whole router is gated (wiring check)
# --------------------------------------------------------------------------
class _ConfigSession:
    """Session stand-in that only knows the repo config row."""

    def __init__(self, public_mode: bool) -> None:
        self.public_mode = public_mode

    async def execute(self, stmt: Any) -> _Result:
        return _Result(SimpleNamespace(public_mode=self.public_mode))


def _client(public_mode: bool) -> TestClient:
    api = FastAPI()
    api.include_router(feeds.router, prefix="/api/v1/feed")

    async def fake_db():
        yield _ConfigSession(public_mode)

    api.dependency_overrides[get_db] = fake_db
    return TestClient(api)


@pytest.mark.parametrize("path", ["/new", "/updates", "/apps/org.example.app"])
def test_private_mode_feeds_require_credentials(path: str) -> None:
    resp = _client(public_mode=False).get(f"/api/v1/feed{path}")
    assert resp.status_code == 401
    assert resp.headers["www-authenticate"] == 'Basic realm="fdroid-store"'


async def test_feed_gate_lets_credentials_through_in_private_mode() -> None:
    db = FakeDb(SimpleNamespace(public_mode=False))
    with pytest.raises(HTTPException) as exc:
        await feeds.require_feed_access(db, None, None)
    assert exc.value.status_code == 401
    # A JWT or an API key passes without even reading the mode.
    await feeds.require_feed_access(FakeDb(), SimpleNamespace(id=uuid.uuid4()), None)
    await feeds.require_feed_access(FakeDb(), None, SimpleNamespace(id=uuid.uuid4()))
    # Public mode: anonymous is fine.
    await feeds.require_feed_access(FakeDb(SimpleNamespace(public_mode=True)), None, None)
