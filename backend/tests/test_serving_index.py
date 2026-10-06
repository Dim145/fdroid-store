"""Index generation: a dangling suggested-version pin, and how the repo
builder publishes / retires variants. Signing and storage are stubbed."""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.dialects import postgresql

from app.core.config import settings
from app.fdroid import repo_builder
from app.fdroid.index_v1 import build_index_v1, suggestion_fallback
from app.fdroid.index_v2 import build_index_v2
from app.models.apk import ApkStatus

T1 = datetime(2026, 9, 1, tzinfo=UTC)


def _apk(version_code: int, **kw: Any) -> SimpleNamespace:
    fields: dict[str, Any] = {
        "status": ApkStatus.PUBLISHED,
        "version_code": version_code,
        "version_name": f"1.{version_code}",
        "signer_sha256": "ab" * 32,
        "min_sdk": 24,
        "target_sdk": 35,
        "max_sdk": None,
        "permissions": [],
        "features": [],
        "native_code": [],
        "published_at": T1,
        "created_at": T1,
        "file_name": f"pkg_{version_code}.apk",
        "sha256": f"{version_code:064x}",
        "size_bytes": 1000,
        "whats_new": None,
        "anti_features": [],
        "anti_feature_reasons": None,
        "is_beta": False,
    }
    fields.update(kw)
    return SimpleNamespace(**fields)


def _app(apks: list[SimpleNamespace], **kw: Any) -> SimpleNamespace:
    fields: dict[str, Any] = {
        "package_name": "org.example.app",
        "name": "Example",
        "summary": "An example",
        "description": None,
        "license": "MIT",
        "categories": [],
        "localizations": [],
        "screenshots": [],
        "created_at": T1,
        "first_published_at": T1,
        "last_published_at": T1,
        "updated_at": T1,
        "author_name": None,
        "author_email": None,
        "website": None,
        "source_code": None,
        "issue_tracker": None,
        "translation": None,
        "donate": None,
        "liberapay": None,
        "bitcoin": None,
        "open_collective": None,
        "icon_path": None,
        "feature_graphic_path": None,
        "promo_graphic_path": None,
        "tv_banner_path": None,
        "suggested_version_code": max((a.version_code for a in apks), default=None),
        "suggested_version_name": None,
        "suggested_version_is_manual": False,
        "is_nsfw": False,
        "owner_id": None,
        "apks": apks,
    }
    fields.update(kw)
    return SimpleNamespace(**fields)


REPO = SimpleNamespace(
    name="Test repo",
    address="https://store.example/fdroid/repo",
    description="desc",
    icon_path=None,
    mirrors_json="[]",
)


# --------------------------------------------------------------------------
# Dangling suggested version
# --------------------------------------------------------------------------
def test_valid_pin_is_kept() -> None:
    app = _app([_apk(3), _apk(2)], suggested_version_code=2)
    assert suggestion_fallback(app, app.apks) is None


def test_dangling_pin_falls_back_to_newest_stable() -> None:
    apks = [_apk(4, is_beta=True), _apk(3), _apk(2)]
    app = _app(apks, suggested_version_code=1)  # 1 was deleted
    assert suggestion_fallback(app, apks).version_code == 3


def test_dangling_pin_with_only_betas_falls_back_to_newest() -> None:
    apks = [_apk(5, is_beta=True), _apk(4, is_beta=True)]
    assert suggestion_fallback(_app(apks, suggested_version_code=9), apks).version_code == 5


def test_no_suggested_version_stays_unset() -> None:
    apks = [_apk(5, is_beta=True)]
    assert suggestion_fallback(_app(apks, suggested_version_code=None), apks) is None


def test_v2_dangling_pin_does_not_turn_every_version_into_beta() -> None:
    app = _app([_apk(3), _apk(2)], suggested_version_code=1)
    index = json.loads(build_index_v2(repo_config=REPO, apps=[app], timestamp_ms=1))
    versions = index["packages"]["org.example.app"]["versions"].values()
    assert all("releaseChannels" not in v for v in versions)
    assert "releaseChannels" not in index["repo"]


def test_v2_beta_above_the_fallback_stays_beta() -> None:
    app = _app([_apk(4, is_beta=True), _apk(3)], suggested_version_code=1)
    index = json.loads(build_index_v2(repo_config=REPO, apps=[app], timestamp_ms=1))
    versions = index["packages"]["org.example.app"]["versions"].values()
    channels = {v["manifest"]["versionCode"]: v.get("releaseChannels") for v in versions}
    assert channels == {4: ["Beta"], 3: None}


def test_v1_dangling_pin_points_at_a_version_the_index_carries() -> None:
    app = _app([_apk(3), _apk(2)], suggested_version_code=1, suggested_version_name="1.1")
    (entry,) = json.loads(build_index_v1(repo_config=REPO, apps=[app], timestamp_ms=1))["apps"]
    assert (entry["suggestedVersionCode"], entry["suggestedVersionName"]) == ("3", "1.3")


# --------------------------------------------------------------------------
# Repo builder
# --------------------------------------------------------------------------
class FakeStorage:
    def __init__(self, files: dict[str, bytes] | None = None) -> None:
        self.files = dict(files or {})
        self.log: list[tuple[str, str]] = []
        self.fail_delete: set[str] = set()
        self.exists_error: Exception | None = None

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        self.log.append(("put", key))
        self.files[key] = data

    async def delete(self, key: str) -> None:
        self.log.append(("delete", key))
        if key in self.fail_delete:
            raise TimeoutError("S3 timeout")
        self.files.pop(key, None)

    async def exists(self, key: str) -> bool:
        self.log.append(("exists", key))
        if self.exists_error is not None:
            raise self.exists_error
        return key in self.files

    async def get_bytes(self, key: str) -> bytes:
        self.log.append(("get", key))
        try:
            return self.files[key]
        except KeyError:
            raise FileNotFoundError(key) from None


def _write_jar(path: Path, entries: dict[str, bytes]) -> None:
    path.write_bytes(json.dumps({k: v.decode() for k, v in entries.items()}).encode())


@pytest.fixture
def signer(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Fake jarsigner: the JAR is the JSON of its entries."""
    log: list[tuple[str, str]] = []

    async def fake_sign(path: Path, entries: dict[str, bytes], **kw: Any) -> None:
        log.append(("sign", path.name))
        _write_jar(path, entries)

    monkeypatch.setattr(repo_builder, "build_and_sign_jar", fake_sign)
    return log


async def test_variant_is_signed_before_upload_and_entry_jar_goes_last(signer) -> None:
    storage = FakeStorage()
    storage.log = signer  # one shared timeline
    await repo_builder._build_one(
        storage, repo_config=REPO, apps=[_app([_apk(1)])], prefix="repo/public",
        timestamp_ms=1, mirrors=[], file_meta={},
    )
    assert signer == [
        ("sign", "index-v1.jar"),
        ("sign", "entry.jar"),
        ("put", "repo/public/index-v1.jar"),
        ("put", "repo/public/index-v2.json"),
        ("put", "repo/public/entry.jar"),
    ]
    entry = json.loads(json.loads(storage.files["repo/public/entry.jar"])["entry.json"])
    v2 = storage.files["repo/public/index-v2.json"]
    assert entry["index"]["sha256"] == hashlib.sha256(v2).hexdigest()


async def test_stale_variant_loses_entry_jar_first_and_survives_failures() -> None:
    storage = FakeStorage()
    prefix = repo_builder.user_private_prefix("u1")
    storage.fail_delete = {f"{prefix}/index-v2.json"}
    await repo_builder._delete_user_private_index(storage, "u1")
    assert [k for op, k in storage.log if op == "delete"] == [
        f"{prefix}/entry.jar", f"{prefix}/index-v2.json", f"{prefix}/index-v1.jar",
    ]


async def test_file_meta_skips_missing_files_but_not_storage_errors() -> None:
    icon = "icons/org.example.app.png"
    apps = [_app([_apk(1)], icon_path=icon, feature_graphic_path="x/en-US/f.png")]
    storage = FakeStorage({icon: b"png"})
    meta = await repo_builder._collect_file_meta(storage, repo_config=REPO, apps=apps)
    assert meta == {icon: {"sha256": hashlib.sha256(b"png").hexdigest(), "size": 3}}
    storage.exists_error = TimeoutError("S3 timeout")
    with pytest.raises(TimeoutError):  # the worker retries the rebuild
        await repo_builder._collect_file_meta(storage, repo_config=REPO, apps=apps)


async def test_private_owners_query_skips_disabled_users() -> None:
    captured: list[Any] = []

    no_rows = SimpleNamespace(all=list)

    class Db:
        async def execute(self, stmt: Any) -> Any:
            captured.append(stmt)
            return SimpleNamespace(scalars=lambda: SimpleNamespace(unique=lambda: no_rows))

    assert await repo_builder._load_private_apps_by_owner(Db()) == {}
    sql = str(captured[0].compile(dialect=postgresql.dialect()))
    assert "JOIN users ON users.id = apps.owner_id" in sql
    assert "users.is_active IS true" in sql


async def test_rebuild_retires_dropped_users_even_when_cleanup_fails(
    monkeypatch, signer, tmp_path
) -> None:
    owner, fan, stale = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    public = _app([_apk(1)], package_name="org.pub", icon_path="icons/org.pub.png")
    racy = _app([_apk(1)], package_name="org.nsfw", is_nsfw=True)
    private = _app([_apk(1)], package_name="org.mine", owner_id=owner)
    config = SimpleNamespace(
        **vars(REPO), setup_complete=True, last_indexed_at=None, last_index_version=4,
        private_index_owner_ids=json.dumps([str(owner), str(stale)]),
    )
    storage = FakeStorage({"icons/org.pub.png": b"icon"})
    stale_prefix = repo_builder.user_private_prefix(stale)
    storage.fail_delete = {f"{stale_prefix}/entry.jar"}

    def returns(value: Any):
        async def load(db: Any) -> Any:
            return value
        return load

    monkeypatch.setattr(repo_builder, "_load_repo_config", returns(config))
    monkeypatch.setattr(repo_builder, "_load_public_apps", returns([public, racy]))
    monkeypatch.setattr(repo_builder, "_load_private_apps_by_owner", returns({owner: [private]}))
    monkeypatch.setattr(repo_builder, "_load_nsfw_users", returns([fan]))
    monkeypatch.setattr(repo_builder, "get_storage", lambda: storage)
    keystore = tmp_path / "repo.p12"
    keystore.write_bytes(b"k")
    monkeypatch.setattr(settings, "keystore_path", str(keystore))

    async def flush() -> None:
        return None

    await repo_builder.rebuild_repo_index(SimpleNamespace(flush=flush))

    def packages(prefix: str) -> set[str]:
        return set(json.loads(storage.files[f"{prefix}/index-v2.json"])["packages"])

    assert packages("repo/public") == {"org.pub"}
    assert packages(repo_builder.user_private_prefix(owner)) == {"org.pub", "org.mine"}
    # The NSFW fan owns no private app: the shared variant, no copy of their own.
    assert packages("repo/public-nsfw") == {"org.pub", "org.nsfw"}
    assert not any(str(fan) in key for _, key in storage.log)
    # The failed delete doesn't keep the stale user listed: being listed is
    # what the serving layer requires, so the frozen variant is retired.
    assert json.loads(config.private_index_owner_ids) == [str(owner)]
    assert ("delete", f"{stale_prefix}/entry.jar") in storage.log
    # Static files are hashed once per rebuild, not once per variant.
    assert storage.log.count(("get", "icons/org.pub.png")) == 1
    assert config.last_index_version == 5
