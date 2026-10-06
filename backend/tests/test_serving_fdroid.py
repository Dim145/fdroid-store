"""F-Droid serving layer (``app.api.fdroid``): media gates, the index
variant a caller gets, APK access + download accounting, and how storage
errors surface. Stubs only — no database, no S3."""
from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.responses import Response
from starlette.requests import Request

from app.api import fdroid
from app.core.client_ip import hash_ip
from app.core.config import settings
from app.core.download_token import sign_media_token
from app.models.apk import ApkStatus
from app.models.app import AppStatus, AppVisibility
from app.models.audit import DownloadEvent
from app.models.user import UserRole
from app.storage.local import LocalStorage


# --------------------------------------------------------------------------
# Fakes
# --------------------------------------------------------------------------
class _Result:
    def __init__(self, value: Any) -> None:
        self._value = value

    def scalar_one_or_none(self) -> Any:
        return self._value


class _Savepoint:
    def __init__(self, db: FakeDb) -> None:
        self.db = db

    async def __aenter__(self) -> _Savepoint:
        return self

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        if exc_type is None and self.db.fail_insert:
            raise RuntimeError("insert failed")
        return False


class FakeDb:
    """Answers each ``execute`` with the next canned value."""

    def __init__(self, *results: Any, fail_insert: bool = False) -> None:
        self.results = list(results)
        self.added: list[Any] = []
        self.fail_insert = fail_insert

    async def execute(self, stmt: Any) -> _Result:
        if not self.results:
            raise AssertionError(f"unexpected query: {stmt}")
        return _Result(self.results.pop(0))

    def add(self, obj: Any) -> None:
        self.added.append(obj)

    def begin_nested(self) -> _Savepoint:
        return _Savepoint(self)


class FakeStorage:
    def __init__(self, keys: set[str] | None = None, error: Exception | None = None) -> None:
        self.keys = keys or set()
        self.error = error
        self.checked: list[str] = []

    async def exists(self, key: str) -> bool:
        self.checked.append(key)
        if self.error is not None:
            raise self.error
        return key in self.keys


def _private_mode() -> SimpleNamespace:
    return SimpleNamespace(public_mode=False)


def _public_mode() -> SimpleNamespace:
    return SimpleNamespace(public_mode=True)


@pytest.fixture
def served(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Replace the byte-serving tail: record which key would be served."""
    keys: list[str] = []

    async def fake_serve(storage_key: str, *, content_type: str, allow_x_accel: bool = False):
        keys.append(storage_key)
        return Response(status_code=200)

    monkeypatch.setattr(fdroid, "_serve_storage_object", fake_serve)
    return keys


def _request(headers: dict[str, str] | None = None) -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/fdroid/repo/x.apk",
            "query_string": b"",
            "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
            "client": ("10.0.0.1", 40000),
        }
    )


def _key(user_id: uuid.UUID | None = None, *, private: bool = True) -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid.uuid4(),
        user_id=user_id or uuid.uuid4(),
        can_download_private=private,
        last_used_at=None,
    )


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("segments", "ok"),
    [
        (("org.example.app.png",), True),
        (("org.example", "en-US", "phoneScreenshots", "e81b7307-0dbc.png"), True),
        (("a b.png",), False),  # what used to reach LocalStorage and 500
        (("a%20b.png",), False),
        (("..",), False),
        ((".hidden.png",), False),
        (("a/b.png",), False),
        (("a\\b.png",), False),
        (("",), False),
        (("x" * 256,), False),
    ],
)
def test_safe_segments(segments: tuple[str, ...], ok: bool) -> None:
    assert fdroid._safe_segments(*segments) is ok


@pytest.mark.parametrize(
    ("header", "counted"),
    [
        (None, True),
        ("", True),
        ("bytes=0-", True),
        ("bytes=0-1048575", True),
        ("bytes= 0-99, 200-299", True),
        ("bytes=1048576-", False),  # resume
        ("bytes=-500", False),  # suffix: the tail of a file
        ("bytes=garbage", False),
        ("bytes=²-", False),  # a digit to str.isdigit, not to int()
        ("bytes=000-", True),
        ("items=5-", True),  # unknown unit: ignored, whole file sent
    ],
)
def test_only_the_start_of_a_download_counts(header: str | None, counted: bool) -> None:
    assert fdroid._starts_download(header) is counted


async def test_exists_maps_unresolvable_keys_to_missing() -> None:
    assert await fdroid._exists(FakeStorage(error=ValueError("bad key")), "a b") is False


async def test_exists_turns_storage_failures_into_503() -> None:
    with pytest.raises(HTTPException) as exc:
        await fdroid._exists(FakeStorage(error=TimeoutError()), "repo/public/entry.jar")
    assert exc.value.status_code == 503
    assert exc.value.headers == {"Retry-After": "5"}


async def test_local_storage_refusing_a_key_is_a_404(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(fdroid, "get_storage", lambda: LocalStorage(tmp_path))
    with pytest.raises(HTTPException) as exc:
        await fdroid._serve_storage_object("icons/a b.png", content_type="image/png")
    assert exc.value.status_code == 404


async def test_icon_with_an_impossible_name_is_a_404_not_a_500(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(fdroid, "get_storage", lambda: LocalStorage(tmp_path))
    with pytest.raises(HTTPException) as exc:
        await fdroid.serve_icon("a b.png", db=FakeDb(), api_key=None, bearer_user=None, t=None)
    assert exc.value.status_code == 404


async def test_media_with_an_impossible_locale_is_a_404(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(fdroid, "get_storage", lambda: LocalStorage(tmp_path))
    with pytest.raises(HTTPException) as exc:
        await fdroid.serve_media(
            "org.example", "e n", "phoneScreenshots", "x.png",
            db=FakeDb(), api_key=None, bearer_user=None, t=None,
        )
    assert exc.value.status_code == 404


# --------------------------------------------------------------------------
# Media gates
# --------------------------------------------------------------------------
async def test_media_of_a_package_without_app_row_is_refused() -> None:
    # e.g. the leftovers of a deleted app — no longer anonymously readable.
    visible = await fdroid._media_anonymously_visible(
        db=FakeDb(None), package_name="org.deleted", api_key=None
    )
    assert visible is False


async def test_public_published_app_media_is_visible() -> None:
    app = SimpleNamespace(
        visibility=AppVisibility.PUBLIC, status=AppStatus.PUBLISHED, owner_id=None, id=uuid.uuid4()
    )
    visible = await fdroid._media_anonymously_visible(
        db=FakeDb(app), package_name="org.example", api_key=None
    )
    assert visible is True


@pytest.fixture
def per_app_rule(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    calls: list[str] = []

    async def fake_rule(*, db, package_name, api_key, bearer_user=None) -> bool:
        calls.append(package_name)
        return True

    monkeypatch.setattr(fdroid, "_media_anonymously_visible", fake_rule)
    return calls


async def test_private_mode_refuses_anonymous_media(per_app_rule: list[str]) -> None:
    visible = await fdroid._media_visible(
        db=FakeDb(_private_mode()), package_name="org.example",
        api_key=None, bearer_user=None, token=None,
    )
    assert visible is False
    assert per_app_rule == []  # refused before the package is even looked up


async def test_public_mode_anonymous_media_follows_the_per_app_rule(per_app_rule) -> None:
    visible = await fdroid._media_visible(
        db=FakeDb(_public_mode()), package_name="org.example",
        api_key=None, bearer_user=None, token=None,
    )
    assert visible is True
    assert per_app_rule == ["org.example"]


@pytest.mark.parametrize("credential", ["api_key", "bearer_user"])
async def test_private_mode_media_with_credentials(per_app_rule, credential: str) -> None:
    kwargs: dict[str, Any] = {"api_key": None, "bearer_user": None}
    kwargs[credential] = SimpleNamespace(id=uuid.uuid4(), is_active=True)
    # No canned DB answer: credentials skip the public-mode lookup.
    visible = await fdroid._media_visible(
        db=FakeDb(), package_name="org.example", token=None, **kwargs
    )
    assert visible is True
    assert per_app_rule == ["org.example"]


async def test_media_token_unlocks_its_package_only(per_app_rule) -> None:
    token = sign_media_token("org.example", uuid.uuid4())
    assert await fdroid._media_visible(
        db=FakeDb(), package_name="org.example", api_key=None, bearer_user=None, token=token,
    )
    assert not await fdroid._media_visible(
        db=FakeDb(_private_mode()), package_name="org.other",
        api_key=None, bearer_user=None, token=token,
    )


async def test_repo_icon_stays_anonymous_in_private_mode(monkeypatch, served) -> None:
    storage = FakeStorage({"icons/fdroid-icon.png"})
    monkeypatch.setattr(fdroid, "get_storage", lambda: storage)
    resp = await fdroid.serve_icon(
        "fdroid-icon.png", db=FakeDb(), api_key=None, bearer_user=None, t=None
    )
    assert resp.status_code == 200
    assert served == ["icons/fdroid-icon.png"]


async def test_app_icon_is_refused_anonymously_in_private_mode(monkeypatch, served) -> None:
    storage = FakeStorage({"icons/org.example.png"})
    monkeypatch.setattr(fdroid, "get_storage", lambda: storage)
    with pytest.raises(HTTPException) as exc:
        await fdroid.serve_icon(
            "org.example.png", db=FakeDb(_private_mode()), api_key=None, bearer_user=None, t=None,
        )
    assert exc.value.status_code == 404
    assert served == [] and storage.checked == []


async def test_locale_fallback_never_masks_a_storage_error(monkeypatch, per_app_rule) -> None:
    monkeypatch.setattr(fdroid, "get_storage", lambda: FakeStorage(error=TimeoutError()))
    with pytest.raises(HTTPException) as exc:
        await fdroid.serve_singleton_media(
            "org.example", "fr", "featureGraphic.png",
            db=FakeDb(), api_key=_key(), bearer_user=None, t=None,
        )
    assert exc.value.status_code == 503


# --------------------------------------------------------------------------
# Path-token auth
# --------------------------------------------------------------------------
async def test_path_token_uses_the_basic_auth_resolver(monkeypatch) -> None:
    key = _key()
    seen: list[str] = []

    async def fake_resolver(raw: str, db) -> Any:
        seen.append(raw)
        return key if raw == "fdk_good" else None

    monkeypatch.setattr(fdroid, "_api_key_from_secret", fake_resolver)
    assert await fdroid._api_key_from_token_path("fdk_good", FakeDb()) is key
    # Bad, revoked, or owned by a disabled user: all the same uniform 404.
    with pytest.raises(HTTPException) as exc:
        await fdroid._api_key_from_token_path("fdk_disabled_owner", FakeDb())
    assert exc.value.status_code == 404
    assert seen == ["fdk_good", "fdk_disabled_owner"]


# --------------------------------------------------------------------------
# Index variant
# --------------------------------------------------------------------------
USER = uuid.uuid4()
PER_USER = f"repo/private/u_{USER}"
ALL_PER_USER_FILES = {f"{PER_USER}/{n}" for n in ("index-v1.jar", "index-v2.json", "entry.jar")}


def _owners(*ids: uuid.UUID) -> str:
    return json.dumps([str(i) for i in ids])


async def test_anonymous_and_unscoped_keys_get_the_public_index() -> None:
    storage = FakeStorage(ALL_PER_USER_FILES)
    assert await fdroid._index_prefix(FakeDb(), storage, None) == "repo/public"
    unscoped = _key(USER, private=False)
    assert await fdroid._index_prefix(FakeDb(), storage, unscoped) == "repo/public"


async def test_listed_user_with_a_complete_variant_gets_it() -> None:
    storage = FakeStorage(ALL_PER_USER_FILES)
    prefix = await fdroid._index_prefix(FakeDb(_owners(USER)), storage, _key(USER))
    assert prefix == PER_USER


async def test_a_dropped_user_never_gets_files_a_failed_delete_left() -> None:
    storage = FakeStorage(ALL_PER_USER_FILES)
    db = FakeDb(_owners(uuid.uuid4()), False)  # owner list, then show_nsfw
    assert await fdroid._index_prefix(db, storage, _key(USER)) == "repo/public"


async def test_variant_without_entry_jar_is_not_served_piecemeal() -> None:
    # Mid-publication or mid-delete: index-v2.json is there, entry.jar isn't.
    storage = FakeStorage({f"{PER_USER}/index-v1.jar", f"{PER_USER}/index-v2.json"})
    prefix = await fdroid._index_prefix(FakeDb(_owners(USER), False), storage, _key(USER))
    assert prefix == "repo/public"
    assert storage.checked == [f"{PER_USER}/entry.jar"]


async def test_garbled_owner_list_means_public() -> None:
    storage = FakeStorage(ALL_PER_USER_FILES)
    db = FakeDb("{oops", False)
    assert await fdroid._index_prefix(db, storage, _key(USER)) == "repo/public"


async def test_nsfw_opt_in_without_private_apps_gets_the_shared_variant() -> None:
    storage = FakeStorage({"repo/public-nsfw/entry.jar"})
    db = FakeDb(_owners(), True)
    assert await fdroid._index_prefix(db, storage, _key(USER)) == "repo/public-nsfw"
    # Not built yet (first rebuild after the upgrade): the public index.
    db = FakeDb(_owners(), True)
    assert await fdroid._index_prefix(db, FakeStorage(), _key(USER)) == "repo/public"
    # Without the private scope a key keeps the default view, as before.
    unscoped = _key(USER, private=False)
    assert await fdroid._index_prefix(FakeDb(), storage, unscoped) == "repo/public"


async def test_storage_error_is_a_503_not_the_public_index(monkeypatch, served) -> None:
    monkeypatch.setattr(fdroid, "get_storage", lambda: FakeStorage(error=TimeoutError()))
    with pytest.raises(HTTPException) as exc:
        await fdroid._serve_index("index-v2.json", FakeDb(_owners(USER)), _key(USER))
    assert exc.value.status_code == 503
    assert served == []


@pytest.mark.parametrize("filename", ["index-v1.jar", "index-v2.json", "entry.jar"])
async def test_every_index_file_comes_from_the_same_variant(monkeypatch, served, filename) -> None:
    storage = FakeStorage(ALL_PER_USER_FILES | {f"repo/public/{filename}"})
    monkeypatch.setattr(fdroid, "get_storage", lambda: storage)
    await fdroid._serve_index(filename, FakeDb(_owners(USER)), _key(USER))
    assert served == [f"{PER_USER}/{filename}"]


# --------------------------------------------------------------------------
# APK downloads
# --------------------------------------------------------------------------
def _app(**kw: Any) -> SimpleNamespace:
    fields: dict[str, Any] = {
        "id": uuid.uuid4(),
        "owner_id": uuid.uuid4(),
        "visibility": AppVisibility.PUBLIC,
        "status": AppStatus.PUBLISHED,
    }
    fields.update(kw)
    return SimpleNamespace(**fields)


def _apk(app: SimpleNamespace) -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid.uuid4(),
        app=app,
        status=ApkStatus.PUBLISHED,
        file_name="org.example_1.apk",
        storage_key="apks/org.example/org.example_1.apk",
        size_bytes=1234,
    )


@pytest.mark.parametrize("app_status", [AppStatus.ARCHIVED, AppStatus.REJECTED, AppStatus.DRAFT])
async def test_apk_of_an_unpublished_app_is_not_served(served, app_status) -> None:
    apk = _apk(_app(status=app_status))
    with pytest.raises(HTTPException) as exc:
        await fdroid._serve_apk(apk.file_name, request=_request(), db=FakeDb(apk), api_key=None)
    assert exc.value.status_code == 404
    # A key without ownership doesn't unlock it either.
    with pytest.raises(HTTPException):
        await fdroid._serve_apk(
            apk.file_name, request=_request(), db=FakeDb(apk), api_key=_key()
        )
    assert served == []


async def test_owner_key_still_downloads_a_taken_down_app(served) -> None:
    app = _app(status=AppStatus.ARCHIVED)
    resp = await fdroid._serve_apk(
        "org.example_1.apk", request=_request(), db=FakeDb(_apk(app)),
        api_key=_key(app.owner_id),
    )
    assert resp.status_code == 200
    assert served == ["apks/org.example/org.example_1.apk"]


async def test_admin_signed_url_still_downloads_a_taken_down_app(served) -> None:
    admin = SimpleNamespace(id=uuid.uuid4(), role=UserRole.ADMIN, is_active=True)
    resp = await fdroid._serve_apk(
        "org.example_1.apk", request=_request(),
        db=FakeDb(_apk(_app(status=AppStatus.REJECTED)), admin),
        api_key=None, signed_user_id=str(admin.id),
    )
    assert resp.status_code == 200


async def test_private_app_still_challenges_strangers(served) -> None:
    apk = _apk(_app(visibility=AppVisibility.PRIVATE))
    resp = await fdroid._serve_apk(apk.file_name, request=_request(), db=FakeDb(apk), api_key=None)
    assert resp.status_code == 401
    assert resp.headers["www-authenticate"].startswith("Basic")
    assert served == []


async def test_full_download_is_counted_once_with_the_client_fingerprint(
    monkeypatch, served
) -> None:
    monkeypatch.setattr(settings, "trust_forwarded_headers", True)
    app = _app()
    used = datetime(2026, 1, 1, tzinfo=UTC)
    key = _key(app.owner_id)
    key.last_used_at = used
    db = FakeDb(_apk(app))
    request = _request({"X-Forwarded-For": "203.0.113.9, 10.0.0.1", "User-Agent": "F-Droid"})
    await fdroid._serve_apk("org.example_1.apk", request=request, db=db, api_key=key)
    (event,) = db.added
    assert isinstance(event, DownloadEvent)
    assert event.ip_hash == hash_ip("203.0.113.9")  # the client, not nginx
    assert event.user_id == app.owner_id and event.api_key_id == key.id
    # ``last_used_at`` is the auth helper's (throttled) business, not the download's.
    assert key.last_used_at == used


@pytest.mark.parametrize("range_header", ["bytes=0-", "bytes=0-65535"])
async def test_first_range_counts(served, range_header) -> None:
    db = FakeDb(_apk(_app()))
    await fdroid._serve_apk(
        "org.example_1.apk", request=_request({"Range": range_header}), db=db, api_key=None
    )
    assert len(db.added) == 1


async def test_resumed_range_is_served_but_not_counted(served) -> None:
    db = FakeDb(_apk(_app()))
    resp = await fdroid._serve_apk(
        "org.example_1.apk", request=_request({"Range": "bytes=65536-"}), db=db, api_key=None
    )
    assert resp.status_code == 200
    assert db.added == []
    assert served == ["apks/org.example/org.example_1.apk"]


async def test_failed_download_accounting_never_fails_the_download(served) -> None:
    db = FakeDb(_apk(_app()), fail_insert=True)
    resp = await fdroid._serve_apk("org.example_1.apk", request=_request(), db=db, api_key=None)
    assert resp.status_code == 200
