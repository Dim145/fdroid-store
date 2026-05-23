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

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession, get_current_admin
from app.core.logging import get_logger
from app.models.apk_proxy import (
    ApkProxy,
    ApkProxyHealthStatus,
    ApkProxySource,
)
from app.models.user import User
from app.schemas.apk_proxy import (
    ApkProxyCreate,
    ApkProxyRead,
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
from app.services.crypto import encrypt as fernet_encrypt

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
