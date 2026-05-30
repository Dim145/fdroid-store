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
from datetime import UTC, datetime
from typing import Any

from app.fdroid.index_v1 import F_DROID_INDEX_VERSION
from app.models.apk import Apk
from app.models.app import App
from app.models.repo_config import RepoConfig

DEFAULT_LOCALE = "en-US"


def _ts_ms(value: datetime | None) -> int:
    if value is None:
        return int(datetime.now(UTC).timestamp() * 1000)
    return int(value.timestamp() * 1000)


def _localized(value: str | None) -> dict[str, str] | None:
    """Wrap a string into the default locale, or return None when empty.

    fdroidserver omits localizable fields when the source value is empty
    rather than emitting ``{"en-US": ""}``; some clients then refuse
    zero-length localized entries.
    """
    if value is None or value == "":
        return None
    return {DEFAULT_LOCALE: value}


def _file_entry(
    storage_key: str | None,
    file_meta: dict[str, dict[str, Any]] | None,
) -> dict[str, Any] | None:
    """Build a v2 File object ``{name, sha256, size}`` from a storage key.

    The storage key is reused verbatim as the URL path (prefixed with ``/``),
    so callers MUST store assets at the path the F-Droid client expects:
      * icons:       ``icons/<file>``
      * screenshots: ``<package>/<locale>/phoneScreenshots/<file>``
    ``file_meta`` maps each referenced storage key to its precomputed
    ``{sha256, size}``; the caller hashes files once before generating the
    index. Returns ``None`` if the metadata is missing, so the index omits
    the field rather than emit a malformed entry.
    """
    if not storage_key or not file_meta:
        return None
    info = file_meta.get(storage_key)
    if info is None:
        return None
    return {
        "name": f"/{storage_key}",
        "sha256": info["sha256"],
        "size": info["size"],
    }


def _build_package(
    app: App,
    apks: list[Apk],
    file_meta: dict[str, dict[str, Any]] | None,
) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "added": _ts_ms(app.created_at),
        "lastUpdated": _ts_ms(app.last_published_at or app.updated_at),
    }
    # fdroidserver omits "Unknown" license rather than emitting it
    if app.license and app.license != "Unknown":
        metadata["license"] = app.license
    cats = [c.name for c in app.categories]
    if cats:
        metadata["categories"] = cats
    # App-level fields seed the en-US entry; any Localization row layers its
    # overrides on top so F-Droid clients can pick the closest match per
    # user-locale. We only include keys that have at least one non-empty
    # value, mirroring fdroidserver's behaviour (empty strings make clients
    # render a blank field instead of falling back).
    field_to_attr: dict[str, str] = {
        "name": "name",
        "summary": "summary",
        "description": "description",
        "video": "video",
    }
    localized_fields: dict[str, dict[str, str]] = {k: {} for k in field_to_attr}
    for dst_key in ("name", "summary", "description"):
        seed = getattr(app, field_to_attr[dst_key])
        if seed:
            localized_fields[dst_key][DEFAULT_LOCALE] = seed
    for loc in app.localizations:
        for dst_key, attr in field_to_attr.items():
            override = getattr(loc, attr, None)
            if override:
                localized_fields[dst_key][loc.locale] = override
    for dst_key, by_locale in localized_fields.items():
        if by_locale:
            metadata[dst_key] = by_locale
    if app.author_name:
        metadata["authorName"] = app.author_name
    if app.author_email:
        metadata["authorEmail"] = app.author_email
    if app.website:
        metadata["webSite"] = app.website
    if app.source_code:
        metadata["sourceCode"] = app.source_code
    if app.issue_tracker:
        metadata["issueTracker"] = app.issue_tracker
    if app.translation:
        metadata["translation"] = app.translation
    if app.donate:
        metadata["donate"] = app.donate
    if app.liberapay:
        metadata["liberapay"] = app.liberapay
    if app.bitcoin:
        metadata["bitcoin"] = app.bitcoin
    if app.open_collective:
        metadata["openCollective"] = app.open_collective
    icon_entry = _file_entry(app.icon_path, file_meta)
    if icon_entry is not None:
        metadata["icon"] = {DEFAULT_LOCALE: icon_entry}
    # Featured / promo / TV banner — same {locale: File} shape as the icon.
    # The locale comes from the storage path so per-locale variants could
    # slot in later without changing the index code.
    for path, dst_key in (
        (app.feature_graphic_path, "featureGraphic"),
        (app.promo_graphic_path, "promoGraphic"),
        (app.tv_banner_path, "tvBanner"),
    ):
        entry = _file_entry(path, file_meta)
        if entry is None:
            continue
        parts = (path or "").split("/")
        locale = parts[-2] if len(parts) >= 2 else DEFAULT_LOCALE
        metadata[dst_key] = {locale: entry}

    # Screenshots — v2 nests them as ``screenshots.<deviceType>.<locale>[]``.
    # We currently only emit the "phone" device type.
    shots_by_locale: dict[str, list[dict[str, Any]]] = {}
    for s in sorted(app.screenshots, key=lambda x: x.display_order):
        entry = _file_entry(s.storage_key, file_meta)
        if entry is None:
            continue
        shots_by_locale.setdefault(s.locale, []).append(entry)
    if shots_by_locale:
        metadata["screenshots"] = {"phone": shots_by_locale}

    # Most-recent signer wins (matches fdroidserver's behavior)
    if apks:
        metadata["preferredSigner"] = apks[0].signer_sha256

    versions: dict[str, Any] = {}
    for apk in apks:
        manifest: dict[str, Any] = {
            "versionCode": apk.version_code,
            "versionName": apk.version_name,
            "signer": {"sha256": [apk.signer_sha256]},
        }
        if apk.min_sdk:
            # targetSdkVersion defaults to minSdkVersion when not declared
            # (matches the Android manifest semantics + fdroidserver)
            manifest["usesSdk"] = {
                "minSdkVersion": apk.min_sdk,
                "targetSdkVersion": apk.target_sdk or apk.min_sdk,
            }
        if apk.max_sdk:
            manifest["maxSdkVersion"] = apk.max_sdk
        if apk.permissions:
            manifest["usesPermission"] = [{"name": p} for p in apk.permissions]
        if apk.features:
            manifest["features"] = [{"name": f} for f in apk.features]
        if apk.native_code:
            manifest["nativecode"] = list(apk.native_code)

        version_obj: dict[str, Any] = {
            "added": _ts_ms(apk.published_at or apk.created_at),
            "file": {
                "name": f"/{apk.file_name}",
                "sha256": apk.sha256,
                "size": apk.size_bytes,
            },
            "manifest": manifest,
        }
        # v2 supports release notes per version, localized. Apk.whats_new is
        # already shaped as ``{locale: text}`` post-migration — pass it
        # through, just trimmed of empty entries.
        if apk.whats_new:
            trimmed = {l: t for l, t in apk.whats_new.items() if t}
            if trimmed:
                version_obj["whatsNew"] = trimmed
        if apk.anti_features:
            # v2 shape: ``{label: {locale: reason}}``. We don't currently
            # capture per-flag reasons (admins overwhelmingly leave them
            # empty in practice), so each label maps to an empty dict — the
            # client renders the badge without a tooltip text.
            version_obj["antiFeatures"] = {flag: {} for flag in apk.anti_features}
        versions[apk.sha256] = version_obj

    return {"metadata": metadata, "versions": versions}


def build_index_v2(
    *,
    repo_config: RepoConfig,
    apps: Iterable[App],
    mirrors: list[str] | None = None,
    file_meta: dict[str, dict[str, Any]] | None = None,
    timestamp_ms: int | None = None,
) -> bytes:
    """``file_meta`` maps each referenced icon storage key to its content
    hash + size. The F-Droid v2 client rejects icon entries that don't carry
    these, so the caller is responsible for hashing icons before calling.

    ``timestamp_ms`` MUST be passed the same value used for ``entry.json``
    (see ``build_entry_json``): the F-Droid v2 client binds the signed entry
    to this index by both checksum AND timestamp, so a mismatch is rejected.
    """
    now_ms = timestamp_ms if timestamp_ms is not None else int(datetime.now(UTC).timestamp() * 1000)
    packages: dict[str, Any] = {}
    categories_seen: set[str] = set()
    for app in apps:
        published = [a for a in app.apks if a.status.value == "published"]
        if not published:
            continue
        # apks come ordered version_code desc, so [0] is the latest
        published.sort(key=lambda a: a.version_code, reverse=True)
        packages[app.package_name] = _build_package(app, published, file_meta)
        for c in app.categories:
            categories_seen.add(c.name)

    repo_block: dict[str, Any] = {
        "name": _localized(repo_config.name) or {DEFAULT_LOCALE: "Repository"},
        "address": repo_config.address,
        "timestamp": now_ms,
    }
    desc = _localized(repo_config.description)
    if desc is not None:
        repo_block["description"] = desc
    repo_icon = _file_entry(repo_config.icon_path, file_meta)
    if repo_icon is not None:
        repo_block["icon"] = {DEFAULT_LOCALE: repo_icon}
    if mirrors:
        repo_block["mirrors"] = [{"url": m} for m in mirrors]
    if categories_seen:
        repo_block["categories"] = {
            c: {"name": {DEFAULT_LOCALE: c}} for c in sorted(categories_seen)
        }

    payload: dict[str, Any] = {"repo": repo_block, "packages": packages}
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def build_entry_json(index_v2_bytes: bytes, timestamp_ms: int | None = None) -> bytes:
    """Build the ``entry.json`` companion to index-v2.json.

    It contains a checksum of ``index-v2.json`` so the F-Droid client can
    verify the (large, unsigned) index against this (small, signed) entry.
    """
    ts = timestamp_ms or int(datetime.now(UTC).timestamp() * 1000)
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
