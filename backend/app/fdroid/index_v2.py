"""Generate F-Droid index-v2 (new format used by recent F-Droid clients).

The v2 layout is:
  * ``index-v2.json``  — the full repo index (plaintext)
  * ``entry.jar``      — signed JAR containing ``entry.json``, which holds the
    SHA-256 + size of ``index-v2.json`` so clients can verify the larger file
    without re-signing the whole thing.
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from datetime import datetime
from typing import Any

from app.fdroid.index_v1 import F_DROID_INDEX_VERSION
from app.models.apk import Apk
from app.models.app import App
from app.models.repo_config import RepoConfig

DEFAULT_LOCALE = "en-US"


def _ts_ms(value: datetime | None) -> int:
    if value is None:
        return int(datetime.now().timestamp() * 1000)
    return int(value.timestamp() * 1000)


def _localized(value: str | None) -> dict[str, str]:
    return {DEFAULT_LOCALE: value or ""}


def _build_package(app: App, apks: list[Apk]) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "added": _ts_ms(app.created_at),
        "lastUpdated": _ts_ms(app.last_published_at or app.updated_at),
        "license": app.license or "Unknown",
        "categories": [c.name for c in app.categories] or ["Misc"],
        "name": _localized(app.name),
        "summary": _localized(app.summary),
        "description": _localized(app.description),
    }
    if app.author_name:
        metadata["authorName"] = app.author_name
    if app.website:
        metadata["webSite"] = app.website
    if app.source_code:
        metadata["sourceCode"] = app.source_code
    if app.issue_tracker:
        metadata["issueTracker"] = app.issue_tracker
    if app.icon_path:
        # In v2, icons live under each app's localized block
        metadata["icon"] = {
            DEFAULT_LOCALE: {
                "name": f"/icons/{app.icon_path.split('/')[-1]}",
            }
        }

    versions: dict[str, Any] = {}
    for apk in apks:
        manifest: dict[str, Any] = {
            "versionCode": apk.version_code,
            "versionName": apk.version_name,
            "signer": {"sha256": [apk.signer_sha256]},
        }
        if apk.min_sdk:
            manifest["usesSdk"] = {"minSdkVersion": apk.min_sdk}
            if apk.target_sdk:
                manifest["usesSdk"]["targetSdkVersion"] = apk.target_sdk
        if apk.permissions:
            manifest["usesPermission"] = [{"name": p} for p in apk.permissions]
        if apk.features:
            manifest["features"] = [{"name": f} for f in apk.features]
        if apk.native_code:
            manifest["nativecode"] = list(apk.native_code)

        versions[apk.sha256] = {
            "added": _ts_ms(apk.published_at or apk.created_at),
            "file": {
                "name": f"/{apk.file_name}",
                "sha256": apk.sha256,
                "size": apk.size_bytes,
            },
            "manifest": manifest,
        }

    return {"metadata": metadata, "versions": versions}


def build_index_v2(
    *,
    repo_config: RepoConfig,
    apps: Iterable[App],
    mirrors: list[str] | None = None,
) -> bytes:
    now_ms = int(datetime.now().timestamp() * 1000)
    packages: dict[str, Any] = {}
    categories_seen: set[str] = set()
    for app in apps:
        published = [a for a in app.apks if a.status.value == "published"]
        if not published:
            continue
        packages[app.package_name] = _build_package(app, published)
        for c in app.categories:
            categories_seen.add(c.name)

    payload: dict[str, Any] = {
        "repo": {
            "name": _localized(repo_config.name),
            "description": _localized(repo_config.description or ""),
            "address": repo_config.address,
            "mirrors": [{"url": m} for m in (mirrors or [])],
            "timestamp": now_ms,
            "categories": {c: {"name": _localized(c)} for c in sorted(categories_seen)},
            "antiFeatures": {},
            "releaseChannels": {},
        },
        "packages": packages,
    }
    if repo_config.icon_path:
        payload["repo"]["icon"] = {
            DEFAULT_LOCALE: {"name": f"/icons/{repo_config.icon_path.split('/')[-1]}"}
        }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def build_entry_json(index_v2_bytes: bytes, timestamp_ms: int | None = None) -> bytes:
    """Build the ``entry.json`` companion to index-v2.json.

    It contains a checksum of ``index-v2.json`` so the F-Droid client can
    verify the (large, unsigned) index against this (small, signed) entry.
    """
    ts = timestamp_ms or int(datetime.now().timestamp() * 1000)
    sha = hashlib.sha256(index_v2_bytes).hexdigest()
    payload = {
        "timestamp": ts,
        "version": F_DROID_INDEX_VERSION,
        "index": {
            "name": "/index-v2.json",
            "sha256": sha,
            "size": len(index_v2_bytes),
            "numPackages": 0,  # filled in by caller after parsing
        },
        "diffs": {},
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
