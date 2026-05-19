"""Centralised access checks for ``App`` mutations.

Two helpers:
  * :func:`can_manage_app` — true when the user is the owner, an active
    co-maintainer, or an admin. Used at every "edit listing / upload APK
    / change screenshots" entry point.
  * :func:`assert_can_manage_app` — convenience wrapper that raises HTTP
    403 when the check fails.

Owner-only operations (delete app, change visibility, transfer ownership,
add/remove collaborators) deliberately bypass this helper and check
``app.owner_id == user.id`` directly — co-maintainers should not be able
to escalate themselves into owner-equivalents.
"""
from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.app import App
from app.models.app_collaborator import AppCollaborator
from app.models.user import User, UserRole


async def can_manage_app(db: AsyncSession, user: User, app: App) -> bool:
    """Return True when ``user`` can edit the listing or upload APKs.

    Admins always pass. The owner always passes. Otherwise we look up an
    ``AppCollaborator`` row matching the (app, user) pair.
    """
    if user.role == UserRole.ADMIN:
        return True
    if app.owner_id == user.id:
        return True
    collab = (
        await db.execute(
            select(AppCollaborator).where(
                AppCollaborator.app_id == app.id,
                AppCollaborator.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    return collab is not None


async def assert_can_manage_app(db: AsyncSession, user: User, app: App) -> None:
    if not await can_manage_app(db, user, app):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


def is_owner_or_admin(user: User, app: App) -> bool:
    """Synchronous check for owner-only operations (no collaborator escape
    hatch). Used in /apps/{id} DELETE, collaborator management, and
    visibility flips."""
    return user.role == UserRole.ADMIN or app.owner_id == user.id


def assert_owner_or_admin(user: User, app: App) -> None:
    if not is_owner_or_admin(user, app):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the app owner (or an admin) can do this",
        )
