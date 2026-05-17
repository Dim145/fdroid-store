from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import desc, select

from app.api.deps import DbSession, get_current_user
from app.core.security import hash_password, verify_password
from app.models.audit import DownloadEvent
from app.models.user import User
from app.schemas.app import AppRead
from app.schemas.auth import ChangePasswordRequest
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
    await db.flush()
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
    await db.flush()


@router.get("/downloads")
async def my_download_history(
    user: Annotated[User, Depends(get_current_user)],
    db: DbSession,
    limit: int = 100,
    offset: int = 0,
) -> dict:
    stmt = (
        select(DownloadEvent)
        .where(DownloadEvent.user_id == user.id)
        .order_by(desc(DownloadEvent.created_at))
        .limit(min(limit, 500))
        .offset(offset)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return {
        "items": [
            {
                "id": str(r.id),
                "apk_id": str(r.apk_id),
                "app_id": str(r.app_id),
                "created_at": r.created_at.isoformat(),
                "bytes_served": r.bytes_served,
            }
            for r in rows
        ]
    }


@router.get("/apps", response_model=list[AppRead])
async def my_apps(
    user: Annotated[User, Depends(get_current_user)],
    db: DbSession,
) -> list[AppRead]:
    from sqlalchemy.orm import selectinload

    from app.models.app import App

    stmt = (
        select(App)
        .options(selectinload(App.categories), selectinload(App.apks))
        .where(App.owner_id == user.id)
        .order_by(App.created_at.desc())
    )
    rows = (await db.execute(stmt)).scalars().unique().all()
    return [AppRead.model_validate(a) for a in rows]
