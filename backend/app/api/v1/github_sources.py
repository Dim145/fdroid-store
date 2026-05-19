"""GitHub release auto-fetch — per-app configuration endpoints.

Routes are mounted under ``/apps/{app_id}/github-source``. Visibility +
mutations follow the same rules as the rest of app management: the
owner, co-maintainers and admins can configure and trigger scans.
"""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select

from app.api.deps import DbSession, get_current_user
from app.models.app import App
from app.models.github_source import GithubSource, GithubSourceStatus
from app.models.user import User
from app.schemas.github_source import GithubSourceRead, GithubSourceUpsert
from app.services.app_permissions import assert_can_manage_app
from app.services.audit import write_event
from app.services.queue import enqueue_github_source_scan

router = APIRouter()


async def _load_app_or_404(db, app_id: uuid.UUID) -> App:
    app = (await db.execute(select(App).where(App.id == app_id))).scalar_one_or_none()
    if app is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App not found")
    return app


@router.get(
    "/{app_id}/github-source",
    response_model=GithubSourceRead | None,
)
async def get_github_source(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
) -> GithubSourceRead | None:
    """Return the configured GitHub source for this app, or null."""
    app = await _load_app_or_404(db, app_id)
    await assert_can_manage_app(db, user, app)
    source = (
        await db.execute(
            select(GithubSource).where(GithubSource.app_id == app_id)
        )
    ).scalar_one_or_none()
    if source is None:
        return None
    return GithubSourceRead.model_validate(source)


@router.put(
    "/{app_id}/github-source",
    response_model=GithubSourceRead,
)
async def upsert_github_source(
    app_id: uuid.UUID,
    payload: GithubSourceUpsert,
    db: DbSession,
    request: Request,
    actor: Annotated[User, Depends(get_current_user)],
) -> GithubSourceRead:
    """Create or replace the GitHub source. Triggers an immediate scan so
    the user sees results without waiting for the daily cron — even if
    the source is in disabled state, the explicit save is treated as a
    one-shot scan trigger."""
    app = await _load_app_or_404(db, app_id)
    await assert_can_manage_app(db, actor, app)

    existing = (
        await db.execute(
            select(GithubSource).where(GithubSource.app_id == app_id)
        )
    ).scalar_one_or_none()

    is_new = existing is None
    repo_changed = bool(existing and existing.repo.lower() != payload.repo.lower())

    if existing is None:
        existing = GithubSource(
            app_id=app_id,
            repo=payload.repo,
            asset_pattern=payload.asset_pattern,
            include_prereleases=payload.include_prereleases,
            enabled=payload.enabled,
            created_by=actor.id,
            last_status=GithubSourceStatus.IDLE,
        )
        db.add(existing)
    else:
        existing.repo = payload.repo
        existing.asset_pattern = payload.asset_pattern
        existing.include_prereleases = payload.include_prereleases
        existing.enabled = payload.enabled
        # When the repo changes, reset the import bookmark so the next
        # scan considers the newest release regardless of what we had
        # imported from the previous repo.
        if repo_changed:
            existing.last_release_tag = None
            existing.last_release_published_at = None
            existing.last_status = GithubSourceStatus.IDLE
            existing.last_error = None

    await write_event(
        db,
        action="github_source.upserted" if not is_new else "github_source.created",
        actor=actor,
        target_type="app",
        target_id=app.id,
        summary=f"GitHub source set to {payload.repo} for {app.package_name}",
        payload={
            "repo": payload.repo,
            "asset_pattern": payload.asset_pattern,
            "include_prereleases": payload.include_prereleases,
            "enabled": payload.enabled,
        },
        request=request,
    )
    await db.flush()
    source_id = str(existing.id)
    await db.commit()

    # Fire-and-forget: queue an immediate scan so the UI shows the first
    # import within seconds rather than waiting for the daily cron.
    await enqueue_github_source_scan(source_id, immediate=True)

    # Re-read to capture any DB-side defaults (updated_at refresh, etc.).
    refreshed = (
        await db.execute(
            select(GithubSource).where(GithubSource.id == existing.id)
        )
    ).scalar_one()
    return GithubSourceRead.model_validate(refreshed)


@router.delete(
    "/{app_id}/github-source",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    response_class=Response,
)
async def delete_github_source(
    app_id: uuid.UUID,
    db: DbSession,
    request: Request,
    actor: Annotated[User, Depends(get_current_user)],
) -> None:
    app = await _load_app_or_404(db, app_id)
    await assert_can_manage_app(db, actor, app)
    source = (
        await db.execute(
            select(GithubSource).where(GithubSource.app_id == app_id)
        )
    ).scalar_one_or_none()
    if source is None:
        return None
    await write_event(
        db,
        action="github_source.deleted",
        actor=actor,
        target_type="app",
        target_id=app.id,
        summary=f"removed GitHub source ({source.repo}) from {app.package_name}",
        payload={"repo": source.repo},
        request=request,
    )
    await db.delete(source)
    await db.flush()


@router.post(
    "/{app_id}/github-source/scan",
    status_code=status.HTTP_202_ACCEPTED,
)
async def scan_now(
    app_id: uuid.UUID,
    db: DbSession,
    request: Request,
    actor: Annotated[User, Depends(get_current_user)],
) -> dict:
    """Trigger a one-shot scan of this app's GitHub source.

    The job runs in the worker and the result lands on the source row
    (visible via GET) and in /admin/jobs. We return 202 immediately —
    polling the GET endpoint reveals the final status.
    """
    app = await _load_app_or_404(db, app_id)
    await assert_can_manage_app(db, actor, app)
    source = (
        await db.execute(
            select(GithubSource).where(GithubSource.app_id == app_id)
        )
    ).scalar_one_or_none()
    if source is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No GitHub source configured",
        )
    await write_event(
        db,
        action="github_source.scan_triggered",
        actor=actor,
        target_type="app",
        target_id=app.id,
        summary=f"manual scan of {source.repo}",
        payload={"repo": source.repo},
        request=request,
    )
    await db.flush()
    ok = await enqueue_github_source_scan(str(source.id), immediate=True)
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Job queue unavailable",
        )
    return {"queued": True, "source_id": str(source.id)}
