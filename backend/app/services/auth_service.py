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
from app.models.invite_code import InviteCode
from app.models.repo_config import RepoConfig
from app.models.user import AuthProvider, User, UserRole


class AuthError(Exception):
    """Raised when an auth operation cannot complete (bad creds, disabled, ...)."""


async def _get_registration_policy(db: AsyncSession) -> str:
    """Returns the active registration policy. Falls back to "public" when
    the repo config row hasn't been seeded yet — the bootstrap creates it
    immediately, but defaulting open here avoids a chicken-and-egg surprise."""
    config = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
    if config is None:
        return "public"
    return config.registration_policy


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
    invite_code: str | None = None,
) -> tuple[User, str, str]:
    # The env-level allow_signup is the master switch — if an operator pinned
    # it off, no DB policy can override that.
    if not settings.allow_signup:
        raise AuthError("Signup is disabled")

    policy = await _get_registration_policy(db)
    if policy == "closed":
        raise AuthError("Signup is disabled")
    if policy == "invite" and not invite_code:
        raise AuthError("An invite code is required")

    existing = (
        await db.execute(
            select(User).where((User.email == email) | (User.username == username))
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise AuthError("Email or username already taken")

    # Resolve the invite first so we don't half-create a user only to discover
    # the code was bad. We re-attach the user.id below once SQLAlchemy assigns it.
    invite: InviteCode | None = None
    if policy == "invite":
        assert invite_code is not None
        invite = (
            await db.execute(select(InviteCode).where(InviteCode.code == invite_code))
        ).scalar_one_or_none()
        if invite is None:
            raise AuthError("Invalid invite code")
        if not invite.is_usable:
            raise AuthError("Invite code has already been used or has expired")

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
    if invite is not None:
        invite.used_at = datetime.now(UTC)
        invite.used_by_user_id = user.id
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
    invite_code: str | None = None,
) -> tuple[User, str, str]:
    """Find or create a user from an OIDC ID-token. ``subject`` is the IdP's sub claim.

    Existing users (matched by sub or by email) always log in regardless of
    the registration policy — closing signup must never lock current users
    out of their account. The policy only gates the new-user branch:
      * "closed" → reject
      * "invite" → require a valid invite code (consumed on success)
      * "public" → free signup, as before
    """
    user = (
        await db.execute(select(User).where(User.oidc_subject == subject))
    ).scalar_one_or_none()

    is_new_account = False
    invite: InviteCode | None = None
    if user is None:
        # No sub link yet — try to merge with a local account by email.
        user = (
            await db.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        if user is not None:
            user.oidc_subject = subject
            user.auth_provider = AuthProvider.OIDC
        else:
            # Brand-new account — apply the registration policy.
            policy = await _get_registration_policy(db)
            if policy == "closed":
                raise AuthError(
                    "Signup is closed on this repo. Ask an admin to create an account for you."
                )
            if policy == "invite":
                if not invite_code:
                    raise AuthError(
                        "An invite code is required to create an account via SSO."
                    )
                invite = (
                    await db.execute(
                        select(InviteCode).where(InviteCode.code == invite_code)
                    )
                ).scalar_one_or_none()
                if invite is None:
                    raise AuthError("Invalid invite code")
                if not invite.is_usable:
                    raise AuthError(
                        "Invite code has already been used or has expired"
                    )
            is_new_account = True

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
    if is_new_account and invite is not None:
        invite.used_at = datetime.now(UTC)
        invite.used_by_user_id = user.id
        await db.flush()
    access, refresh = _token_pair_for(user)
    return user, access, refresh
