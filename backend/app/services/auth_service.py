"""Business logic for authentication: login, refresh, OIDC linking."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.models.user import AuthProvider, User, UserRole


class AuthError(Exception):
    """Raised when an auth operation cannot complete (bad creds, disabled, ...)."""


def _token_pair_for(user: User) -> tuple[str, str]:
    extra = {"role": user.role.value, "username": user.username}
    return create_access_token(str(user.id), extra=extra), create_refresh_token(str(user.id))


async def authenticate_local(db: AsyncSession, email: str, password: str) -> tuple[User, str, str]:
    user = (
        await db.execute(select(User).where(User.email == email))
    ).scalar_one_or_none()
    if user is None or user.hashed_password is None:
        raise AuthError("Invalid credentials")
    if not user.is_active:
        raise AuthError("Account disabled")
    if not verify_password(password, user.hashed_password):
        raise AuthError("Invalid credentials")

    user.last_login_at = datetime.now(UTC)
    access, refresh = _token_pair_for(user)
    await db.flush()
    return user, access, refresh


async def signup_local(
    db: AsyncSession,
    *,
    email: str,
    username: str,
    password: str,
    full_name: str | None = None,
) -> tuple[User, str, str]:
    if not settings.allow_signup:
        raise AuthError("Signup is disabled")
    existing = (
        await db.execute(
            select(User).where((User.email == email) | (User.username == username))
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise AuthError("Email or username already taken")

    user = User(
        email=email,
        username=username,
        full_name=full_name,
        hashed_password=hash_password(password),
        role=UserRole.USER,
        auth_provider=AuthProvider.LOCAL,
        is_active=True,
        last_login_at=datetime.now(UTC),
    )
    db.add(user)
    await db.flush()
    access, refresh = _token_pair_for(user)
    return user, access, refresh


async def refresh_tokens(db: AsyncSession, refresh_token: str) -> tuple[User, str, str]:
    try:
        payload = decode_token(refresh_token)
    except Exception as exc:  # JWTError, ExpiredSignatureError, ...
        raise AuthError("Invalid refresh token") from exc
    if payload.get("type") != "refresh":
        raise AuthError("Not a refresh token")
    sub = payload.get("sub")
    if not sub:
        raise AuthError("Refresh token missing subject")
    try:
        user_id = uuid.UUID(sub)
    except ValueError as exc:
        raise AuthError("Invalid subject") from exc

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None or not user.is_active:
        raise AuthError("User not found or disabled")
    access, refresh = _token_pair_for(user)
    return user, access, refresh


async def link_or_create_oidc_user(
    db: AsyncSession,
    *,
    subject: str,
    email: str,
    username: str,
    full_name: str | None,
    is_admin: bool,
) -> tuple[User, str, str]:
    """Find or create a user from an OIDC ID-token. ``subject`` is the IdP's sub claim."""
    user = (
        await db.execute(select(User).where(User.oidc_subject == subject))
    ).scalar_one_or_none()

    if user is None:
        # No sub link yet — try to merge with a local account by email.
        user = (
            await db.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        if user is not None:
            user.oidc_subject = subject
            user.auth_provider = AuthProvider.OIDC
        else:
            # ensure username uniqueness; append digits if needed
            base_username = username
            attempt = base_username
            i = 1
            while (await db.execute(select(User).where(User.username == attempt))).scalar_one_or_none():
                attempt = f"{base_username}{i}"
                i += 1
            user = User(
                email=email,
                username=attempt,
                full_name=full_name,
                auth_provider=AuthProvider.OIDC,
                oidc_subject=subject,
                role=UserRole.ADMIN if is_admin else UserRole.USER,
                is_active=True,
            )
            db.add(user)

    user.last_login_at = datetime.now(UTC)
    # OIDC may promote/demote on each login if mapping is configured
    if is_admin and user.role != UserRole.ADMIN:
        user.role = UserRole.ADMIN
    await db.flush()
    access, refresh = _token_pair_for(user)
    return user, access, refresh
