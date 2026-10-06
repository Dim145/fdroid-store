"""index-v2 output vs. what the F-Droid 2.0 client actually parses/renders.

The client decodes index-v2 with kotlinx.serialization (``ignoreUnknownKeys``
only — no type coercion), so a wrong JSON type for a known field rejects the
whole index. And 2.0 only displays anti-features the repo defines, keys its
category icons/groups on official IDs, uses ``webBaseUrl`` for "Share" and
``releaseChannels`` for beta opt-in. These tests pin that contract.
"""
from __future__ import annotations

import json
from datetime import UTC, datetime
from enum import Enum
from types import SimpleNamespace
from typing import Any

from app.api.v1.apks import known_vuln_reason
from app.fdroid.donations import funding_for
from app.fdroid.index_v2 import build_index_v2
from app.models.apk import ApkStatus
from app.schemas.app import CveFinding
from app.services.suggested_version import recompute_auto

T0 = datetime(2026, 1, 1, tzinfo=UTC)
T1 = datetime(2026, 9, 1, tzinfo=UTC)


class _Status(Enum):
    PUBLISHED = "published"
    PENDING = "pending_review"


def _apk(version_code: int, **kw: Any) -> SimpleNamespace:
    fields: dict[str, Any] = {
        "status": _Status.PUBLISHED,
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
        "description": "Longer text",
        "license": "MIT",
        "categories": [],
        "localizations": [],
        "screenshots": [],
        "created_at": T0,
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
        "suggested_version_is_manual": False,
        "apks": apks,
    }
    fields.update(kw)
    return SimpleNamespace(**fields)


REPO = SimpleNamespace(
    name="Test repo",
    address="https://store.example/fdroid/repo",
    description="desc",
    icon_path=None,
)


def _index(*apps: SimpleNamespace, **kw: Any) -> dict[str, Any]:
    raw = build_index_v2(repo_config=REPO, apps=list(apps), timestamp_ms=1, **kw)
    return json.loads(raw)


def _check_client_types(index: dict[str, Any]) -> None:
    """Mirror of the client's ``MetadataV2`` / ``PackageVersionV2`` /
    ``RepoV2`` field types for everything we emit."""
    repo = index["repo"]
    assert isinstance(repo["address"], str)
    assert isinstance(repo.get("webBaseUrl", ""), str)
    for block in ("antiFeatures", "categories", "releaseChannels"):
        for entry in repo.get(block, {}).values():
            assert all(isinstance(v, str) for v in entry["name"].values())
            assert all(isinstance(v, str) for v in entry.get("description", {}).values())
    for pkg in index["packages"].values():
        meta = pkg["metadata"]
        assert isinstance(meta.get("donate", []), list)
        assert all(isinstance(u, str) for u in meta.get("donate", []))
        for key in ("liberapay", "openCollective", "bitcoin", "litecoin"):
            assert isinstance(meta.get(key, ""), str)
        assert isinstance(meta.get("categories", []), list)
        for version in pkg["versions"].values():
            assert isinstance(version.get("releaseChannels", []), list)
            for reason in version.get("antiFeatures", {}).values():
                assert isinstance(reason, dict)
                assert all(isinstance(v, str) for v in reason.values())


# ---------------------------------------------------------------------------
# Funding
# ---------------------------------------------------------------------------
def test_donate_is_a_list_and_platform_fields_are_ids() -> None:
    app = _app(
        [_apk(1)],
        donate="https://example.org/donate",
        liberapay="https://liberapay.com/alice/donate",
        open_collective="https://opencollective.com/my-project",
        bitcoin="bitcoin:bc1qexample?amount=0.1",
    )
    meta = _index(app)["packages"]["org.example.app"]["metadata"]
    assert meta["donate"] == ["https://example.org/donate"]
    assert meta["liberapay"] == "alice"
    assert meta["openCollective"] == "my-project"
    assert meta["bitcoin"] == "bc1qexample"
    _check_client_types(_index(app))


def test_bare_ids_pass_through_and_foreign_urls_become_donate_links() -> None:
    funding = funding_for(
        SimpleNamespace(
            donate=None,
            liberapay="bob",
            open_collective="https://example.org/support",
            bitcoin="bc1qplain",
        )
    )
    assert funding.liberapay == "bob"
    assert funding.open_collective is None
    assert funding.donate == ["https://example.org/support"]
    assert funding.bitcoin == "bc1qplain"


# ---------------------------------------------------------------------------
# Release channels
# ---------------------------------------------------------------------------
def test_versions_above_the_suggested_one_are_beta() -> None:
    app = _app([_apk(102, is_beta=True), _apk(101)], suggested_version_code=101)
    index = _index(app)
    versions = index["packages"]["org.example.app"]["versions"]
    by_code = {v["manifest"]["versionCode"]: v for v in versions.values()}
    assert by_code[102]["releaseChannels"] == ["Beta"]
    assert "releaseChannels" not in by_code[101]
    assert "Beta" in index["repo"]["releaseChannels"]
    _check_client_types(index)


def test_no_release_channel_without_a_stable_baseline() -> None:
    app = _app([_apk(5, is_beta=True)], suggested_version_code=None)
    index = _index(app)
    (version,) = index["packages"]["org.example.app"]["versions"].values()
    assert "releaseChannels" not in version
    assert "releaseChannels" not in index["repo"]


def test_pinned_suggested_version_holds_newer_ones_back() -> None:
    app = _app([_apk(3), _apk(2), _apk(1)], suggested_version_code=1)
    versions = _index(app)["packages"]["org.example.app"]["versions"].values()
    channels = {v["manifest"]["versionCode"]: v.get("releaseChannels") for v in versions}
    assert channels == {3: ["Beta"], 2: ["Beta"], 1: None}


# ---------------------------------------------------------------------------
# Anti-features
# ---------------------------------------------------------------------------
def test_every_used_anti_feature_is_defined_with_reasons() -> None:
    app = _app(
        [
            _apk(
                1,
                anti_features=["Tracking", "MyCustomFlag"],
                anti_feature_reasons={"Tracking": "Firebase Analytics"},
            )
        ]
    )
    index = _index(app)
    defs = index["repo"]["antiFeatures"]
    assert set(defs) == {"Tracking", "MyCustomFlag"}
    assert defs["Tracking"]["name"]["fr"] == "Pistage"
    assert defs["MyCustomFlag"]["name"] == {"en-US": "MyCustomFlag"}
    (version,) = index["packages"]["org.example.app"]["versions"].values()
    assert version["antiFeatures"] == {
        "Tracking": {"en-US": "Firebase Analytics"},
        "MyCustomFlag": {},
    }
    _check_client_types(index)


def test_no_anti_feature_block_when_unused() -> None:
    assert "antiFeatures" not in _index(_app([_apk(1)]))["repo"]


# ---------------------------------------------------------------------------
# Categories, webBaseUrl, added
# ---------------------------------------------------------------------------
def test_categories_are_localized_and_keep_their_ids() -> None:
    app = _app(
        [_apk(1)],
        categories=[
            SimpleNamespace(name="VPN & Proxy", description=None),
            SimpleNamespace(name="Games", description="Legacy bucket"),
        ],
    )
    index = _index(app)
    cats = index["repo"]["categories"]
    assert cats["VPN & Proxy"]["name"] == {"en-US": "VPN & Proxy", "fr": "VPN et proxy"}
    assert "fr" in cats["VPN & Proxy"]["description"]
    assert cats["Games"] == {
        "name": {"en-US": "Games"},
        "description": {"en-US": "Legacy bucket"},
    }
    meta = index["packages"]["org.example.app"]["metadata"]
    assert sorted(meta["categories"]) == ["Games", "VPN & Proxy"]
    _check_client_types(index)


def test_web_base_url_is_emitted() -> None:
    index = _index(_app([_apk(1)]), web_base_url="https://store.example/apps")
    assert index["repo"]["webBaseUrl"] == "https://store.example/apps"


def test_added_is_the_first_publication_not_the_draft_creation() -> None:
    meta = _index(_app([_apk(1)]))["packages"]["org.example.app"]["metadata"]
    assert meta["added"] == int(T1.timestamp() * 1000)
    legacy = _index(_app([_apk(1)], first_published_at=None))
    assert legacy["packages"]["org.example.app"]["metadata"]["added"] == int(
        T0.timestamp() * 1000
    )


# ---------------------------------------------------------------------------
# Suggested version bookkeeping
# ---------------------------------------------------------------------------
def _published(code: int, beta: bool = False) -> SimpleNamespace:
    return SimpleNamespace(
        status=ApkStatus.PUBLISHED,
        version_code=code,
        version_name=f"v{code}",
        is_beta=beta,
    )


def _owner_app(apks: list[SimpleNamespace], **kw: Any) -> SimpleNamespace:
    fields = {
        "apks": apks,
        "suggested_version_is_manual": False,
        "suggested_version_code": None,
        "suggested_version_name": None,
    }
    fields.update(kw)
    return SimpleNamespace(**fields)


def test_recompute_skips_betas() -> None:
    app = _owner_app([_published(1), _published(2, beta=True)])
    recompute_auto(app)
    assert (app.suggested_version_code, app.suggested_version_name) == (1, "v1")


def test_recompute_falls_back_to_betas_without_a_stable_version() -> None:
    app = _owner_app([_published(4, beta=True), _published(3, beta=True)])
    recompute_auto(app)
    assert app.suggested_version_code == 4


def test_recompute_ignores_unpublished_and_respects_a_manual_pin() -> None:
    pending = SimpleNamespace(
        status=ApkStatus.PENDING_REVIEW, version_code=9, version_name="v9", is_beta=False
    )
    app = _owner_app([_published(1), pending])
    recompute_auto(app)
    assert app.suggested_version_code == 1

    pinned = _owner_app(
        [_published(1), _published(2)],
        suggested_version_is_manual=True,
        suggested_version_code=1,
    )
    recompute_auto(pinned)
    assert pinned.suggested_version_code == 1


def test_recompute_accepts_an_explicit_apk_list() -> None:
    app = _owner_app([_published(1)])
    recompute_auto(app, [*app.apks, _published(2)])
    assert app.suggested_version_code == 2
    recompute_auto(app, [])
    assert app.suggested_version_code is None


# ---------------------------------------------------------------------------
# KnownVuln reason suggestion
# ---------------------------------------------------------------------------
def test_known_vuln_reason_lists_serious_findings_only() -> None:
    cves = [
        CveFinding(cve_id="CVE-1", severity="CRITICAL", package_name="libfoo",
                   fixed_version="1.2"),
        CveFinding(cve_id="CVE-2", severity="HIGH"),
        CveFinding(cve_id="CVE-3", severity="LOW"),
    ]
    reason = known_vuln_reason(cves)
    assert reason == "CVE-1 (critical) in libfoo, fixed in 1.2; CVE-2 (high)"
    assert known_vuln_reason([CveFinding(cve_id="CVE-9", severity="MEDIUM")]) is None
