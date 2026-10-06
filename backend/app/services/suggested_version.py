"""Suggested-version bookkeeping shared by the upload, moderation and APK
editing paths.

The suggested version is what F-Droid clients install by default. Index-v1
carries it as ``suggestedVersionCode``; index-v2 has no such field, so every
version above it is emitted with ``releaseChannels: ["Beta"]`` instead
(fdroidserver's rule — see ``app.fdroid.index_v2.is_beta_version``). That is
what makes both a manual pin and a beta upload actually hold a version back
from F-Droid 2.0, which installs updates automatically by default.
"""
from __future__ import annotations

from collections.abc import Iterable

from app.models.apk import Apk, ApkStatus
from app.models.app import App


def recompute_auto(app: App, apks: Iterable[Apk] | None = None) -> None:
    """Point the suggested version at the newest published *stable* APK.

    No-op while the owner has pinned a version. Beta APKs are skipped unless
    nothing else is published — without a stable baseline there is nothing
    to hold a beta back against, so the newest version is suggested.

    ``apks`` lets callers pass a collection the ORM relationship doesn't
    reflect yet (a just-created APK, or one being deleted).
    """
    if app.suggested_version_is_manual:
        return
    published = [a for a in (app.apks if apks is None else apks) if a.status == ApkStatus.PUBLISHED]
    pool = [a for a in published if not a.is_beta] or published
    if pool:
        top = max(pool, key=lambda a: a.version_code)
        app.suggested_version_code = top.version_code
        app.suggested_version_name = top.version_name
    else:
        app.suggested_version_code = None
        app.suggested_version_name = None
