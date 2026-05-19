"""Audit-log write helper.

The helper is intentionally tiny so route code stays readable. Every
mutating endpoint that matters (admin actions, role changes, deletions,
visibility flips, …) calls ``write_event(...)`` with a short ``action``
slug and a payload describing the change.

The write is best-effort: if the DB session is in an unrecoverable state
the audit row is dropped — we'd rather lose an audit line than break the
user-visible action that produced it. Persistent failures should be
caught by structlog at log level WARNING.
"""
from __future__ import annotations

import hashlib
import uuid
from typing import Any

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.models.audit_log import AuditLog
from app.models.user import User

log = get_logger(__name__)


def _hash_ip(ip: str | None) -> str | None:
    if not ip:
        return None
    return hashlib.sha256(ip.encode("utf-8")).hexdigest()


def _client_ip(request: Request | None) -> str | None:
    if request is None:
        return None
    # Behind the bundled nginx, the real client IP arrives in
    # X-Forwarded-For. We trust the first hop only — anything else is
    # forwardable by the client itself.
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",", 1)[0].strip() or None
    return request.client.host if request.client else None


def _user_agent(request: Request | None) -> str | None:
    if request is None:
        return None
    ua = request.headers.get("user-agent")
    if not ua:
        return None
    return ua[:255]


async def write_event(
    db: AsyncSession,
    *,
    action: str,
    actor: User | None,
    target_type: str | None = None,
    target_id: str | uuid.UUID | None = None,
    summary: str | None = None,
    payload: dict[str, Any] | None = None,
    request: Request | None = None,
) -> None:
    """Insert an audit row. The caller is responsible for committing.

    ``action`` is a short slug like ``app.deleted`` or
    ``user.role_changed``; the admin UI groups by prefix. ``payload`` is a
    free-form JSONB blob — keep it small and unstructured (no model dumps,
    no secrets).
    """
    try:
        row = AuditLog(
            actor_id=actor.id if actor else None,
            action=action,
            target_type=target_type,
            target_id=str(target_id) if target_id is not None else None,
            summary=summary,
            payload=payload,
            ip_hash=_hash_ip(_client_ip(request)),
            user_agent=_user_agent(request),
        )
        db.add(row)
    except Exception as exc:  # noqa: BLE001
        # Never let an audit-write failure abort the action it's logging.
        log.warning("audit write skipped", action=action, error=str(exc))
