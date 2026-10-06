from __future__ import annotations

import hashlib
import hmac
import logging
import re
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import quote, urlsplit

import jwt as _jwt
from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import DbSession
from app.core.client_ip import client_ip, hash_ip
from app.core.config import settings
from app.core.one_time import claim_once
from app.core.rate_limit import limiter
from app.core.security import create_mfa_challenge_token, decode_token
from app.models.repo_config import RepoConfig
from app.models.user import User, UserRole
from app.schemas.auth import (
    AuthMethodsInfo,
    EnrollmentRequired,
    LoginRequest,
    MfaChallenge,
    MfaVerifyRequest,
    RefreshRequest,
    SignupRequest,
    TokenPair,
)
from app.services.auth_service import (
    AuthError,
    issue_tokens_for_user,
    link_or_create_oidc_user,
    refresh_tokens,
    signup_local,
    verify_local_credentials,
)
from app.services.oidc_service import claim_indicates_admin, get_oauth
from app.services.totp import is_enrolled
from app.services.totp import verify_login as totp_verify_login
from app.services.webauthn import mint_enrollment_token

logger = logging.getLogger(__name__)

router = APIRouter()

# Session key used to carry an invite code across the OIDC redirect.
# Authlib already uses ``request.session`` for its own state, so we're just
# tucking one extra value alongside it.
_OIDC_INVITE_SESSION_KEY = "oidc_invite_code"
# Hash of the nonce the SPA generated before starting SSO. The callback
# binds the one-time exchange code to it, so only the browser that started
# the flow can redeem it (a crafted link can't sign a victim into someone
# else's account).
_OIDC_BIND_SESSION_KEY = "oidc_bind"
_OIDC_BIND_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_OIDC_CODE_TYPE = "oidc_exchange"
_OIDC_CODE_TTL = timedelta(minutes=2)


def _oidc_error(code: str) -> RedirectResponse:
    """Back to /login with a stable error code the SPA maps to a message —
    never free text an attacker could make the login page display."""
    return RedirectResponse(
        url=f"{settings.public_app_url.rstrip('/')}/login?oidc_error={quote(code)}",
        status_code=status.HTTP_302_FOUND,
    )


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}".lower() if parts.scheme and parts.netloc else ""


def _nonce_hash(nonce: str) -> str:
    return hashlib.sha256(nonce.encode("utf-8")).hexdigest()


@router.get("/methods", response_model=AuthMethodsInfo)
async def auth_methods(db: DbSession) -> AuthMethodsInfo:
    """Tells the frontend which login flows are enabled and the repo's current
    access posture (public mode + registration policy). The repo config row is
    seeded at bootstrap so we treat its absence as "use safe defaults" rather
    than a hard error."""
    config = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
    public_mode = config.public_mode if config else True
    policy = config.registration_policy if config else "public"
    # In closed mode we suppress the signup CTA even when the env-level
    # allow_signup is on, so the frontend stops advertising self-serve.
    effective_allow_signup = settings.allow_signup and policy != "closed"
    return AuthMethodsInfo(
        local=settings.local_auth_enabled,
        oidc=settings.oidc_enabled,
        allow_signup=effective_allow_signup,
        oidc_login_url=f"{settings.public_api_url}/api/v1/auth/oidc/login" if settings.oidc_enabled else None,
        public_mode=public_mode,
        registration_policy=policy,  # type: ignore[arg-type]
    )


def _pair(access: str, refresh: str) -> TokenPair:
    return TokenPair(
        access_token=access,
        refresh_token=refresh,
        expires_in=settings.access_token_expire_minutes * 60,
    )


def _request_meta(request: Request) -> tuple[str | None, str | None]:
    """(ip fingerprint, user agent) for the session row — the raw address
    is never persisted."""
    ua = request.headers.get("user-agent")
    return hash_ip(client_ip(request)), (ua[:255] if ua else None)


@router.post("/login")
@limiter.limit("5/minute")
async def login(request: Request, payload: LoginRequest, db: DbSession):
    """Password step. Returns either a ``TokenPair`` (no MFA) or an
    ``MfaChallenge`` the client passes to ``/auth/login/mfa`` alongside
    the user's 6-digit code (or recovery code).

    The MFA gate fires when:
      * the user has confirmed TOTP enrolment, OR
      * the user is an admin and ``RepoConfig.require_admin_2fa`` is on.

    An admin with no second factor at all under that policy gets an
    ``EnrollmentRequired`` instead: registering a passkey completes the
    login.
    """
    if not settings.local_auth_enabled:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Local auth disabled")
    try:
        user = await verify_local_credentials(db, payload.email, payload.password)
    except AuthError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc

    repo = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
    enrolled = await is_enrolled(db, user.id)
    admin_must_mfa = (
        repo is not None
        and repo.require_admin_2fa
        and user.role == UserRole.ADMIN
    )
    # WebAuthn takes precedence over TOTP when at least one passkey is
    # registered (modern + phishing-resistant). The same ``mfa_token``
    # is consumable by both endpoints, so the SPA can offer a fallback
    # link if needed.
    from app.api.v1.webauthn import passkey_login_state

    pk_state = await passkey_login_state(db, user, repo)
    if pk_state["action"] == "mfa_passkey":
        return MfaChallenge(
            mfa_required=True,
            mfa_token=create_mfa_challenge_token(str(user.id)),
            method="webauthn",
        )
    if enrolled:
        # TOTP first, even when a passkey policy asks for an enrolment
        # afterwards (/login/mfa hands it out): registering a passkey must
        # not be reachable with the password alone once a second factor
        # exists.
        return MfaChallenge(
            mfa_required=True,
            mfa_token=create_mfa_challenge_token(str(user.id)),
            method="totp",
        )
    if pk_state["action"] == "enrollment_required":
        return EnrollmentRequired(enrollment_token=pk_state["token"])
    if admin_must_mfa:
        # Admin without any second factor while the repo requires one:
        # registering a passkey completes this login (first-login
        # enrolment, as under the forced-passkey policy). A TOTP challenge
        # here could never be answered and would lock the admin out.
        return EnrollmentRequired(enrollment_token=mint_enrollment_token(str(user.id)))

    access, refresh = await issue_tokens_for_user(
        db, user, request_meta=_request_meta(request)
    )
    return _pair(access, refresh)


@router.post("/login/mfa")
@limiter.limit("10/minute")
async def login_mfa(
    request: Request,
    payload: MfaVerifyRequest,
    db: DbSession,
) -> TokenPair | EnrollmentRequired:
    """Second step of the MFA login flow. Accepts the challenge token from
    /auth/login plus a 6-digit TOTP or 8-char recovery code. Returns an
    ``EnrollmentRequired`` instead of tokens when the user's role must use a
    passkey and none is registered yet."""
    try:
        claims = decode_token(payload.mfa_token)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid MFA challenge",
        ) from exc
    if claims.get("type") != "mfa_challenge":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not an MFA challenge token",
        )
    sub = claims.get("sub")
    import uuid

    try:
        user_id = uuid.UUID(sub) if sub else None
    except ValueError:
        user_id = None
    if user_id is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid challenge")
    user = (
        await db.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account unavailable")
    ok = await totp_verify_login(db, user, code=payload.code)
    if not ok:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid code")
    from app.api.v1.webauthn import passkey_login_state

    repo = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
    pk_state = await passkey_login_state(db, user, repo)
    if pk_state["action"] == "enrollment_required":
        return EnrollmentRequired(enrollment_token=pk_state["token"])
    access, refresh = await issue_tokens_for_user(
        db, user, request_meta=_request_meta(request)
    )
    return _pair(access, refresh)


@router.post("/signup", response_model=TokenPair, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
async def signup(request: Request, payload: SignupRequest, db: DbSession) -> TokenPair:
    if not settings.local_auth_enabled:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Local auth disabled")
    try:
        _, access, refresh = await signup_local(
            db,
            email=payload.email,
            username=payload.username,
            password=payload.password,
            full_name=payload.full_name,
            invite_code=payload.invite_code,
            request_meta=_request_meta(request),
        )
    except AuthError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return _pair(access, refresh)


@router.post("/refresh", response_model=TokenPair)
@limiter.limit("20/minute")
async def refresh(request: Request, payload: RefreshRequest, db: DbSession) -> TokenPair:
    try:
        _, access, refresh_tok = await refresh_tokens(
            db, payload.refresh_token, request_meta=_request_meta(request)
        )
    except AuthError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    return _pair(access, refresh_tok)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
@limiter.limit("20/minute")
async def logout(request: Request, payload: RefreshRequest, db: DbSession) -> Response:
    """Revoke the refresh-token chain so the session is dead server-side.

    The frontend ``clearTokens`` wipe only kills the local copy — without
    this endpoint a refresh token exfiltrated before the user clicked
    logout (browser backup, console exposure, etc.) stays usable until
    natural expiry. Accepts the refresh token in the body (same shape
    as ``/refresh``); a missing or malformed value silently 204s so a
    careless retry can't be turned into an enumeration oracle.
    """
    from jwt import InvalidTokenError as _JWTError

    from app.core.security import decode_token
    from app.services.auth_service import _revoke_refresh_chain

    try:
        decoded = decode_token(payload.refresh_token)
    except _JWTError:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    jti = decoded.get("jti")
    if not isinstance(jti, str):
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    await _revoke_refresh_chain(db, jti)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------------
# OIDC
# --------------------------------------------------------------------------
@router.get("/oidc/login")
async def oidc_login(request: Request, invite: str | None = None, bind: str | None = None):
    """Start the OIDC dance. An optional ``?invite=`` is stashed in the session
    so the callback can hand it to the user-creation step (the invite must
    survive the round-trip through the IdP, where we can't pass it directly).

    H7 — defence against an attacker tricking a logged-out user into
    consuming the attacker's invite via a cross-site link to this
    endpoint: when ``invite`` is set we require a Referer / Origin that
    matches the SPA's public URL, so a CSRF-style cross-site navigation
    is refused. A user who legitimately reaches /login → "Continue with
    SSO" carries a Referer of our own origin.
    """
    oauth = get_oauth()
    if oauth is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="OIDC disabled")
    if not bind or not _OIDC_BIND_RE.fullmatch(bind):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Start the SSO sign-in from the login page",
        )
    request.session[_OIDC_BIND_SESSION_KEY] = _nonce_hash(bind)
    if invite:
        expected = _origin(settings.public_app_url)
        referer = _origin(request.headers.get("referer") or "")
        origin = _origin(request.headers.get("origin") or "")
        if not expected or expected not in (referer, origin):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Invite codes must be supplied from within the app",
            )
        request.session[_OIDC_INVITE_SESSION_KEY] = invite
    else:
        # Clear any stale value so a previous attempt's code can't be reused.
        request.session.pop(_OIDC_INVITE_SESSION_KEY, None)
    redirect_uri = f"{settings.public_api_url.rstrip('/')}/api/v1/auth/oidc/callback"
    return await oauth.oidc.authorize_redirect(request, redirect_uri)


@router.get("/oidc/callback")
async def oidc_callback(request: Request, db: DbSession):
    oauth = get_oauth()
    if oauth is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="OIDC disabled")
    # NOTE: do NOT pass ``redirect_uri=...`` here. Authlib stores the
    # value at ``authorize_redirect`` time in the session and threads
    # it into the internal ``fetch_access_token`` call itself; passing
    # it again as a kwarg causes "got multiple values for keyword
    # argument 'redirect_uri'". The session-stored value is exactly the
    # one we sent at auth time, so a reverse-proxy URL drift between
    # request.url and PUBLIC_API_URL doesn't enter the picture.
    try:
        token = await oauth.oidc.authorize_access_token(request)
    except Exception as exc:  # noqa: BLE001 — Authlib raises various subclasses
        # Log the real exception (with traceback) for the operator. The
        # URL fragment we redirect with is a stable code only — Authlib /
        # joserfc exception strings can leak IdP URLs, JWKS endpoints,
        # OAuth ``state``/``error_description`` bodies (sometimes with
        # internal details) which would otherwise land in the user's
        # browser history + Referer header on the next click.
        logger.warning("OIDC token exchange failed", exc_info=exc)
        return _oidc_error("token_exchange_failed")
    userinfo = token.get("userinfo") or {}
    if not userinfo:
        userinfo = await oauth.oidc.userinfo(token=token)

    subject = userinfo.get("sub")
    email = userinfo.get("email")
    if not isinstance(subject, str) or not isinstance(email, str) or not subject or not email:
        return _oidc_error("missing_claims")
    # CRITICAL: refuse callbacks whose email isn't IdP-verified. Otherwise
    # any attacker who can register an unverified email at the IdP (or one
    # of its tenants, on a multi-tenant provider) could silently claim an
    # existing local account whose email happens to match — instant
    # takeover. The check is binary: ``False`` and missing both fail.
    #
    # Operators of single-tenant IdPs that don't emit ``email_verified``
    # at all (Defguard, some Keycloak setups) can disable the gate via
    # ``OIDC_REQUIRE_EMAIL_VERIFIED=false`` in .env — see the warning
    # logged at startup in services/oidc_service.py when the gate is off.
    if settings.oidc_require_email_verified and not bool(userinfo.get("email_verified")):
        return _oidc_error("email_unverified")

    username = (
        userinfo.get("preferred_username")
        or userinfo.get("nickname")
        or email.split("@")[0]
    )
    full_name = userinfo.get("name")

    # Pop the invite (single-use, even if signup fails for another reason —
    # the user would just re-enter it on a retry).
    invite_code = request.session.pop(_OIDC_INVITE_SESSION_KEY, None)

    bind_hash = request.session.pop(_OIDC_BIND_SESSION_KEY, None)
    if not isinstance(bind_hash, str):
        return _oidc_error("token_exchange_failed")
    try:
        user = await link_or_create_oidc_user(
            db,
            subject=subject,
            email=email,
            username=username,
            full_name=full_name,
            is_admin=claim_indicates_admin(userinfo),
            invite_code=invite_code,
        )
    except AuthError as exc:
        # Bounce the user back to /login with a stable reason code. A raw
        # JSON 400 mid-OAuth-flow is technically correct but useless to
        # whoever just clicked "Continue with SSO" in the browser.
        return _oidc_error(exc.code)

    # The SPA redeems this single-use code (with the nonce it kept) at
    # /auth/oidc/exchange; tokens never travel in a URL.
    now = datetime.now(UTC)
    code = _jwt.encode(
        {
            "sub": str(user.id),
            "type": _OIDC_CODE_TYPE,
            "bind": bind_hash,
            "jti": secrets.token_urlsafe(16),
            "iat": int(now.timestamp()),
            "exp": int((now + _OIDC_CODE_TTL).timestamp()),
        },
        settings.secret_key,
        algorithm=settings.jwt_algorithm,
    )
    return RedirectResponse(
        url=f"{settings.public_app_url.rstrip('/')}/auth/oidc-success#code={code}",
        status_code=status.HTTP_302_FOUND,
    )


class OidcExchangeRequest(BaseModel):
    code: str = Field(min_length=1, max_length=4096)
    nonce: str = Field(min_length=16, max_length=128)


@router.post("/oidc/exchange", response_model=TokenPair)
@limiter.limit("10/minute")
async def oidc_exchange(
    request: Request, payload: OidcExchangeRequest, db: DbSession
) -> TokenPair:
    """Second half of the SSO sign-in: trade the one-time code from the
    callback (plus the nonce the SPA generated before leaving) for tokens."""
    try:
        claims = _jwt.decode(payload.code, settings.secret_key, algorithms=[settings.jwt_algorithm])
    except _jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid code") from exc
    bind = claims.get("bind")
    jti = claims.get("jti")
    if (
        claims.get("type") != _OIDC_CODE_TYPE
        or not isinstance(bind, str)
        or not isinstance(jti, str)
        or not hmac.compare_digest(bind, _nonce_hash(payload.nonce))
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid code")
    try:
        user_id = uuid.UUID(str(claims.get("sub")))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid code") from exc
    if not await claim_once(f"oidc-exchange:{jti}", int(_OIDC_CODE_TTL.total_seconds()) + 60):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Code already used")
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account unavailable")
    access, refresh = await issue_tokens_for_user(
        db, user, request_meta=_request_meta(request)
    )
    return _pair(access, refresh)
