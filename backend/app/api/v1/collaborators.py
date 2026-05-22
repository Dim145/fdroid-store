"""Owner-only management of app co-maintainers.

Routes are mounted under ``/apps/{app_id}/collaborators``. Add/remove is
restricted to the app owner (or an admin) — collaborators can manage the
listing but never escalate themselves into owners by adding more
collaborators.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select

from app.api.deps import DbSession, get_current_user, get_current_uploader
from app.models.app import App
from app.models.app_collaborator import AppCollaborator
from app.models.user import User
from app.schemas.app_collaborator import AppCollaboratorAdd, AppCollaboratorRead
from app.services.app_permissions import assert_owner_or_admin
from app.services.audit import write_event

router = APIRouter()


async def _load_app_or_404(db, app_id: uuid.UUID) -> App:
    app = (await db.execute(select(App).where(App.id == app_id))).scalar_one_or_none()
    if app is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App not found")
    return app


@router.get(
    "/{app_id}/collaborators",
    response_model=list[AppCollaboratorRead],
)
async def list_collaborators(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
) -> list[AppCollaboratorRead]:
    """List collaborators on an app. Visible to the owner, admins, and
    existing collaborators (so each co-maintainer can see who else is on
    the team)."""
    from app.services.app_permissions import can_manage_app

    app = await _load_app_or_404(db, app_id)
    if not await can_manage_app(db, user, app):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")

    rows = (
        await db.execute(
            select(AppCollaborator, User)
            .join(User, User.id == AppCollaborator.user_id)
            .where(AppCollaborator.app_id == app_id)
            .order_by(AppCollaborator.granted_at.desc())
        )
    ).all()
    return [
        AppCollaboratorRead(
            id=row.AppCollaborator.id,
            user_id=row.AppCollaborator.user_id,
            granted_at=row.AppCollaborator.granted_at,
            username=row.User.username,
            email=row.User.email,
            full_name=row.User.full_name,
        )
        for row in rows
    ]


@router.post(
    "/{app_id}/collaborators",
    response_model=AppCollaboratorRead,
    status_code=status.HTTP_201_CREATED,
)
async def add_collaborator(
    app_id: uuid.UUID,
    payload: AppCollaboratorAdd,
    db: DbSession,
    request: Request,
    actor: Annotated[User, Depends(get_current_uploader)],
) -> AppCollaboratorRead:
    """Owner-only: add a user as co-maintainer."""
    app = await _load_app_or_404(db, app_id)
    assert_owner_or_admin(actor, app)
    if not payload.username and not payload.email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide either username or email",
        )
    # Look the user up by whichever field was supplied. Username takes
    # precedence so a UI that asks for both can't accidentally email-resolve
    # the wrong account.
    if payload.username:
        target = (
            await db.execute(select(User).where(User.username == payload.username))
        ).scalar_one_or_none()
    else:
        target = (
            await db.execute(select(User).where(User.email == payload.email))
        ).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if target.id == app.owner_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The owner is already implicitly granted full rights",
        )
    # The collaborator must be able to actually push to /my-apps —
    # adding a plain ``user`` as collab would create the absurd state
    # of "co-maintainer of an app I can't open the editor for". Admin
    # must promote them to ``uploader`` first.
    if not target.can_upload:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "User does not have the uploader role. "
                "Ask an admin to promote them to uploader before adding them as a collaborator."
            ),
        )
    existing = (
        await db.execute(
            select(AppCollaborator).where(
                AppCollaborator.app_id == app_id,
                AppCollaborator.user_id == target.id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="User is already a collaborator",
        )

    row = AppCollaborator(
        app_id=app_id,
        user_id=target.id,
        granted_by=actor.id,
        granted_at=datetime.now(UTC),
    )
    db.add(row)
    await write_event(
        db,
        action="app.collaborator_added",
        actor=actor,
        target_type="app",
        target_id=app.id,
        summary=f"added {target.username} as collaborator on {app.package_name}",
        payload={"collaborator_id": str(target.id), "username": target.username},
        request=request,
    )
    await db.flush()
    return AppCollaboratorRead(
        id=row.id,
        user_id=target.id,
        granted_at=row.granted_at,
        username=target.username,
        email=target.email,
        full_name=target.full_name,
    )


@router.delete(
    "/{app_id}/collaborators/{collaborator_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    response_class=Response,
)
async def remove_collaborator(
    app_id: uuid.UUID,
    collaborator_id: uuid.UUID,
    db: DbSession,
    request: Request,
    actor: Annotated[User, Depends(get_current_uploader)],
) -> None:
    """Owner-only: revoke a collaborator. Co-maintainers can also leave
    themselves (a user can always DELETE their own collab row)."""
    app = await _load_app_or_404(db, app_id)
    row = (
        await db.execute(
            select(AppCollaborator).where(
                AppCollaborator.id == collaborator_id,
                AppCollaborator.app_id == app_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Collaborator not found")
    is_self_leave = row.user_id == actor.id
    if not is_self_leave:
        assert_owner_or_admin(actor, app)
    await write_event(
        db,
        action="app.collaborator_removed",
        actor=actor,
        target_type="app",
        target_id=app.id,
        summary=(
            f"left {app.package_name}"
            if is_self_leave
            else f"removed collaborator from {app.package_name}"
        ),
        payload={"collaborator_id": str(row.user_id), "self_leave": is_self_leave},
        request=request,
    )
    await db.delete(row)
    await db.flush()
