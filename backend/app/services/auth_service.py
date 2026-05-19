"""Business logic for authentication: login, refresh, OIDC linking."""
from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
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
from app.models.refresh_token import RefreshToken
from app.models.repo_config import RepoConfig
from app.models.user import AuthProvider, User, UserRole


class AuthError(Exception):
    """Raised when an auth operation cannot complete (bad creds, disabled, ...)."""


# Precomputed argon2 hash of a random string. Used in ``authenticate_local``
# to keep the "user doesn't exist" branch as slow as a real verify.
_DUMMY_PASSWORD_HASH = hash_password("this-is-a-fixed-dummy-string-for-timing-equalisation")


async def _get_registration_policy(db: AsyncSession) -> str:
    """Returns the active registration policy. Falls back to "public" when
    the repo config row hasn't been seeded yet — the bootstrap creates it
    immediately, but defaulting open here avoids a chicken-and-egg surprise."""
    config = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
    if config is None:
        return "public"
    return config.registration_policy


async def _issue_token_pair(
    db: AsyncSession,
    user: User,
    *,
    parent_jti: str | None = None,
    request_meta: tuple[str | None, str | None] | None = None,
) -> tuple[str, str]:
    """Mint a new (access, refresh) pair and persist the refresh-token row.

    ``parent_jti`` is the jti of the refresh token this pair replaces (set
    on rotation, None on a fresh login). The DB row is the source of
    truth: only a row whose ``used_at IS NULL`` and ``revoked_at IS NULL``
    is still redeemable.

    A login (``parent_jti is None``) also creates a ``UserSession`` row;
    a rotation updates the existing session's ``jti`` and ``last_seen_at``
    so the account page shows fresh activity timestamps without inflating
    the session count.
    """
    from app.models.user_session import UserSession

    extra = {"role": user.role.value, "username": user.username}
    access = create_access_token(str(user.id), extra=extra)
    refresh_jti = secrets.token_urlsafe(16)
    refresh = create_refresh_token(str(user.id), jti=refresh_jti)
    db.add(
        RefreshToken(
            jti=refresh_jti,
            user_id=user.id,
            parent_jti=parent_jti,
            expires_at=datetime.now(UTC) + timedelta(days=settings.refresh_token_expire_days),
        )
    )

    ip_hash, user_agent = request_meta or (None, None)
    now = datetime.now(UTC)
    if parent_jti is None:
        # Fresh login → new session row.
        db.add(
            UserSession(
                user_id=user.id,
                jti=refresh_jti,
                ip_hash=ip_hash,
                user_agent=user_agent,
                last_seen_at=now,
            )
        )
    else:
        # Rotation → advance the existing session pointer. If we can't find
        # the row (manual revoke, schema migration, etc.) we silently create
        # a fresh one rather than dropping the rotation.
        session = (
            await db.execute(
                select(UserSession).where(UserSession.jti == parent_jti)
            )
        ).scalar_one_or_none()
        if session is not None:
            session.jti = refresh_jti
            session.last_seen_at = now
        else:
            db.add(
                UserSession(
                    user_id=user.id,
                    jti=refresh_jti,
                    ip_hash=ip_hash,
                    user_agent=user_agent,
                    last_seen_at=now,
                )
            )

    await db.flush()
    return access, refresh


async def _revoke_refresh_chain(db: AsyncSession, jti: str) -> None:
    """Walk the parent/child chain of a refresh-token row and mark every
    descendant + ancestor revoked. Called when re-use of a consumed token
    is detected — that's the signal that one of the two parties has been
    compromised, and we don't know which. Burning the whole family logs
    out both."""
    # Walk forward: any row whose ``parent_jti`` is in our set joins the
    # family. Iterate until stable.
    family: set[str] = {jti}
    while True:
        rows = (
            await db.execute(
                select(RefreshToken.jti).where(RefreshToken.parent_jti.in_(family))
            )
        ).scalars().all()
        new = set(rows) - family
        if not new:
            break
        family |= new
    # Also walk backward from the initial jti.
    cur = jti
    while True:
        row = (
            await db.execute(select(RefreshToken).where(RefreshToken.jti == cur))
        ).scalar_one_or_none()
        if row is None or row.parent_jti is None:
            break
        family.add(row.parent_jti)
        cur = row.parent_jti
    now = datetime.now(UTC)
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.jti.in_(family), RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )


async def authenticate_local(
    db: AsyncSession,
    email: str,
    password: str,
    *,
    request_meta: tuple[str | None, str | None] | None = None,
) -> tuple[User, str, str]:
    user = (
        await db.execute(select(User).where(User.email == email))
    ).scalar_one_or_none()
    if user is None or user.hashed_password is None:
        # Burn an argon2 verify against a known-bad hash so the
        # "user-doesn't-exist" branch takes the same wall-clock as the
        # "user-exists-wrong-password" branch — closes the timing oracle
        # an attacker would use to enumerate registered emails (CWE-208).
        verify_password(password, _DUMMY_PASSWORD_HASH)
        raise AuthError("Invalid credentials")
    if not user.is_active:
        raise AuthError("Account disabled")
    if not verify_password(password, user.hashed_password):
        raise AuthError("Invalid credentials")

    user.last_login_at = datetime.now(UTC)
    access, refresh = await _issue_token_pair(db, user, request_meta=request_meta)
    return user, access, refresh


async def signup_local(
    db: AsyncSession,
    *,
    email: str,
    username: str,
    password: str,
    full_name: str | None = None,
    invite_code: str | None = None,
    request_meta: tuple[str | None, str | None] | None = None,
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
        # Conditional UPDATE so two concurrent signups racing on the same
        # code can't both burn it: only the first one whose ``used_at IS
        # NULL`` claim still holds gets to claim it. ``rowcount`` is 0 if
        # someone else consumed it in the meantime.
        now = datetime.now(UTC)
        result = await db.execute(
            update(InviteCode)
            .where(InviteCode.id == invite.id, InviteCode.used_at.is_(None))
            .values(used_at=now, used_by_user_id=user.id)
        )
        if result.rowcount == 0:
            raise AuthError("Invite code has already been used or has expired")
        await db.flush()
    access, refresh = await _issue_token_pair(db, user, request_meta=request_meta)
    return user, access, refresh


async def refresh_tokens(
    db: AsyncSession,
    refresh_token: str,
    *,
    request_meta: tuple[str | None, str | None] | None = None,
) -> tuple[User, str, str]:
    """Exchange a refresh token for a fresh access + refresh pair.

    Implements rotation + reuse detection per RFC 9700 §2.2.2:
      * Each refresh token is single-use. The DB row tracks ``used_at``.
      * Successful redemption marks the consumed row used and mints a
        replacement whose ``parent_jti`` points back at it.
      * Presenting an already-consumed (or revoked) refresh token revokes
        every member of the chain — the legitimate user is logged out, but
        so is whoever was holding the leaked copy.
      * Password change (see ``users.password_changed_at``) and admin
        disable proactively revoke every outstanding refresh row.
    """
    try:
        payload = decode_token(refresh_token)
    except Exception as exc:  # JWTError, ExpiredSignatureError, ...
        raise AuthError("Invalid refresh token") from exc
    if payload.get("type") != "refresh":
        raise AuthError("Not a refresh token")
    sub = payload.get("sub")
    jti = payload.get("jti")
    iat = payload.get("iat")
    if not sub or not jti:
        raise AuthError("Refresh token missing claims")
    try:
        user_id = uuid.UUID(sub)
    except ValueError as exc:
        raise AuthError("Invalid subject") from exc

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None or not user.is_active:
        raise AuthError("User not found or disabled")

    # C5: token issued before the last password change is dead.
    if user.password_changed_at is not None and iat is not None:
        token_iat = datetime.fromtimestamp(int(iat), tz=UTC)
        if token_iat < user.password_changed_at:
            raise AuthError("Refresh token invalidated by a password change")

    row = (
        await db.execute(select(RefreshToken).where(RefreshToken.jti == jti))
    ).scalar_one_or_none()
    if row is None:
        # Unknown jti either means forged (different secret) or already
        # purged. Treat as invalid.
        raise AuthError("Refresh token not recognised")
    if row.revoked_at is not None:
        raise AuthError("Refresh token revoked")
    if row.used_at is not None:
        # Re-use detected — burn the whole family. ``get_db`` would roll
        # back the revoke if we just raised the AuthError, so we commit
        # the family-revoke explicitly first.
        await _revoke_refresh_chain(db, jti)
        await db.commit()
        raise AuthError("Refresh token re-use detected; session revoked")

    # Atomic consume: only the first racing claim wins.
    consume = await db.execute(
        update(RefreshToken)
        .where(RefreshToken.jti == jti, RefreshToken.used_at.is_(None))
        .values(used_at=datetime.now(UTC))
    )
    if consume.rowcount == 0:
        await _revoke_refresh_chain(db, jti)
        await db.commit()
        raise AuthError("Refresh token re-use detected; session revoked")

    access, refresh = await _issue_token_pair(
        db, user, parent_jti=jti, request_meta=request_meta
    )
    return user, access, refresh


async def revoke_all_refresh_tokens(db: AsyncSession, user_id: uuid.UUID) -> None:
    """Mark every outstanding refresh token of ``user_id`` revoked.

    Called when the password changes (or an admin disables the account) so
    a leaked refresh token stops working before its 30-day expiry. Also
    revokes the matching ``UserSession`` rows so the account page reflects
    the new state.
    """
    from app.models.user_session import UserSession

    now = datetime.now(UTC)
    await db.execute(
        update(RefreshToken)
        .where(
            RefreshToken.user_id == user_id,
            RefreshToken.revoked_at.is_(None),
            RefreshToken.used_at.is_(None),
        )
        .values(revoked_at=now)
    )
    await db.execute(
        update(UserSession)
        .where(
            UserSession.user_id == user_id,
            UserSession.revoked_at.is_(None),
        )
        .values(revoked_at=now)
    )


async def link_or_create_oidc_user(
    db: AsyncSession,
    *,
    subject: str,
    email: str,
    username: str,
    full_name: str | None,
    is_admin: bool,
    invite_code: str | None = None,
    request_meta: tuple[str | None, str | None] | None = None,
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
    # OIDC promote/demote — mirror the IdP claim symmetrically. The previous
    # promote-only behaviour let an admin user keep ``ADMIN`` indefinitely
    # after the IdP removed them from the admin group. We only demote
    # OIDC-managed accounts (``auth_provider == OIDC``) so a locally-created
    # admin who happens to log in via OIDC doesn't lose their role just
    # because the IdP claim isn't set for them.
    if user.auth_provider == AuthProvider.OIDC:
        user.role = UserRole.ADMIN if is_admin else UserRole.USER
    elif is_admin and user.role != UserRole.ADMIN:
        user.role = UserRole.ADMIN
    await db.flush()
    if is_new_account and invite is not None:
        invite.used_at = datetime.now(UTC)
        invite.used_by_user_id = user.id
        await db.flush()
    access, refresh = await _issue_token_pair(db, user, request_meta=request_meta)
    return user, access, refresh
