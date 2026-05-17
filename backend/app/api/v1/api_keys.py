from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select

from app.api.deps import DbSession, get_current_user
from app.core.security import generate_api_key
from app.models.api_key import ApiKey
from app.models.user import User
from app.schemas.api_key import ApiKeyCreate, ApiKeyCreated, ApiKeyRead

router = APIRouter()


@router.get("", response_model=list[ApiKeyRead])
async def list_api_keys(
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
) -> list[ApiKeyRead]:
    rows = (
        await db.execute(
            select(ApiKey).where(ApiKey.user_id == user.id).order_by(ApiKey.created_at.desc())
        )
    ).scalars().all()
    return [ApiKeyRead.model_validate(r) for r in rows]


@router.post("", response_model=ApiKeyCreated, status_code=status.HTTP_201_CREATED)
async def create_api_key(
    payload: ApiKeyCreate,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
) -> ApiKeyCreated:
    full, prefix, hashed = generate_api_key()
    expires_at = (
        datetime.now(UTC) + timedelta(days=payload.expires_in_days)
        if payload.expires_in_days
        else None
    )
    key = ApiKey(
        name=payload.name,
        prefix=prefix,
        hashed_secret=hashed,
        user_id=user.id,
        can_download_private=payload.can_download_private,
        can_manage_apps=payload.can_manage_apps,
        expires_at=expires_at,
    )
    db.add(key)
    await db.flush()
    return ApiKeyCreated(
        **ApiKeyRead.model_validate(key).model_dump(),
        full_key=full,
    )


@router.delete("/{api_key_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None, response_class=Response)
async def revoke_api_key(
    api_key_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
) -> None:
    key = (
        await db.execute(
            select(ApiKey).where(ApiKey.id == api_key_id, ApiKey.user_id == user.id)
        )
    ).scalar_one_or_none()
    if key is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="API key not found")
    if key.revoked_at is None:
        key.revoked_at = datetime.now(UTC)
    await db.flush()
