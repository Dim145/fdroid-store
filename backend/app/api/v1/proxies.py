"""APK source proxy — admin registry + per-app source endpoints.

Three routers in this module:

  * :data:`admin_router` (mounted at ``/admin/proxies``) — CRUD over
    :class:`ApkProxy`, plus health / sources-refresh actions.
  * :data:`per_app_router` (mounted at ``/apps``) — per-app source
    binding (``GET/PUT/DELETE /apps/{id}/proxy-source``) and manual
    scan trigger.
  * :data:`auth_router` (mounted at ``/auth``) — OAuth callback the
    proxy redirects back to once the user completes the dance.

Audit-log coverage matches the rest of the platform: every mutation
emits an ``proxy.*`` event with payload, actor, and target ids.
"""
from __future__ import annotations

import hmac
import json
import secrets as _secrets
import uuid
from datetime import UTC, datetime
from hashlib import sha256
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import HTMLResponse
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession, get_current_admin, get_current_uploader
from app.core.config import settings
from app.core.logging import get_logger
from app.models.apk_proxy import (
    ApkProxy,
    ApkProxyHealthStatus,
    ApkProxySource,
    ApkProxySourceStatus,
)
from app.models.app import App
from app.models.user import User
from app.schemas.apk_proxy import (
    ApkProxyCreate,
    ApkProxyRead,
    ApkProxySourceCreate,
    ApkProxySourceRead,
    ApkProxySourceUpdate,
    ApkProxyUpdate,
)
from app.services.apk_proxy_client import (
    ApkProxyError,
    catalogue_to_jsonable,
    fetch_sources,
    health_check,
    utcnow,
)
from app.services.audit import write_event
from app.services.crypto import decrypt as fernet_decrypt, encrypt as fernet_encrypt

admin_router = APIRouter()
per_app_router = APIRouter()
auth_router = APIRouter()

log = get_logger(__name__)


# ============================================================================
# ADMIN — /admin/proxies
# ============================================================================


def _to_read(proxy: ApkProxy) -> ApkProxyRead:
    """ORM → ApkProxyRead. ``has_auth_token`` is a property on the row,
    Pydantic's ``from_attributes`` picks it up; ``cached_sources_json``
    is preserved as-is (already JSON-safe)."""
    return ApkProxyRead.model_validate(proxy)


async def _load_proxy_or_404(db, proxy_id: uuid.UUID) -> ApkProxy:
    row = (
        await db.execute(
            select(ApkProxy)
            .where(ApkProxy.id == proxy_id)
            .options(selectinload(ApkProxy.sources))
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Proxy not found",
        )
    return row


async def _refresh_proxy_state(proxy: ApkProxy) -> None:
    """Best-effort health + sources fetch. Updates the columns directly;
    the caller commits. Errors are caught and recorded — we don't want
    a flaky proxy to abort the create / refresh request itself."""
    now = utcnow()
    try:
        await health_check(proxy)
        proxy.last_health_status = ApkProxyHealthStatus.HEALTHY
        proxy.last_health_at = now
        proxy.last_health_error = None
    except ApkProxyError as exc:
        proxy.last_health_at = now
        proxy.last_health_error = str(exc)[:1000]
        # Map status to the right enum bucket so the admin UI can
        # tell auth issues from network issues at a glance.
        if exc.status_code in (401, 403):
            proxy.last_health_status = ApkProxyHealthStatus.AUTH_FAILED
        elif exc.status_code is not None:
            proxy.last_health_status = ApkProxyHealthStatus.BAD_RESPONSE
        else:
            proxy.last_health_status = ApkProxyHealthStatus.UNREACHABLE
        return
    # /sources only worth fetching once /healthz answered. Refusing the
    # whole row on a sources failure would be too aggressive — a proxy
    # without configured providers (catalogue empty / partial) is still
    # a valid proxy.
    try:
        catalogue = await fetch_sources(proxy)
        proxy.cached_sources_json = catalogue_to_jsonable(catalogue)
        proxy.cached_sources_at = now
    except ApkProxyError as exc:
        proxy.last_health_error = f"sources: {exc}"[:1000]
        # Health stays "HEALTHY" if /healthz worked — sources failure
        # is informational and surfaced through last_health_error.


@admin_router.get("", response_model=list[ApkProxyRead])
async def list_proxies(
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> list[ApkProxyRead]:
    """Every registered proxy. Sorted by name for stable admin UI rendering."""
    rows = (
        await db.execute(select(ApkProxy).order_by(ApkProxy.name.asc()))
    ).scalars().all()
    return [_to_read(r) for r in rows]


@admin_router.post("", response_model=ApkProxyRead, status_code=status.HTTP_201_CREATED)
async def create_proxy(
    payload: ApkProxyCreate,
    db: DbSession,
    request: Request,
    admin: Annotated[User, Depends(get_current_admin)],
) -> ApkProxyRead:
    """Register a new proxy and immediately probe ``/healthz`` + cache
    ``/sources``. A failed probe still persists the row — the admin can
    fix the URL or secret and call ``POST /admin/proxies/{id}/refresh``.

    Refuses duplicates (same ``base_url``) via the table-level unique
    constraint; the resulting ``IntegrityError`` is mapped to a clean
    409 to avoid leaking the SQL error string.
    """
    base_url = str(payload.base_url).rstrip("/")
    proxy = ApkProxy(
        name=payload.name,
        base_url=base_url,
        auth_token_encrypted=fernet_encrypt(payload.auth_token) if payload.auth_token else None,
        enabled=payload.enabled,
        created_by=admin.id,
    )
    db.add(proxy)
    try:
        await db.flush()
    except Exception as exc:  # IntegrityError on the unique constraint
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A proxy with base_url={base_url!r} is already registered",
        ) from exc
    await _refresh_proxy_state(proxy)
    await write_event(
        db,
        action="proxy.created",
        actor=admin,
        target_type="apk_proxy",
        target_id=proxy.id,
        summary=f"proxy {proxy.name!r} registered at {base_url}",
        payload={
            "name": proxy.name,
            "base_url": base_url,
            "has_auth_token": bool(payload.auth_token),
            "last_health_status": proxy.last_health_status.value,
        },
        request=request,
    )
    await db.flush()
    return _to_read(proxy)


@admin_router.get("/{proxy_id}", response_model=ApkProxyRead)
async def get_proxy(
    proxy_id: uuid.UUID,
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> ApkProxyRead:
    return _to_read(await _load_proxy_or_404(db, proxy_id))


@admin_router.patch("/{proxy_id}", response_model=ApkProxyRead)
async def update_proxy(
    proxy_id: uuid.UUID,
    payload: ApkProxyUpdate,
    db: DbSession,
    request: Request,
    admin: Annotated[User, Depends(get_current_admin)],
) -> ApkProxyRead:
    """Partial update. ``auth_token == ""`` clears the secret; ``None``
    on any field means leave-alone. Re-probes the proxy if ``base_url``
    or the secret changed so the admin sees an up-to-date health chip."""
    proxy = await _load_proxy_or_404(db, proxy_id)
    changed: dict[str, object] = {}
    if payload.name is not None and payload.name != proxy.name:
        changed["name"] = payload.name
        proxy.name = payload.name
    if payload.base_url is not None:
        new = str(payload.base_url).rstrip("/")
        if new != proxy.base_url:
            changed["base_url"] = new
            proxy.base_url = new
    if payload.auth_token is not None:
        if payload.auth_token == "":
            changed["auth_token"] = "cleared"
            proxy.auth_token_encrypted = None
        else:
            changed["auth_token"] = "set"
            proxy.auth_token_encrypted = fernet_encrypt(payload.auth_token)
    if payload.enabled is not None and payload.enabled != proxy.enabled:
        changed["enabled"] = payload.enabled
        proxy.enabled = payload.enabled
    if not changed:
        return _to_read(proxy)
    # Re-probe whenever the URL / secret changed; toggling ``enabled``
    # alone doesn't need a network round-trip.
    if "base_url" in changed or "auth_token" in changed:
        await _refresh_proxy_state(proxy)
    await write_event(
        db,
        action="proxy.updated",
        actor=admin,
        target_type="apk_proxy",
        target_id=proxy.id,
        summary=f"proxy {proxy.name!r} updated ({', '.join(changed.keys())})",
        payload=changed,
        request=request,
    )
    await db.flush()
    return _to_read(proxy)


@admin_router.delete(
    "/{proxy_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_proxy(
    proxy_id: uuid.UUID,
    db: DbSession,
    request: Request,
    admin: Annotated[User, Depends(get_current_admin)],
) -> Response:
    """Delete a proxy and cascade-remove every per-app source attached
    to it. Tail-warning written to the audit log so an admin can see
    that source bindings were dropped along with the proxy."""
    proxy = await _load_proxy_or_404(db, proxy_id)
    affected_sources = len(proxy.sources)
    summary = (
        f"proxy {proxy.name!r} deleted"
        if affected_sources == 0
        else f"proxy {proxy.name!r} deleted ({affected_sources} sources cascaded)"
    )
    await write_event(
        db,
        action="proxy.deleted",
        actor=admin,
        target_type="apk_proxy",
        target_id=proxy.id,
        summary=summary,
        payload={"name": proxy.name, "cascaded_sources": affected_sources},
        request=request,
    )
    await db.delete(proxy)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@admin_router.post("/{proxy_id}/refresh", response_model=ApkProxyRead)
async def refresh_proxy(
    proxy_id: uuid.UUID,
    db: DbSession,
    request: Request,
    admin: Annotated[User, Depends(get_current_admin)],
) -> ApkProxyRead:
    """Re-run the health probe + ``/sources`` fetch. Used by the admin
    UI's "Test connection" button. Doesn't write a separate audit row
    (idempotent + admin-only) but updates ``last_health_*`` and
    ``cached_sources_*``."""
    proxy = await _load_proxy_or_404(db, proxy_id)
    await _refresh_proxy_state(proxy)
    await db.flush()
    return _to_read(proxy)


# ============================================================================
# PER-APP — /apps/{app_id}/proxy-source
# ============================================================================


def _source_to_read(src: ApkProxySource) -> ApkProxySourceRead:
    return ApkProxySourceRead.model_validate(src)


async def _load_source_or_404(
    db,
    app_id: uuid.UUID,
    source_id: uuid.UUID,
) -> ApkProxySource:
    row = (
        await db.execute(
            select(ApkProxySource)
            .where(ApkProxySource.id == source_id)
            .where(ApkProxySource.app_id == app_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Proxy source not found",
        )
    return row


async def _load_app_for_management(db, app_id: uuid.UUID, user: User) -> App:
    """Resolve an app + assert the caller can manage it. Same gate the
    GitHub source endpoints use."""
    from app.services.app_permissions import assert_can_manage_app

    app = (
        await db.execute(select(App).where(App.id == app_id))
    ).scalar_one_or_none()
    if app is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App not found")
    await assert_can_manage_app(db, user, app)
    return app


@per_app_router.get("/{app_id}/proxy-source", response_model=list[ApkProxySourceRead])
async def list_proxy_sources(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> list[ApkProxySourceRead]:
    """Every proxy source bound to this app. An app may have several
    (e.g. F-Droid mirror + Patreon early-access) — one per provider.
    """
    await _load_app_for_management(db, app_id, user)
    rows = (
        await db.execute(
            select(ApkProxySource)
            .where(ApkProxySource.app_id == app_id)
            .order_by(ApkProxySource.created_at.asc())
        )
    ).scalars().all()
    return [_source_to_read(r) for r in rows]


@per_app_router.post(
    "/{app_id}/proxy-source",
    response_model=ApkProxySourceRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_proxy_source(
    app_id: uuid.UUID,
    payload: ApkProxySourceCreate,
    db: DbSession,
    request: Request,
    user: Annotated[User, Depends(get_current_uploader)],
) -> ApkProxySourceRead:
    """Attach a new proxy-driven release source to this app.

    ``provider`` MUST appear in the chosen proxy's cached
    ``/sources`` catalogue (we re-check so a stale frontend can't
    persist a typo). For OAuth providers, ``secrets`` is expected to
    carry ``{"credential_id": "<uuid>"}`` from the popup callback;
    for ``api_token`` / ``basic`` providers, the keys match the
    proxy's declared ``secret_fields``.
    """
    await _load_app_for_management(db, app_id, user)
    proxy = await _load_proxy_or_404(db, payload.proxy_id)
    if not proxy.enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That proxy is disabled. Re-enable it before binding sources.",
        )
    # Validate ``provider`` against the cached catalogue. A nicer 400
    # than letting the worker fail later with "proxy doesn't know that
    # provider id". An empty catalogue is treated as a hard error so a
    # curl-savvy caller can't bind a source against a proxy that has
    # never successfully answered ``/sources`` (no validation possible
    # = no source).
    catalogue = proxy.cached_sources_json or {}
    declared = {p.get("id") for p in catalogue.get("providers", []) if isinstance(p, dict)}
    if not declared:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "This proxy hasn't published a sources catalogue yet. "
                "Have an admin click Refresh on /admin/proxies and retry."
            ),
        )
    if payload.provider not in declared:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Provider {payload.provider!r} is not in this proxy's catalogue. "
                f"Refresh the proxy or pick one of: {sorted(declared)}."
            ),
        )
    src = ApkProxySource(
        app_id=app_id,
        proxy_id=proxy.id,
        provider=payload.provider,
        source_url=str(payload.source_url),
        secrets_encrypted=(
            fernet_encrypt(json.dumps(payload.secrets, sort_keys=True))
            if payload.secrets
            else None
        ),
        enabled=payload.enabled,
        created_by=user.id,
    )
    db.add(src)
    try:
        await db.flush()
    except Exception as exc:  # Unique (app_id, provider) violation
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"This app already has a source for provider {payload.provider!r}. "
                f"Edit that one instead."
            ),
        ) from exc
    await write_event(
        db,
        action="proxy_source.created",
        actor=user,
        target_type="apk_proxy_source",
        target_id=src.id,
        summary=(
            f"proxy source attached: provider={payload.provider} "
            f"url={payload.source_url}"
        ),
        payload={
            "proxy_id": str(proxy.id),
            "provider": payload.provider,
            "has_secrets": bool(payload.secrets),
            # NEVER persist the raw secret values to the audit log —
            # only the set of keys helps the operator debug without
            # leaking the OAuth credential.
            "secret_keys": sorted(payload.secrets.keys()) if payload.secrets else [],
        },
        request=request,
    )
    await db.flush()
    return _source_to_read(src)


@per_app_router.patch(
    "/{app_id}/proxy-source/{source_id}",
    response_model=ApkProxySourceRead,
)
async def update_proxy_source(
    app_id: uuid.UUID,
    source_id: uuid.UUID,
    payload: ApkProxySourceUpdate,
    db: DbSession,
    request: Request,
    user: Annotated[User, Depends(get_current_uploader)],
) -> ApkProxySourceRead:
    """Partial update. ``secrets={}`` clears them (the proxy will
    challenge with 401 on the next scan); ``secrets=None`` leaves
    them alone. ``enabled`` toggles the cron without losing the row."""
    await _load_app_for_management(db, app_id, user)
    src = await _load_source_or_404(db, app_id, source_id)
    changed: dict[str, object] = {}
    if payload.source_url is not None and str(payload.source_url) != src.source_url:
        changed["source_url"] = str(payload.source_url)
        src.source_url = str(payload.source_url)
    if payload.secrets is not None:
        if not payload.secrets:
            changed["secrets"] = "cleared"
            src.secrets_encrypted = None
        else:
            changed["secrets"] = sorted(payload.secrets.keys())
            src.secrets_encrypted = fernet_encrypt(
                json.dumps(payload.secrets, sort_keys=True)
            )
        # Reset the auth_required status so the next scan can recover
        # without an explicit cron nudge from the admin.
        if src.last_status == ApkProxySourceStatus.AUTH_REQUIRED:
            src.last_status = ApkProxySourceStatus.IDLE
            src.last_error = None
    if payload.enabled is not None and payload.enabled != src.enabled:
        changed["enabled"] = payload.enabled
        src.enabled = payload.enabled
    if not changed:
        return _source_to_read(src)
    await write_event(
        db,
        action="proxy_source.updated",
        actor=user,
        target_type="apk_proxy_source",
        target_id=src.id,
        summary=f"proxy source updated ({', '.join(changed.keys())})",
        payload={k: (v if k != "secrets" else None) for k, v in changed.items()},
        request=request,
    )
    await db.flush()
    return _source_to_read(src)


@per_app_router.post(
    "/{app_id}/proxy-source/{source_id}/scan",
    response_model=dict,
)
async def scan_proxy_source_now(
    app_id: uuid.UUID,
    source_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> dict:
    """Trigger a one-shot scan of this source via the arq worker.

    Returns immediately — the actual scan runs out-of-band and its
    outcome lands on the source row + audit log. The user polls the
    GET endpoint (or the /admin/jobs page) to see when it finishes.
    """
    from app.services.queue import enqueue_apk_proxy_source_scan

    await _load_app_for_management(db, app_id, user)
    src = await _load_source_or_404(db, app_id, source_id)
    if not src.enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Source is disabled. Toggle it on before scanning.",
        )
    ok = await enqueue_apk_proxy_source_scan(str(src.id))
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not enqueue the scan — Redis is unreachable.",
        )
    return {"queued": True, "source_id": str(src.id)}


@per_app_router.delete(
    "/{app_id}/proxy-source/{source_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_proxy_source(
    app_id: uuid.UUID,
    source_id: uuid.UUID,
    db: DbSession,
    request: Request,
    user: Annotated[User, Depends(get_current_uploader)],
) -> Response:
    """Unbind the source. The proxy keeps the OAuth credential (if any)
    until its own retention rules expire it — we don't have a back-
    channel to ask the proxy to revoke."""
    await _load_app_for_management(db, app_id, user)
    src = await _load_source_or_404(db, app_id, source_id)
    await write_event(
        db,
        action="proxy_source.deleted",
        actor=user,
        target_type="apk_proxy_source",
        target_id=src.id,
        summary=f"proxy source removed: provider={src.provider}",
        payload={"provider": src.provider, "proxy_id": str(src.proxy_id)},
        request=request,
    )
    await db.delete(src)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ============================================================================
# OAUTH CALLBACK — /auth/proxy-callback
# ============================================================================
#
# The flow the popup performs:
#
#   1. The frontend asks the backend for a one-time signed ``state``
#      (``POST /apps/{id}/proxy-source/oauth-begin``).
#   2. Frontend opens a popup at
#      ``<proxy_base>/auth/<provider>/begin?return_to=<fdroid>/api/v1/
#      auth/proxy-callback&state=<signed>``.
#   3. Proxy walks the OAuth dance with the IdP, mints a
#      ``credential_id``, redirects the popup back to ``/proxy-callback?
#      credential_id=<uuid>&state=<signed>``.
#   4. Our callback handler verifies the state HMAC + expiry, then
#      renders an HTML page that posts the ``{credential_id}`` to
#      ``window.opener`` via ``postMessage`` and closes itself.
#   5. The opener stores the credential_id in the source row via the
#      regular ``POST /apps/{id}/proxy-source`` endpoint.


_OAUTH_STATE_TTL_SECONDS = 600   # 10 minutes is plenty for a click + popup dance


def _oauth_state_key() -> bytes:
    """Per-purpose HMAC key derived from ``SECRET_KEY``. Same recipe as
    ``download_token._derived_key`` — keeps the OAuth state signature
    cryptographically independent from download tokens and JWTs."""
    return hmac.new(
        settings.secret_key.encode("utf-8"),
        b"fdroid-store|proxy-oauth-state",
        sha256,
    ).digest()


def _sign_oauth_state(
    *,
    user_id: uuid.UUID,
    proxy_id: uuid.UUID,
    provider: str,
    app_id: uuid.UUID | None,
) -> str:
    """Build a signed, time-bounded state token the popup will round-
    trip. Format: ``<v>.<user>.<proxy>.<provider>.<app|->.<exp>.<nonce>.<sig>``
    """
    exp = int(datetime.now(UTC).timestamp()) + _OAUTH_STATE_TTL_SECONDS
    nonce = _secrets.token_urlsafe(12)
    payload = (
        f"v1.{user_id}.{proxy_id}.{provider}.{app_id or '-'}.{exp}.{nonce}"
    )
    sig = hmac.new(_oauth_state_key(), payload.encode("utf-8"), sha256).hexdigest()[:32]
    return f"{payload}.{sig}"


def _verify_oauth_state(token: str) -> dict[str, object] | None:
    """Constant-time verification. Returns the parsed payload (sans
    signature) on success, ``None`` on any failure."""
    try:
        parts = token.split(".")
        if len(parts) != 8 or parts[0] != "v1":
            return None
        version, user_id, proxy_id, provider, app_id, exp_str, nonce, sig = parts
        exp = int(exp_str)
    except (ValueError, AttributeError):
        return None
    if exp < int(datetime.now(UTC).timestamp()):
        return None
    payload = ".".join(parts[:-1])
    expected = hmac.new(_oauth_state_key(), payload.encode("utf-8"), sha256).hexdigest()[:32]
    if not hmac.compare_digest(expected, sig):
        return None
    try:
        return {
            "user_id": uuid.UUID(user_id),
            "proxy_id": uuid.UUID(proxy_id),
            "provider": provider,
            "app_id": None if app_id == "-" else uuid.UUID(app_id),
            "nonce": nonce,
        }
    except ValueError:
        return None


@per_app_router.post(
    "/{app_id}/proxy-source/oauth-begin",
    response_model=dict,
)
async def begin_proxy_oauth(
    app_id: uuid.UUID,
    body: dict,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> dict:
    """Generate the popup URL the frontend should open for an OAuth
    provider on the chosen proxy.

    Body: ``{ "proxy_id": "<uuid>", "provider": "<id>" }``. The proxy
    + provider are validated against the cached catalogue so we don't
    redirect to a path that won't exist.
    """
    await _load_app_for_management(db, app_id, user)
    try:
        proxy_id = uuid.UUID(str(body.get("proxy_id")))
        provider = str(body.get("provider"))
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="proxy_id and provider are required",
        )
    proxy = await _load_proxy_or_404(db, proxy_id)
    catalogue = proxy.cached_sources_json or {}
    providers = catalogue.get("providers", []) if isinstance(catalogue, dict) else []
    descriptor = next(
        (p for p in providers if isinstance(p, dict) and p.get("id") == provider),
        None,
    )
    if descriptor is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Provider {provider!r} not found on proxy {proxy.name!r}",
        )
    if descriptor.get("auth_kind") != "oauth2":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Provider {provider!r} does not declare oauth2 (auth_kind={descriptor.get('auth_kind')!r})",
        )
    begin_path = (descriptor.get("auth_oauth") or {}).get("begin_path") or f"/auth/{provider}/begin"
    state = _sign_oauth_state(
        user_id=user.id, proxy_id=proxy.id, provider=provider, app_id=app_id
    )
    # The fdroid-store side of the callback. The proxy redirects the
    # popup here once the OAuth dance is done.
    return_to = f"{settings.public_api_url.rstrip('/')}/api/v1/auth/proxy-callback"
    popup_url = (
        f"{proxy.base_url.rstrip('/')}{begin_path}"
        f"?return_to={return_to}&state={state}"
    )
    return {"popup_url": popup_url, "state": state}


@auth_router.get("/proxy-callback", response_class=HTMLResponse)
async def proxy_oauth_callback(
    credential_id: str = Query(..., max_length=256),
    state: str = Query(..., max_length=512),
) -> HTMLResponse:
    """The popup lands here after the proxy finished the OAuth dance.

    Verifies the state HMAC, then renders a tiny HTML page that posts
    ``{credential_id, state, provider, proxy_id, app_id}`` to
    ``window.opener`` and closes itself. The opener (the SPA) listens
    on its ``message`` event and stores the credential via the normal
    ``POST /apps/{id}/proxy-source`` endpoint.

    Nothing is persisted server-side — the credential lives on the
    proxy, and the source row owns the reference. This keeps fdroid-
    store stateless for the OAuth half of the flow and lets the user
    abandon (just close the popup) without orphaning anything in our
    DB.
    """
    payload = _verify_oauth_state(state)
    if payload is None:
        return HTMLResponse(
            status_code=400,
            content=(
                "<!doctype html><html><body><p>Invalid or expired state token. "
                "Close this window and start over.</p></body></html>"
            ),
        )
    # JSON-stringified message — the opener parses it via
    # JSON.parse(event.data) or pattern-matches on ``type``.
    msg = json.dumps({
        "type": "proxy_oauth_done",
        "credential_id": credential_id,
        "state": state,
        "proxy_id": str(payload["proxy_id"]),
        "provider": payload["provider"],
        "app_id": str(payload["app_id"]) if payload["app_id"] else None,
    })
    # The exact origin we postMessage to is the SPA's. We pull it from
    # ``settings.public_app_url`` so a multi-tenant frontend can't be
    # tricked into receiving messages bound for someone else's tab.
    target_origin = settings.public_app_url.rstrip("/") or "*"
    # Inline JS — kept minimal. ``window.opener`` may be null when the
    # callback URL was opened directly (not in a popup); we render a
    # human-readable fallback in that case.
    html = f"""<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Authorisation complete</title></head>
<body style="font-family: system-ui; padding: 2rem; text-align: center;">
  <p>You may close this window.</p>
  <script>
    (function () {{
      var msg = {msg};
      var origin = {json.dumps(target_origin)};
      try {{
        if (window.opener) {{
          window.opener.postMessage(msg, origin);
        }}
      }} catch (e) {{ /* ignore */ }}
      setTimeout(function () {{ try {{ window.close(); }} catch (e) {{}} }}, 250);
    }})();
  </script>
</body>
</html>"""
    return HTMLResponse(content=html)
