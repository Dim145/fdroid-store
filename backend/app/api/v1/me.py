from __future__ import annotations

import uuid as uuid_module
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import desc, func, select, update
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession, get_current_user
from app.core.rate_limit import limiter
from app.core.security import hash_password, verify_password
from app.core.user_agent import classify_user_agent
from app.models.apk import Apk, ApkStatus
from app.models.app import App, AppVisibility
from app.models.audit import DownloadEvent
from app.models.refresh_token import RefreshToken
from app.models.user import User, UserRole
from app.models.user_session import UserSession
from app.schemas.app import AppRead
from app.schemas.auth import ChangePasswordRequest
from app.schemas.user_session import UserSessionRead
from app.services.auth_service import revoke_all_refresh_tokens
from app.schemas.user import UserRead, UserUpdate

router = APIRouter()


@router.get("", response_model=UserRead)
async def get_me(user: Annotated[User, Depends(get_current_user)]) -> UserRead:
    return UserRead.model_validate(user)


@router.patch("", response_model=UserRead)
async def update_me(
    payload: UserUpdate,
    user: Annotated[User, Depends(get_current_user)],
    db: DbSession,
) -> UserRead:
    if payload.full_name is not None:
        user.full_name = payload.full_name
    nsfw_changed = False
    if payload.show_nsfw is not None and payload.show_nsfw != user.show_nsfw:
        user.show_nsfw = payload.show_nsfw
        nsfw_changed = True
    # ``preferred_locale`` accepts an explicit null to clear the
    # preference, so we key off ``model_fields_set`` rather than ``is not None``.
    if "preferred_locale" in payload.model_fields_set:
        user.preferred_locale = payload.preferred_locale
    await db.flush()
    if nsfw_changed:
        # The F-Droid index served to this user's API keys must be rebuilt
        # so the new NSFW preference takes effect there too. Best-effort —
        # we don't fail the request if the queue is down.
        from app.services.queue import enqueue_reindex
        await enqueue_reindex()
    return UserRead.model_validate(user)


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT, response_model=None, response_class=Response)
async def change_password(
    payload: ChangePasswordRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: DbSession,
) -> None:
    if user.hashed_password is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This account does not use a password (linked to an external IdP)",
        )
    if not verify_password(payload.current_password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect",
        )
    user.hashed_password = hash_password(payload.new_password)
    # C5: bumping password_changed_at invalidates every JWT minted before
    # this moment via the iat check in deps.py. C6: explicitly revoke
    # every outstanding refresh token so a leaked refresh can't be
    # redeemed even before its 30-day expiry.
    user.password_changed_at = datetime.now(UTC)
    await revoke_all_refresh_tokens(db, user.id)
    await db.flush()


@router.get("/downloads")
async def my_download_history(
    user: Annotated[User, Depends(get_current_user)],
    db: DbSession,
    limit: int = Query(default=100, ge=1, le=500),
) -> dict:
    """One row per app the user has ever downloaded.

    Each row carries the latest download timestamp + the version code the
    user grabbed, plus the latest published version on the repo today so
    the UI can render a "newer version available" hint. Total download
    count is summed across all versions of the same app.

    Note on installation status: F-Droid Android clients don't report back
    to the repo (no telemetry channel exists in the F-Droid spec), so we
    can't actually know whether the APK is still on a device. The closest
    proxy is "you downloaded the latest version recently" — anything
    stronger would require a companion app or a re-architected sync model.
    """
    # Per-app aggregates: most recent download timestamp, total event count,
    # the apk_id the user grabbed last, total bytes served.
    last_event_per_app = (
        select(
            DownloadEvent.app_id.label("app_id"),
            func.max(DownloadEvent.created_at).label("last_at"),
            func.count(DownloadEvent.id).label("dl_count"),
            func.coalesce(func.sum(DownloadEvent.bytes_served), 0).label("bytes_total"),
        )
        .where(DownloadEvent.user_id == user.id)
        .group_by(DownloadEvent.app_id)
        .subquery()
    )

    # Highest published version_code per app — the "current latest" the
    # repo would serve today. Apps with no published APK (all withdrawn)
    # come back as NULL via the outer join.
    latest_published = (
        select(
            Apk.app_id.label("app_id"),
            func.max(Apk.version_code).label("max_vc"),
        )
        .where(Apk.status == ApkStatus.PUBLISHED)
        .group_by(Apk.app_id)
        .subquery()
    )

    stmt = (
        select(
            App,
            last_event_per_app.c.last_at,
            last_event_per_app.c.dl_count,
            last_event_per_app.c.bytes_total,
            latest_published.c.max_vc,
        )
        .options(selectinload(App.apks))
        .join(last_event_per_app, App.id == last_event_per_app.c.app_id)
        .outerjoin(latest_published, App.id == latest_published.c.app_id)
        .order_by(desc(last_event_per_app.c.last_at))
        .limit(limit)
    )
    rows = (await db.execute(stmt)).all()

    # For each app, look up which APK the user actually downloaded most
    # recently — version_code + version_name — AND in the same pass
    # tally the user_agent into a coarse "web vs client" breakdown.
    # Single query keyed on (user, app); UA classification happens in
    # Python on the rows we already had to fetch for the latest-APK
    # lookup, so the breakdown is effectively free.
    events_raw = (
        await db.execute(
            select(
                DownloadEvent.app_id,
                DownloadEvent.apk_id,
                DownloadEvent.created_at,
                DownloadEvent.user_agent,
            )
            .where(
                DownloadEvent.user_id == user.id,
                DownloadEvent.app_id.in_([app.id for app, *_ in rows]),
            )
        )
    ).all()
    # Reduce to ``{app_id: apk_id with max created_at}`` + per-app UA
    # family counts.
    chosen_apk_per_app: dict[uuid_module.UUID, uuid_module.UUID] = {}
    chosen_at: dict[uuid_module.UUID, datetime] = {}
    client_breakdown_per_app: dict[uuid_module.UUID, dict[str, int]] = {}
    for app_id, apk_id, created_at, user_agent in events_raw:
        if app_id not in chosen_at or created_at > chosen_at[app_id]:
            chosen_at[app_id] = created_at
            chosen_apk_per_app[app_id] = apk_id
        kind = classify_user_agent(user_agent)
        bd = client_breakdown_per_app.setdefault(app_id, {})
        bd[kind] = bd.get(kind, 0) + 1

    # Mint a signed media token per-row so private-app icons render.
    # ``<img src>`` carries no Authorization header; without this the
    # history view 404s every private app's thumbnail.
    from app.core.download_token import sign_media_token

    items = []
    for app, last_at, dl_count, bytes_total, max_vc in rows:
        last_apk = next(
            (a for a in app.apks if a.id == chosen_apk_per_app.get(app.id)),
            None,
        )
        # ``app.apks`` is already ordered by version_code desc on the
        # relationship, so the first PUBLISHED entry is the current latest.
        current_latest = next(
            (a for a in app.apks if a.status == ApkStatus.PUBLISHED),
            None,
        )
        # Only mint a token for non-public apps the caller can actually
        # see (admin or owner). Public-app icons need no token.
        is_owner = app.owner_id is not None and app.owner_id == user.id
        media_token = None
        if app.visibility != AppVisibility.PUBLIC and (
            user.role == UserRole.ADMIN or is_owner
        ):
            media_token = sign_media_token(app.package_name, user.id)
        items.append(
            {
                "app_id": str(app.id),
                "package_name": app.package_name,
                "app_name": app.name,
                "icon_path": app.icon_path,
                # The frontend's ``mediaUrl(path, { version })`` appends
                # ``?v=<updated_at>`` so the URL is stable across pages
                # for the same icon (cache hit) but turns over when the
                # owner replaces the asset. /apps already does this;
                # without ``updated_at`` here, /history rendered the
                # icon under a bare URL and the browser cached the two
                # variants independently — re-downloading on every
                # /history → /apps round-trip.
                #
                # Format note: ``datetime.isoformat()`` gives
                # ``+00:00`` for UTC, but Pydantic v2 (used by /apps)
                # serialises tz-aware UTC datetimes with a trailing
                # ``Z``. The two are semantically equivalent but the
                # URL-encoded forms differ (``Z`` vs ``%2B00%3A00``),
                # so the cache would split into two entries again.
                # Normalise to the ``Z`` form to match /apps exactly.
                "updated_at": (
                    app.updated_at.isoformat().replace("+00:00", "Z")
                    if app.updated_at else None
                ),
                "media_token": media_token,
                "download_count": int(dl_count),
                "bytes_total": int(bytes_total or 0),
                "last_downloaded_at": last_at.isoformat() if last_at else None,
                "last_apk_version_code": last_apk.version_code if last_apk else None,
                "last_apk_version_name": last_apk.version_name if last_apk else None,
                "latest_apk_version_code": (
                    current_latest.version_code if current_latest else max_vc
                ),
                "latest_apk_version_name": (
                    current_latest.version_name if current_latest else None
                ),
                "has_update_available": (
                    last_apk is not None
                    and current_latest is not None
                    and current_latest.version_code > last_apk.version_code
                ),
                # Coarse origin tally (web / fdroid / cli / other /
                # unknown). The frontend renders one chip per non-zero
                # bucket so the user can see at a glance whether they
                # grabbed an APK from their phone's F-Droid client or
                # straight from the SPA in a desktop browser.
                "client_breakdown": client_breakdown_per_app.get(app.id, {}),
            }
        )
    return {"items": items}


@router.get("/apps", response_model=list[AppRead])
async def my_apps(
    user: Annotated[User, Depends(get_current_user)],
    db: DbSession,
) -> list[AppRead]:
    """Apps the user can manage: those they own + those they co-maintain.

    A union query: owner_id matches OR there exists a collaborator row
    for this user. Deduplicated client-side via ``unique()``.
    """
    from sqlalchemy import or_
    from sqlalchemy.orm import selectinload

    from app.models.app import App
    from app.models.app_collaborator import AppCollaborator

    collab_app_ids = (
        select(AppCollaborator.app_id).where(AppCollaborator.user_id == user.id)
    )
    stmt = (
        select(App)
        .options(selectinload(App.categories), selectinload(App.apks))
        .where(or_(App.owner_id == user.id, App.id.in_(collab_app_ids)))
        .order_by(App.created_at.desc())
    )
    rows = (await db.execute(stmt)).scalars().unique().all()
    # ``/me/apps`` is by definition only invoked by the owner (or co-
    # maintainer) of the listed apps, so we can mint a media token
    # unconditionally — the SPA needs it for private-app thumbnails.
    from app.api.v1.apps import _attach_media_token
    out = []
    for a in rows:
        p = AppRead.model_validate(a)
        _attach_media_token(p, a, user)
        out.append(p)
    return out


# --------------------------------------------------------------------------
# Sessions
# --------------------------------------------------------------------------
@router.get("/sessions", response_model=list[UserSessionRead])
async def list_my_sessions(
    user: Annotated[User, Depends(get_current_user)],
    db: DbSession,
) -> list[UserSessionRead]:
    """All sessions for the calling user, newest first. Includes revoked
    rows so the UI can show "ended 5 minutes ago"; the frontend hides them
    behind a toggle."""
    rows = (
        await db.execute(
            select(UserSession)
            .where(UserSession.user_id == user.id)
            .order_by(desc(UserSession.last_seen_at))
        )
    ).scalars().all()
    return [UserSessionRead.model_validate(r) for r in rows]


async def _revoke_session_chain(
    db,
    *,
    session: UserSession,
) -> None:
    """Revoke a session + its refresh-token chain in one go."""
    now = datetime.now(UTC)
    if session.revoked_at is None:
        session.revoked_at = now
    # The session.jti points at the live refresh token; mark every refresh
    # row tied to it (and its descendants in the family) revoked.
    await db.execute(
        update(RefreshToken)
        .where(
            RefreshToken.jti == session.jti,
            RefreshToken.revoked_at.is_(None),
        )
        .values(revoked_at=now)
    )


@router.delete(
    "/sessions/{session_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    response_class=Response,
)
async def revoke_my_session(
    session_id: uuid_module.UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: DbSession,
) -> None:
    """Revoke one session of the calling user.

    Revoking the session you're currently using is allowed; the next API
    call that needs to refresh will fail and the SPA will redirect to
    /login. We never enforce "you can't revoke yourself" — UI can't reliably
    detect the current session anyway (the access JWT carries no session
    id), and "boot myself out everywhere" is a legitimate user action."""
    session = (
        await db.execute(
            select(UserSession).where(
                UserSession.id == session_id,
                UserSession.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    await _revoke_session_chain(db, session=session)


@router.delete(
    "/sessions",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    response_class=Response,
)
async def revoke_all_my_sessions(
    user: Annotated[User, Depends(get_current_user)],
    db: DbSession,
) -> None:
    """Burn every session of the calling user. Equivalent to "log out
    everywhere". The next request from any of those sessions will be
    refused on its next refresh attempt."""
    await revoke_all_refresh_tokens(db, user.id)


# --------------------------------------------------------------------------
# Quotas
# --------------------------------------------------------------------------
@router.get("/quotas")
async def my_quota_usage(
    user: Annotated[User, Depends(get_current_user)],
    db: DbSession,
) -> dict:
    """Per-dimension usage + cap for the calling user. Admins see their own
    row's caps (always None) for completeness, even though the enforcement
    layer skips them."""
    from app.services.quotas import usage_summary

    return await usage_summary(db, user)


# --------------------------------------------------------------------------
# GDPR data export
# --------------------------------------------------------------------------
# Right to data portability (Art. 20 GDPR): every user can download a
# machine-readable copy of everything we hold on them. The response is a
# single JSON object covering profile, apps owned / collaborated, download
# events, and the audit-log entries where the user is the actor.
#
# Synchronous on purpose — even a busy maintainer typically has a few
# hundred events at most, which a single query batch + json dump finishes
# in well under a second. For multi-million-event accounts we'd switch to
# an async job + signed URL.

def _iso(d: datetime | None) -> str | None:
    """Match the ``Z``-suffix format Pydantic emits on the rest of the API
    so an exported timestamp can be diffed against, say, a /apps payload
    string-for-string."""
    return d.isoformat().replace("+00:00", "Z") if d else None


@router.get("/export")
@limiter.limit("2/minute")
async def export_my_data(
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
    db: DbSession,
) -> Response:
    """GDPR-style data export — a single JSON file containing everything we
    hold on the calling user. The response sets ``Content-Disposition:
    attachment`` so a browser saves it as
    ``fdroid-store-export-<username>-<YYYY-MM-DD>.json``.

    Sections:
      * ``profile``                 — the account row
      * ``apps_owned``              — full metadata of every app where the
                                      caller is ``owner_id``, with each
                                      published APK summarised
      * ``app_collaborations``      — apps where the caller is co-maintainer
                                      (just references, the full payload
                                      belongs to the owner's export)
      * ``downloads``               — per-event log of the caller's
                                      downloads (anonymised IP, UA classifier)
      * ``audit_log``               — every action where the caller is the
                                      actor (admin actions if applicable,
                                      collaborator changes, etc.)
    """
    import json as _json

    from app.models.app_collaborator import AppCollaborator
    from app.models.audit_log import AuditLog

    # --- profile ---------------------------------------------------------
    profile = {
        "id": str(user.id),
        "email": user.email,
        "username": user.username,
        "full_name": user.full_name,
        "role": user.role.value,
        "auth_provider": user.auth_provider.value,
        "preferred_locale": user.preferred_locale,
        "show_nsfw": user.show_nsfw,
        "is_active": user.is_active,
        "created_at": _iso(user.created_at),
        "updated_at": _iso(user.updated_at),
        "last_login_at": _iso(user.last_login_at),
        "password_changed_at": _iso(user.password_changed_at),
        # Quotas the user is actually subject to (per-user override or the
        # repo default; ``None`` = unlimited on either dimension).
        "quotas": {
            "max_apps": user.quota_max_apps,
            "max_storage_bytes": user.quota_max_storage_bytes,
            "max_apks_per_month": user.quota_max_apks_per_month,
        },
    }

    # --- apps owned ------------------------------------------------------
    owned_rows = (
        await db.execute(
            select(App)
            .options(selectinload(App.apks), selectinload(App.categories))
            .where(App.owner_id == user.id)
            .order_by(App.created_at)
        )
    ).scalars().unique().all()
    apps_owned = []
    for app in owned_rows:
        apks_list = [
            {
                "id": str(apk.id),
                "version_name": apk.version_name,
                "version_code": apk.version_code,
                "file_name": apk.file_name,
                "size_bytes": apk.size_bytes,
                "sha256": apk.sha256,
                "status": apk.status.value,
                "anti_features": apk.anti_features or [],
                "min_sdk": apk.min_sdk,
                "target_sdk": apk.target_sdk,
                "whats_new": apk.whats_new,
                "created_at": _iso(apk.created_at),
            }
            for apk in (app.apks or [])
        ]
        apps_owned.append({
            "id": str(app.id),
            "package_name": app.package_name,
            "name": app.name,
            "summary": app.summary,
            "description": app.description,
            "license": app.license,
            "website": app.website,
            "source_code": app.source_code,
            "issue_tracker": app.issue_tracker,
            "author_name": app.author_name,
            "author_email": app.author_email,
            "visibility": app.visibility.value,
            "status": app.status.value,
            "categories": [c.name for c in (app.categories or [])],
            "created_at": _iso(app.created_at),
            "updated_at": _iso(app.updated_at),
            "apks": apks_list,
        })

    # --- collaborations (apps owned by someone else) ---------------------
    collab_rows = (
        await db.execute(
            select(AppCollaborator, App)
            .join(App, App.id == AppCollaborator.app_id)
            .where(AppCollaborator.user_id == user.id)
            .order_by(AppCollaborator.granted_at)
        )
    ).all()
    app_collaborations = [
        {
            "app_id": str(app.id),
            "package_name": app.package_name,
            "app_name": app.name,
            "granted_at": _iso(c.granted_at),
            "granted_by": str(c.granted_by) if c.granted_by else None,
        }
        for c, app in collab_rows
    ]

    # --- download history ------------------------------------------------
    dl_rows = (
        await db.execute(
            select(DownloadEvent, App, Apk)
            .join(App, App.id == DownloadEvent.app_id)
            .outerjoin(Apk, Apk.id == DownloadEvent.apk_id)
            .where(DownloadEvent.user_id == user.id)
            .order_by(desc(DownloadEvent.created_at))
        )
    ).all()
    downloads = [
        {
            "created_at": _iso(ev.created_at),
            "app_id": str(app.id),
            "package_name": app.package_name,
            "app_name": app.name,
            "apk_id": str(apk.id) if apk else None,
            "version_name": apk.version_name if apk else None,
            "version_code": apk.version_code if apk else None,
            "bytes_served": ev.bytes_served,
            "status_code": ev.status_code,
            "client_family": classify_user_agent(ev.user_agent),
        }
        for ev, app, apk in dl_rows
    ]

    # --- audit log (filtered on actor=self) ------------------------------
    audit_rows = (
        await db.execute(
            select(AuditLog)
            .where(AuditLog.actor_id == user.id)
            .order_by(desc(AuditLog.created_at))
        )
    ).scalars().all()
    audit_log = [
        {
            "created_at": _iso(row.created_at),
            "action": row.action,
            "target_type": row.target_type,
            "target_id": row.target_id,
            "summary": row.summary,
            "payload": row.payload,
        }
        for row in audit_rows
    ]

    payload = {
        "format": "fdroid-store/export-v1",
        "exported_at": _iso(datetime.now(UTC)),
        "profile": profile,
        "apps_owned": apps_owned,
        "app_collaborations": app_collaborations,
        "downloads": downloads,
        "audit_log": audit_log,
    }
    body = _json.dumps(payload, indent=2, ensure_ascii=False)

    date_slug = datetime.now(UTC).strftime("%Y-%m-%d")
    # Username may contain dots that are awkward in filenames (e.g. on
    # Windows), but anything Pydantic-validated is alphanumeric + dot + _;
    # the worst case is a ``.`` after the username, which every modern OS
    # handles fine.
    filename = f"fdroid-store-export-{user.username}-{date_slug}.json"
    return Response(
        content=body,
        media_type="application/json; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )
