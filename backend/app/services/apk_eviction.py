"""Retention-policy enforcement: cap the number of APK versions per app.

Triggered after each successful APK attach (manual upload, with-apk
create, with-github-source create, worker-driven release fetch). When
the per-app count exceeds the effective cap, we evict the oldest APKs
by ``version_code`` ascending until the count is back in range.

Two safeguards:

  * The suggested version (``App.suggested_version_code``) is never
    evicted — F-Droid clients rely on it to know which version to
    install. We skip past it and pull the next-oldest eligible row.
  * ``0`` on the per-app override is a sentinel for "no cap on this
    app even if the repo default would impose one" — useful for a
    long-history library where the admin wants the global eviction
    policy to skip this entry.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.models.apk import Apk
from app.models.app import App
from app.models.repo_config import RepoConfig
from app.services.audit import write_event
from app.storage import get_storage

log = get_logger(__name__)


def effective_max_versions(app: App, repo_config: RepoConfig | None) -> int | None:
    """Pick the effective cap for an app.

    Precedence: a per-app override can only TIGHTEN (lower) the
    repo-wide default — never widen it. This means setting an
    override to ``0`` ("no cap on this app") is only honoured when
    the repo default is itself unset; otherwise the default wins.
    Setting an override greater than the default is also clamped
    back down to the default. Rationale: the repo-wide retention
    policy is the operator's hard ceiling; per-app overrides exist
    so an admin can be MORE strict on a single app (e.g. a noisy
    nightly app), not to grant exceptions.
    """
    default = repo_config.default_max_versions_per_app if repo_config else None
    override = app.max_versions_override
    if override is None:
        return default
    if override == 0:
        # "Unlimited for this app" — only meaningful when no global
        # default is in force. Otherwise the default wins.
        return default
    if default is None:
        return override
    return min(override, default)


async def evict_oldest_if_needed(
    db: AsyncSession,
    *,
    app: App,
    actor_id: uuid.UUID | None = None,
) -> list[uuid.UUID]:
    """Trim ``app.apks`` down to the effective cap. Returns the list
    of deleted APK ids (empty when no eviction was needed).

    Safe to call on every upload. Idempotent: a second invocation when
    the count is already under the cap returns immediately.
    """
    config = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
    cap = effective_max_versions(app, config)
    if cap is None or cap <= 0:
        return []

    # We sort by version_code ASC (oldest first). The session relationship
    # is ordered DESC by default; pulling a fresh query keeps the
    # operations explicit and lets us bail early when the cap is met.
    rows = (
        await db.execute(
            select(Apk).where(Apk.app_id == app.id).order_by(Apk.version_code.asc())
        )
    ).scalars().all()
    if len(rows) <= cap:
        return []

    storage = get_storage()
    deleted: list[uuid.UUID] = []
    # Walk the oldest-first list; whenever we hit the suggested version,
    # skip it and look at the next candidate. We stop as soon as the
    # remaining count matches the cap.
    suggested_code = app.suggested_version_code
    remaining = len(rows)
    for row in rows:
        if remaining <= cap:
            break
        if suggested_code is not None and row.version_code == suggested_code:
            # Protected — never evict the suggested version even if it's
            # the oldest. Note the skip in the audit log so an admin can
            # see why a particular app stays above the cap.
            await write_event(
                db,
                action="apk.retention_skip",
                actor=None,
                target_type="apk",
                target_id=row.id,
                summary=(
                    f"retention kept {app.package_name} v{row.version_name} "
                    f"({row.version_code}) — suggested version"
                ),
                payload={
                    "app_id": str(app.id),
                    "package_name": app.package_name,
                    "version_code": row.version_code,
                    "version_name": row.version_name,
                    "reason": "suggested_version",
                    "cap": cap,
                },
            )
            continue
        try:
            await storage.delete(row.storage_key)
        except Exception as exc:  # noqa: BLE001
            # Storage failures shouldn't poison the DB delete — log
            # and continue. Worst case: an orphaned object on disk
            # that doesn't affect correctness.
            log.warning(
                "storage delete failed during retention eviction",
                key=row.storage_key,
                error=str(exc),
            )
        await db.delete(row)
        deleted.append(row.id)
        remaining -= 1
        await write_event(
            db,
            action="apk.evicted",
            actor=None,
            target_type="apk",
            target_id=row.id,
            summary=(
                f"retention deleted {app.package_name} v{row.version_name} "
                f"({row.version_code}) — over cap ({cap})"
            ),
            payload={
                "app_id": str(app.id),
                "package_name": app.package_name,
                "version_code": row.version_code,
                "version_name": row.version_name,
                "cap": cap,
                "triggered_by": str(actor_id) if actor_id else None,
            },
        )
    if deleted:
        await db.flush()
    return deleted


def preview_next_eviction(
    apks: list[Apk],
    suggested_code: int | None,
    cap: int | None,
) -> Apk | None:
    """Return the APK that would be evicted on the very next upload, or
    ``None`` when none would. Pure helper for the frontend banner —
    doesn't touch the DB. ``apks`` may be in any order; we sort.
    """
    if cap is None or cap <= 0:
        return None
    # The "+1" simulates the about-to-arrive APK that triggers the cap.
    if len(apks) + 1 <= cap:
        return None
    sorted_apks = sorted(apks, key=lambda a: a.version_code)
    for row in sorted_apks:
        if suggested_code is not None and row.version_code == suggested_code:
            continue
        return row
    return None
