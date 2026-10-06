"""APK route policies: reproducibility claims, pinned-version deletion,
download URLs for co-maintainers and APK-icon decoding."""
from __future__ import annotations

import io
import uuid
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from PIL import Image

from app.api.v1 import apks
from app.fdroid.apk_parser import ApkMetadata
from app.models.apk import ApkStatus, ReproducibilityStatus
from app.models.app import AppStatus, AppVisibility
from app.models.user import UserRole
from app.services import app_permissions

OWN = "ab" * 32
OTHER = "cd" * 32
UPLOADER = SimpleNamespace(id=uuid.uuid4(), role=UserRole.UPLOADER)
ADMIN = SimpleNamespace(id=uuid.uuid4(), role=UserRole.ADMIN)


@pytest.fixture(autouse=True)
def _no_audit(monkeypatch: pytest.MonkeyPatch) -> None:
    async def nothing(*args: Any, **kwargs: Any) -> None:
        return None

    monkeypatch.setattr(apks, "write_event", nothing)
    monkeypatch.setattr(apks, "enqueue_reindex", nothing)
    monkeypatch.setattr(apks, "enqueue_cve_scan", nothing)


def _apk(**kw: Any) -> SimpleNamespace:
    fields: dict[str, Any] = {
        "id": uuid.uuid4(),
        "sha256": OWN,
        "version_code": 3,
        "version_name": "1.3",
        "status": ApkStatus.PUBLISHED,
        "is_beta": False,
        "storage_key": "apks/pkg/pkg_3.apk",
        "file_name": "pkg_3.apk",
        "reproducibility_status": ReproducibilityStatus.UNKNOWN,
        "reproducibility_reference_sha256": None,
        "reproducibility_reference_url": None,
        "reproducibility_notes": None,
        "reproducibility_verified_at": None,
        "app": SimpleNamespace(package_name="org.example"),
        "app_id": uuid.uuid4(),
    }
    fields.update(kw)
    return SimpleNamespace(**fields)


async def _apply(apk: SimpleNamespace, actor: SimpleNamespace, **kw: Any) -> SimpleNamespace:
    kw.setdefault("status_override", None)
    kw.setdefault("reference_url", None)
    kw.setdefault("notes", None)
    return await apks._apply_reproducibility(None, apk, actor, **kw)


# --------------------------------------------------------------------------
# Reproducibility: no self-certification
# --------------------------------------------------------------------------
async def test_uploader_cannot_declare_verified() -> None:
    with pytest.raises(HTTPException) as excinfo:
        await _apply(_apk(), UPLOADER, status_override=ReproducibilityStatus.VERIFIED)
    assert excinfo.value.status_code == 403


async def test_uploader_cannot_verify_with_the_apks_own_hash() -> None:
    with pytest.raises(HTTPException) as excinfo:
        await _apply(_apk(), UPLOADER, reference_sha256=OWN)
    assert excinfo.value.status_code == 403


async def test_uploader_can_still_record_a_mismatch_and_other_statuses() -> None:
    apk = await _apply(_apk(), UPLOADER, reference_sha256=OTHER)
    assert apk.reproducibility_status == ReproducibilityStatus.FAILED
    apk = await _apply(_apk(), UPLOADER, status_override=ReproducibilityStatus.NOT_ATTEMPTED)
    assert apk.reproducibility_status == ReproducibilityStatus.NOT_ATTEMPTED


async def test_fetched_comparison_and_admins_may_verify() -> None:
    apk = await _apply(_apk(), UPLOADER, reference_candidates=[OTHER, OWN], compared=True,
                       reference_url="https://verification.f-droid.org/x.json")
    assert apk.reproducibility_status == ReproducibilityStatus.VERIFIED
    apk = await _apply(_apk(), ADMIN, status_override=ReproducibilityStatus.VERIFIED)
    assert apk.reproducibility_status == ReproducibilityStatus.VERIFIED


async def test_existing_verdict_survives_an_unchanged_resave_but_not_a_new_reference() -> None:
    def verified() -> SimpleNamespace:
        return _apk(
            reproducibility_status=ReproducibilityStatus.VERIFIED,
            reproducibility_reference_sha256=OWN,
            reproducibility_reference_url="https://ci.example/x.sha256",
        )

    # What the editor sends back when only the notes changed.
    apk = await _apply(verified(), UPLOADER, reference_sha256=OWN,
                       reference_url="https://ci.example/x.sha256", notes="rebuilt twice")
    assert apk.reproducibility_status == ReproducibilityStatus.VERIFIED
    assert apk.reproducibility_notes == "rebuilt twice"
    with pytest.raises(HTTPException):
        await _apply(verified(), UPLOADER, reference_sha256=OWN,
                     reference_url="https://attacker.example/x.sha256")


# --------------------------------------------------------------------------
# delete_apk: a manual pin on the deleted version is released
# --------------------------------------------------------------------------
class _FakeResult:
    def __init__(self, value: Any) -> None:
        self._value = value

    def scalar_one_or_none(self) -> Any:
        return self._value


class _FakeDb:
    def __init__(self, *results: Any) -> None:
        self._results = list(results)
        self.deleted: list[Any] = []
        self.added: list[Any] = []

    async def execute(self, _stmt: Any) -> _FakeResult:
        return _FakeResult(self._results.pop(0) if self._results else None)

    async def delete(self, obj: Any) -> None:
        self.deleted.append(obj)

    def add(self, obj: Any) -> None:
        self.added.append(obj)

    async def flush(self) -> None:
        return None


class _FakeStorage:
    def __init__(self) -> None:
        self.put_keys: list[str] = []

    async def delete(self, key: str) -> None:
        return None

    async def put(self, key: str, data: Any, content_type: str | None = None) -> None:
        self.put_keys.append(key)


async def _allow(*args: Any) -> bool:
    return True


async def _allow_none(*args: Any) -> None:
    return None


def _pinned_app(pinned: int) -> SimpleNamespace:
    old = _apk(version_code=2, version_name="1.2")
    new = _apk(version_code=3, version_name="1.3")
    app = SimpleNamespace(
        apks=[new, old], suggested_version_is_manual=True,
        suggested_version_code=pinned, suggested_version_name=f"1.{pinned}",
    )
    old.app = new.app = app
    return app


async def test_deleting_the_pinned_version_falls_back_to_auto(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(apks, "get_storage", _FakeStorage)
    monkeypatch.setattr(app_permissions, "assert_can_manage_app", _allow_none)
    app = _pinned_app(pinned=2)
    pinned = app.apks[1]
    await apks.delete_apk(apk_id=pinned.id, db=_FakeDb(pinned), user=UPLOADER)
    assert app.suggested_version_is_manual is False
    assert app.suggested_version_code == 3


async def test_deleting_another_version_keeps_the_pin(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(apks, "get_storage", _FakeStorage)
    monkeypatch.setattr(app_permissions, "assert_can_manage_app", _allow_none)
    app = _pinned_app(pinned=2)
    await apks.delete_apk(apk_id=app.apks[0].id, db=_FakeDb(app.apks[0]), user=UPLOADER)
    assert app.suggested_version_is_manual is True
    assert app.suggested_version_code == 2


# --------------------------------------------------------------------------
# issue_download_url: co-maintainers of a private app get a URL
# --------------------------------------------------------------------------
async def test_co_maintainer_gets_a_download_url_for_a_private_app(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    apk = _apk(app=SimpleNamespace(
        visibility=AppVisibility.PRIVATE, status=AppStatus.DRAFT, owner_id=uuid.uuid4(),
    ))
    monkeypatch.setattr(app_permissions, "can_manage_app", _allow)
    out = await apks.issue_download_url(apk_id=apk.id, db=_FakeDb(apk, None), user=UPLOADER)
    assert out["url"].startswith("/fdroid/repo/pkg_3.apk?t=")


@pytest.mark.parametrize(
    ("visibility", "app_status", "allowed"),
    [
        (AppVisibility.PRIVATE, AppStatus.PUBLISHED, False),
        (AppVisibility.PUBLIC, AppStatus.ARCHIVED, False),
        (AppVisibility.PUBLIC, AppStatus.PUBLISHED, True),
    ],
)
async def test_strangers_need_a_public_published_app(
    monkeypatch: pytest.MonkeyPatch, visibility: AppVisibility, app_status: AppStatus, allowed: bool
) -> None:
    apk = _apk(app=SimpleNamespace(visibility=visibility, status=app_status, owner_id=uuid.uuid4()))

    async def deny(*args: Any) -> bool:
        return False

    monkeypatch.setattr(app_permissions, "can_manage_app", deny)
    if allowed:
        out = await apks.issue_download_url(apk_id=apk.id, db=_FakeDb(apk, None), user=UPLOADER)
        assert "?t=" in out["url"]
        return
    with pytest.raises(HTTPException) as excinfo:
        await apks.issue_download_url(apk_id=apk.id, db=_FakeDb(apk, None), user=UPLOADER)
    assert excinfo.value.status_code == 404


# --------------------------------------------------------------------------
# APK-extracted icons go through the upload format allowlist
# --------------------------------------------------------------------------
def _image(fmt: str) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), "red").save(buf, format=fmt)
    return buf.getvalue()


@pytest.mark.parametrize(("fmt", "stored"), [("PNG", True), ("GIF", False), ("TIFF", False)])
async def test_extracted_icon_uses_the_allowlist(
    monkeypatch: pytest.MonkeyPatch, fmt: str, stored: bool
) -> None:
    storage = _FakeStorage()
    monkeypatch.setattr(apks, "get_storage", lambda: storage)
    app = SimpleNamespace(
        id=uuid.uuid4(), package_name="org.example", locked_signer_sha256=None, apks=[],
        icon_is_custom=False, icon_path=None,
    )
    meta = ApkMetadata(
        package_name="org.example", version_code=1, version_name="1", min_sdk=21,
        target_sdk=35, max_sdk=None, signer_sha256=OWN, sha256=OTHER, size_bytes=3,
        icon_data=_image(fmt), icon_extension="png",
    )
    tmp = io.BytesIO(b"apk")
    path = SimpleNamespace(open=lambda mode: tmp)
    await apks.attach_apk_to_app(_FakeDb(), app=app, tmp_path=path, meta=meta, uploader=UPLOADER)
    assert (app.icon_path == "icons/org.example.png") is stored
    assert ("icons/org.example.png" in storage.put_keys) is stored
