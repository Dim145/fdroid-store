"""Public profile endpoints — read-only views of a user's published work.

The profile page (``/u/<username>``) lets visitors browse every PUBLIC +
PUBLISHED app an uploader has shipped. Private apps are deliberately
excluded: by definition, a private app is only visible to its owner.

To avoid the route doubling as a username-enumeration oracle (CWE-204),
we 404 on both "user doesn't exist" and "user exists but has no public
published app" with identical responses.
"""
from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession, require_browse_access
from app.models.app import App, AppStatus, AppVisibility
from app.models.user import User
from app.schemas.app import AppRead

router = APIRouter()


class PublicProfile(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    username: str
    full_name: str | None
    member_since: datetime
    apps: list[AppRead]


@router.get("/{username}/profile", response_model=PublicProfile)
async def get_public_profile(
    username: str,
    db: DbSession,
    caller: Annotated[User | None, Depends(require_browse_access)],
) -> PublicProfile:
    """Return an uploader's public profile + their PUBLIC published apps.

    The endpoint honours public_mode like the catalogue: anonymous callers
    are allowed when the repo is in public mode, otherwise rejected upstream
    by ``require_browse_access``. NSFW apps are filtered out unless the
    caller has opted in via ``show_nsfw``.
    """
    target = (
        await db.execute(select(User).where(User.username == username))
    ).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    apps_stmt = (
        select(App)
        .options(selectinload(App.categories), selectinload(App.apks))
        .where(
            App.owner_id == target.id,
            App.visibility == AppVisibility.PUBLIC,
            App.status == AppStatus.PUBLISHED,
        )
        .order_by(App.last_published_at.desc().nullslast(), App.name)
    )
    apps = list((await db.execute(apps_stmt)).scalars().unique().all())
    if not bool(caller and caller.show_nsfw):
        apps = [a for a in apps if not a.is_nsfw]
    if not apps:
        # Indistinguishable from "user doesn't exist" so the route can't be
        # used to probe which usernames are registered.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    return PublicProfile(
        username=target.username,
        full_name=target.full_name,
        member_since=target.created_at,
        apps=[AppRead.model_validate(a) for a in apps],
    )
