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
    obj: dict[str, Any] = {
        "added": _ts_ms(app.created_at),
        "name": app.name,
        "packageName": app.package_name,
        "lastUpdated": _ts_ms(app.last_published_at or app.updated_at),
    }
    if app.summary:
        obj["summary"] = app.summary
    if app.description:
        obj["description"] = app.description
    # fdroidserver omits "Unknown" license rather than emitting it
    if app.license and app.license != "Unknown":
        obj["license"] = app.license
    cats = [c.name for c in app.categories]
    if cats:
        obj["categories"] = cats
    if app.suggested_version_code:
        obj["suggestedVersionCode"] = str(app.suggested_version_code)
    if app.suggested_version_name:
        obj["suggestedVersionName"] = app.suggested_version_name
    if app.author_name:
        obj["authorName"] = app.author_name
    if app.website:
        obj["webSite"] = app.website
    if app.source_code:
        obj["sourceCode"] = app.source_code
    if app.issue_tracker:
        obj["issueTracker"] = app.issue_tracker
    if app.icon_path:
        # F-Droid v1 clients expect just the basename of an icon stored under
        # ``<repo-url>/icons/<filename>``.
        obj["icon"] = app.icon_path.split("/")[-1]

    # Screenshots are advertised under "localized.<locale>.phoneScreenshots"
    # as a list of basenames; the F-Droid client constructs the full URL
    # ``<repo-url>/<package>/<locale>/phoneScreenshots/<basename>`` from those.
    shots_by_locale: dict[str, list[str]] = {}
    for s in app.screenshots:
        shots_by_locale.setdefault(s.locale, []).append(s.storage_key.rsplit("/", 1)[-1])
    if shots_by_locale:
        localized: dict[str, dict[str, list[str]]] = {}
        for locale, files in shots_by_locale.items():
            localized[locale] = {"phoneScreenshots": files}
        obj["localized"] = localized
    return obj


def _serialize_apk(apk: Apk, app: App) -> dict[str, Any]:
    """Serialize an APK row to the v1 ``packages[<pkg>]`` entry format.

    Notes:
      * ``hash`` / ``hashType`` are the APK file content hash.
      * ``signer`` is the SHA-256 of the signing certificate (lowercase hex).
      * fdroidserver no longer emits ``sig`` (the legacy MD5 cert hash), so
        we don't either — modern F-Droid clients use ``signer``.
    """
    obj: dict[str, Any] = {
        "added": _ts_ms(apk.published_at or apk.created_at),
        "apkName": apk.file_name,
        "hash": apk.sha256,
        "hashType": "sha256",
        "minSdkVersion": apk.min_sdk or 0,
        "packageName": app.package_name,
        "signer": apk.signer_sha256,
        "size": apk.size_bytes,
        # targetSdkVersion defaults to minSdkVersion when not declared
        "targetSdkVersion": apk.target_sdk or apk.min_sdk or 0,
        "versionCode": apk.version_code,
        "versionName": apk.version_name,
    }
    if apk.max_sdk:
        obj["maxSdkVersion"] = apk.max_sdk
    if apk.native_code:
        obj["nativecode"] = list(apk.native_code)
    if apk.permissions:
        # F-Droid v1 expects ``[[<permission>, <max_sdk_or_null>], ...]``.
        obj["uses-permission"] = [[p, None] for p in apk.permissions]
    if apk.features:
        obj["features"] = list(apk.features)
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

    repo_block: dict[str, Any] = {
        "timestamp": now_ms,
        "version": F_DROID_INDEX_VERSION,
        "name": repo_config.name,
        "icon": (repo_config.icon_path or "").split("/")[-1] or "fdroid-icon.png",
        "address": repo_config.address,
        "description": repo_config.description or "",
    }
    # v1 mirrors are a list of URL strings (not dicts like v2); omit if empty
    if mirrors:
        repo_block["mirrors"] = list(mirrors)

    payload: dict[str, Any] = {
        "repo": repo_block,
        "requests": {"install": [], "uninstall": []},
        "apps": apps_list,
        "packages": packages,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
