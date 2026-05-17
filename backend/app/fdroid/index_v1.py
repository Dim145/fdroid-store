"""Generate F-Droid index-v1 (legacy, but widely supported by F-Droid clients).

Spec reference:
https://gitlab.com/fdroid/fdroidserver/-/blob/master/fdroidserver/index.py

The result is a JSON object that gets packed into ``index-v1.jar``, then
JAR-signed using the repo keystore.
"""
from __future__ import annotations

import json
from collections.abc import Iterable
from datetime import datetime
from typing import Any

from app.models.apk import Apk
from app.models.app import App
from app.models.repo_config import RepoConfig


F_DROID_INDEX_VERSION = 20002  # matches what fdroidserver writes


def _ts_ms(value: datetime | None) -> int:
    if value is None:
        return int(datetime.now().timestamp() * 1000)
    return int(value.timestamp() * 1000)


def _serialize_app(app: App) -> dict[str, Any]:
    suggested = app.suggested_version_code or 0
    suggested_name = app.suggested_version_name or ""
    obj: dict[str, Any] = {
        "added": _ts_ms(app.created_at),
        "name": app.name,
        "packageName": app.package_name,
        "lastUpdated": _ts_ms(app.last_published_at or app.updated_at),
        "summary": app.summary or "",
        "description": app.description or "",
        "license": app.license or "Unknown",
        "categories": [c.name for c in app.categories] or ["Misc"],
        "suggestedVersionCode": str(suggested) if suggested else "",
        "suggestedVersionName": suggested_name,
    }
    if app.author_name:
        obj["authorName"] = app.author_name
    if app.website:
        obj["webSite"] = app.website
    if app.source_code:
        obj["sourceCode"] = app.source_code
    if app.issue_tracker:
        obj["issueTracker"] = app.issue_tracker
    if app.icon_path:
        # F-Droid clients expect just the basename when the icon lives under
        # /icons/. We store the full storage key (e.g. ``icons/<file>``) and
        # publish each icon under ``/<repo>/icons/<file>``.
        obj["icon"] = app.icon_path.split("/")[-1]
    return obj


def _serialize_apk(apk: Apk, app: App) -> dict[str, Any]:
    obj: dict[str, Any] = {
        "added": _ts_ms(apk.published_at or apk.created_at),
        "apkName": apk.file_name,
        "hash": apk.sha256,
        "hashType": "sha256",
        "minSdkVersion": apk.min_sdk or 0,
        "packageName": app.package_name,
        "sig": apk.signer_sha256,    # F-Droid client uses this to pin the cert
        "signer": apk.signer_sha256,
        "size": apk.size_bytes,
        "versionCode": apk.version_code,
        "versionName": apk.version_name,
    }
    if apk.target_sdk:
        obj["targetSdkVersion"] = apk.target_sdk
    if apk.max_sdk:
        obj["maxSdkVersion"] = apk.max_sdk
    if apk.native_code:
        obj["nativecode"] = list(apk.native_code)
    if apk.permissions:
        # F-Droid v1 expects ``[[<permission>, <max_sdk_or_null>], ...]``.
        obj["uses-permission"] = [[p, None] for p in apk.permissions]
    return obj


def build_index_v1(
    *,
    repo_config: RepoConfig,
    apps: Iterable[App],
    mirrors: list[str] | None = None,
) -> bytes:
    """Return the index-v1.json content as UTF-8 bytes.

    Only apps with at least one PUBLISHED apk are emitted. Apps with no APK
    are silently skipped (the index would not be useful without binaries).
    """
    now_ms = int(datetime.now().timestamp() * 1000)
    apps_list: list[dict[str, Any]] = []
    packages: dict[str, list[dict[str, Any]]] = {}

    for app in apps:
        published = [a for a in app.apks if a.status.value == "published"]
        if not published:
            continue
        apps_list.append(_serialize_app(app))
        packages[app.package_name] = [_serialize_apk(a, app) for a in published]

    payload: dict[str, Any] = {
        "repo": {
            "timestamp": now_ms,
            "version": F_DROID_INDEX_VERSION,
            "name": repo_config.name,
            "icon": (repo_config.icon_path or "").split("/")[-1] or "fdroid-icon.png",
            "address": repo_config.address,
            "description": repo_config.description or "",
            "mirrors": mirrors or [],
        },
        "requests": {"install": [], "uninstall": []},
        "apps": apps_list,
        "packages": packages,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
