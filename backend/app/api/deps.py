"""FastAPI dependencies for the API layer."""
from __future__ import annotations

import base64
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import (
    DEPLOY_TOKEN_PROTO,
    JWTError,
    decode_token,
    parse_api_key,
    parse_deploy_token,
    verify_api_key_secret,
    verify_deploy_token_secret,
)
from app.models.api_key import ApiKey
from app.models.deploy_token import DeployToken
from app.models.repo_config import RepoConfig
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
    # C5: tokens minted before the last password change are dead. ``iat`` is
    # always present (set in _create_token). If it isn't, the token was
    # crafted against an old format we don't trust either.
    iat = payload.get("iat")
    if user.password_changed_at is not None:
        if iat is None or datetime.fromtimestamp(int(iat), tz=UTC) < user.password_changed_at:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token invalidated by a password change",
            )
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
    # Rate-limit ``last_used_at`` writes to one per minute per key. F-Droid
    # clients can fire a handful of requests in quick succession while
    # syncing the index + downloading APKs; without throttling each one
    # forces a DB write on the same row and the second-to-arrive request
    # waits on the first's transaction.
    now = datetime.now(UTC)
    if api_key.last_used_at is None or (now - api_key.last_used_at) >= timedelta(minutes=1):
        api_key.last_used_at = now
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


# --------------------------------------------------------------------------
# Public-mode access gating
# --------------------------------------------------------------------------
async def is_public_mode(db: AsyncSession) -> bool:
    """Returns whether the repo is currently in public mode. Falls back to
    ``True`` if the config row doesn't exist yet (initial bootstrap)."""
    config = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
    return True if config is None else config.public_mode


# Backwards-compatible alias kept for any internal callers still using the
# underscore-prefixed name.
_public_mode = is_public_mode


async def _deploy_token_user_for_app(
    raw: str,
    app_id: uuid.UUID,
    db: AsyncSession,
) -> User | None:
    """Resolve a deploy token to the user it should impersonate for an
    upload to ``app_id``. Returns ``None`` if the token is invalid,
    revoked, or doesn't match this app. Caller raises 401 on None."""
    parts = parse_deploy_token(raw)
    if parts is None:
        return None
    prefix, secret_part = parts
    token = (
        await db.execute(select(DeployToken).where(DeployToken.prefix == prefix))
    ).scalar_one_or_none()
    if token is None or not token.is_active:
        return None
    if token.app_id != app_id:
        # Hard-fail: a deploy token from app A must never authenticate
        # an upload to app B even if the user knows both UUIDs.
        return None
    if not verify_deploy_token_secret(secret_part, token.hashed_secret):
        return None
    # Refresh ``last_used_at`` (rate-limited to once per minute, same as
    # the user API-key path).
    now = datetime.now(UTC)
    if token.last_used_at is None or (now - token.last_used_at) >= timedelta(minutes=1):
        token.last_used_at = now
        await db.flush()
    if token.created_by is None:
        # Token's creator was deleted — refuse rather than orphan-attribute.
        return None
    return (
        await db.execute(select(User).where(User.id == token.created_by))
    ).scalar_one_or_none()


async def get_uploader_for_app(
    app_id: uuid.UUID,
    db: DbSession,
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    """Auth dependency for the per-app APK upload endpoint.

    Accepts either:
      * a regular ``Bearer <jwt>`` (interactive web flow), or
      * a ``Bearer fdci_<prefix>_<secret>`` deploy token scoped to this
        exact app (CI flow).

    The deploy-token path returns the token's ``created_by`` user so
    downstream quota + audit machinery attributes the upload to the
    human that owns the credential, not a synthetic CI identity.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token",
        )
    token = authorization.split(" ", 1)[1].strip()
    # Route by the well-known protocol prefix so we never accidentally
    # try a JWT decode on a deploy token (which would slot it as a
    # generic invalid JWT 401 and hide the real failure mode).
    if token.startswith(f"{DEPLOY_TOKEN_PROTO}_"):
        user = await _deploy_token_user_for_app(token, app_id, db)
        if user is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or revoked deploy token for this app",
            )
        return user
    return await _user_from_jwt(token, db)


async def require_browse_access(
    db: DbSession,
    user_opt: Annotated[User | None, Depends(get_current_user_optional)],
) -> User | None:
    """Used by web-API routes that were anonymous-friendly. When the admin
    flips public_mode off, anonymous callers are rejected; authenticated
    users still pass through and downstream visibility rules apply as before.
    """
    if user_opt is not None:
        return user_opt
    if not await _public_mode(db):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )
    return None


async def require_repo_access(
    db: DbSession,
    api_key: Annotated[ApiKey | None, Depends(get_api_key_from_basic_auth)],
) -> ApiKey | None:
    """Counterpart to ``require_browse_access`` for the F-Droid client path.
    When public_mode is off we ask the client to present credentials with the
    Basic-auth challenge it knows how to handle."""
    if api_key is not None:
        return api_key
    if not await _public_mode(db):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": 'Basic realm="fdroid-store"'},
        )
    return None
