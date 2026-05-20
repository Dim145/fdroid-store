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
from app.core.rate_limit import limiter
from app.models.app import App
from app.models.github_source import GithubSource, GithubSourceStatus
from app.models.user import User
from app.schemas.github_source import (
    GithubSourceRead,
    GithubSourceUpsert,
    GithubSourceUpsertResponse,
    ProposedAppField,
)
from app.services.app_permissions import assert_can_manage_app, assert_owner_or_admin
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
    response_model=GithubSourceUpsertResponse,
)
@limiter.limit("10/minute")
async def upsert_github_source(
    app_id: uuid.UUID,
    request: Request,
    payload: GithubSourceUpsert,
    db: DbSession,
    actor: Annotated[User, Depends(get_current_user)],
) -> GithubSourceUpsertResponse:
    """Create or replace the release source. Owner/admin only —
    co-maintainers are deliberately blocked from changing the upstream
    pointer because it changes WHAT gets published into the repo
    (a co-maintainer swapping to a malicious fork would silently start
    importing arbitrary APKs the owner never authorised). They can
    still trigger a manual scan via the ``/scan`` endpoint below.

    Also fetches the repo's metadata (description / homepage / license
    / owner) and returns a list of currently-empty App fields that the
    repo could populate."""
    app = await _load_app_or_404(db, app_id)
    assert_owner_or_admin(actor, app)

    existing = (
        await db.execute(
            select(GithubSource).where(GithubSource.app_id == app_id)
        )
    ).scalar_one_or_none()

    is_new = existing is None
    repo_changed = bool(existing and existing.repo.lower() != payload.repo.lower())

    # Re-validate provider transitions too: changing the forge resets
    # the import bookmark just like repo_changed does.
    provider_changed = bool(
        existing
        and existing.provider != payload.provider
    )
    base_url_changed = bool(
        existing
        and (existing.base_url or "") != (payload.base_url or "")
    )

    # Token write-through. ``access_token`` is in ``model_fields_set``
    # only when the client explicitly sent the key (vs. left it
    # off entirely) — that's the three-way "set / clear / leave" gate.
    from app.services.crypto import encrypt as _enc

    _SENTINEL = object()
    new_token_blob: bytes | None | object = _SENTINEL
    if "access_token" in payload.model_fields_set:
        raw = (payload.access_token or "").strip()
        new_token_blob = _enc(raw) if raw else None
    token_action: str | None = None

    if existing is None:
        existing = GithubSource(
            app_id=app_id,
            repo=payload.repo,
            provider=payload.provider,
            base_url=payload.base_url,
            asset_pattern=payload.asset_pattern,
            include_prereleases=payload.include_prereleases,
            enabled=payload.enabled,
            created_by=actor.id,
            last_status=GithubSourceStatus.IDLE,
        )
        if new_token_blob is not _SENTINEL:
            existing.access_token_encrypted = new_token_blob  # type: ignore[assignment]
            if new_token_blob is not None:
                token_action = "set"
        db.add(existing)
    else:
        existing.repo = payload.repo
        existing.provider = payload.provider
        existing.base_url = payload.base_url
        existing.asset_pattern = payload.asset_pattern
        existing.include_prereleases = payload.include_prereleases
        existing.enabled = payload.enabled
        if new_token_blob is not _SENTINEL:
            had_token = bool(existing.access_token_encrypted)
            existing.access_token_encrypted = new_token_blob  # type: ignore[assignment]
            if new_token_blob is None and had_token:
                token_action = "cleared"
            elif new_token_blob is not None:
                token_action = "set"
        # When the repo, provider or base URL changes, reset the import
        # bookmark so the next scan considers the newest release rather
        # than dedup'ing against a tag from a different source.
        if repo_changed or provider_changed or base_url_changed:
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
            "provider": payload.provider.value,
            "base_url": payload.base_url,
            "asset_pattern": payload.asset_pattern,
            "include_prereleases": payload.include_prereleases,
            "enabled": payload.enabled,
            # NEVER log the token itself — just the transition.
            "token": token_action,
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

    # Pull repo metadata in parallel-ish (the source upsert is committed,
    # the metadata fetch is best-effort). Used to compute the preview
    # card of fields that could be filled on the App row.
    from app.services.crypto import decrypt as _decrypt_for_meta
    from app.services.github_releases import fetch_repo_metadata

    proposed: list[ProposedAppField] = []
    # Use the just-saved token (or its decrypted value if the client
    # didn't touch the field this round) so private-repo metadata
    # also flows through to the proposed-update card.
    meta_token = _decrypt_for_meta(existing.access_token_encrypted)
    try:
        meta = await fetch_repo_metadata(
            payload.repo,
            provider=payload.provider.value,
            base_url=payload.base_url,
            token=meta_token,
        )
    except Exception:  # noqa: BLE001
        meta = None
    if meta is not None:
        # Tuples of (field name, current app value, candidate from GitHub).
        candidates = [
            ("summary", app.summary, meta.description),
            ("license", app.license, meta.license_spdx),
            ("website", app.website, meta.homepage),
            ("source_code", app.source_code, meta.html_url),
            ("author_name", app.author_name, meta.owner_login),
        ]
        for field_name, current, candidate in candidates:
            current_value = (current or "").strip() if isinstance(current, str) else None
            candidate_value = candidate.strip() if isinstance(candidate, str) else None
            if current_value or not candidate_value:
                # User already filled it OR GitHub has nothing — skip.
                continue
            proposed.append(
                ProposedAppField(
                    field=field_name,
                    current_value=None,
                    proposed_value=candidate_value,
                )
            )

    return GithubSourceUpsertResponse(
        source=GithubSourceRead.model_validate(refreshed),
        proposed_app_updates=proposed,
    )


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
    """Owner/admin only — same reasoning as upsert."""
    app = await _load_app_or_404(db, app_id)
    assert_owner_or_admin(actor, app)
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
@limiter.limit("20/minute")
async def scan_now(
    app_id: uuid.UUID,
    request: Request,
    db: DbSession,
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
