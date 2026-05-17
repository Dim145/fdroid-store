"""FastAPI dependencies for the API layer."""
from __future__ import annotations

import base64
import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import (
    JWTError,
    decode_token,
    parse_api_key,
    verify_api_key_secret,
)
from app.models.api_key import ApiKey
from app.models.user import User, UserRole

# --------------------------------------------------------------------------
# DB session
# --------------------------------------------------------------------------
DbSession = Annotated[AsyncSession, Depends(get_db)]


# --------------------------------------------------------------------------
# JWT bearer (for the frontend)
# --------------------------------------------------------------------------
async def _user_from_jwt(token: str, db: AsyncSession) -> User:
    try:
        payload = decode_token(token)
    except JWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc
    if payload.get("type") != "access":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not an access token")
    sub = payload.get("sub")
    try:
        user_id = uuid.UUID(sub)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bad subject") from exc
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


async def get_current_user(
    db: DbSession,
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    return await _user_from_jwt(token, db)


async def get_current_user_optional(
    db: DbSession,
    authorization: Annotated[str | None, Header()] = None,
) -> User | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    try:
        return await _user_from_jwt(authorization.split(" ", 1)[1].strip(), db)
    except HTTPException:
        return None


async def get_current_admin(
    user: Annotated[User, Depends(get_current_user)],
) -> User:
    if user.role != UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")
    return user


# --------------------------------------------------------------------------
# API-key auth (used by the F-Droid client over HTTP Basic)
# --------------------------------------------------------------------------
async def _api_key_from_secret(secret: str, db: AsyncSession) -> ApiKey | None:
    parts = parse_api_key(secret)
    if parts is None:
        return None
    prefix, secret_part = parts
    api_key = (await db.execute(select(ApiKey).where(ApiKey.prefix == prefix))).scalar_one_or_none()
    if api_key is None or not api_key.is_active:
        return None
    if not verify_api_key_secret(secret_part, api_key.hashed_secret):
        return None
    api_key.last_used_at = datetime.now(UTC)
    await db.flush()
    return api_key


async def get_api_key_from_basic_auth(
    db: DbSession,
    authorization: Annotated[str | None, Header()] = None,
) -> ApiKey | None:
    """Best-effort: returns the active ApiKey if the request carries Basic auth.

    F-Droid clients send the API key as the password in Basic auth. The
    username slot is ignored on our side.
    """
    if not authorization:
        return None
    scheme, _, encoded = authorization.partition(" ")
    if scheme.lower() != "basic" or not encoded:
        return None
    try:
        decoded = base64.b64decode(encoded).decode("utf-8")
    except Exception:  # noqa: BLE001
        return None
    if ":" not in decoded:
        return None
    _, password = decoded.split(":", 1)
    return await _api_key_from_secret(password, db)


async def get_principal(
    db: DbSession,
    user_opt: Annotated[User | None, Depends(get_current_user_optional)],
    api_key: Annotated[ApiKey | None, Depends(get_api_key_from_basic_auth)],
) -> tuple[User | None, ApiKey | None]:
    """Return either an authenticated user or an active API key (or neither)."""
    if user_opt is not None:
        return user_opt, None
    if api_key is not None:
        return api_key.user, api_key
    return None, None
