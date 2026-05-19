from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from sqlalchemy import select

from app.api.deps import DbSession
from app.core.config import settings
from app.core.rate_limit import limiter
from app.models.repo_config import RepoConfig
from app.schemas.auth import (
    AuthMethodsInfo,
    LoginRequest,
    RefreshRequest,
    SignupRequest,
    TokenPair,
)
from app.services.auth_service import (
    AuthError,
    authenticate_local,
    link_or_create_oidc_user,
    refresh_tokens,
    signup_local,
)
from app.services.oidc_service import claim_indicates_admin, get_oauth

router = APIRouter()

# Session key used to carry an invite code across the OIDC redirect.
# Authlib already uses ``request.session`` for its own state, so we're just
# tucking one extra value alongside it.
_OIDC_INVITE_SESSION_KEY = "oidc_invite_code"


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
    """Extract (ip_hash, user_agent) for the session row.

    The IP is read from ``X-Forwarded-For`` (first hop only) when present,
    falling back to the socket peer. We hash it on the way in — the raw
    address is never persisted.
    """
    import hashlib

    fwd = request.headers.get("x-forwarded-for")
    ip = fwd.split(",", 1)[0].strip() if fwd else (
        request.client.host if request.client else None
    )
    ip_hash = hashlib.sha256(ip.encode("utf-8")).hexdigest() if ip else None
    ua = request.headers.get("user-agent")
    ua = ua[:255] if ua else None
    return ip_hash, ua


@router.post("/login", response_model=TokenPair)
@limiter.limit("5/minute")
async def login(request: Request, payload: LoginRequest, db: DbSession) -> TokenPair:
    if not settings.local_auth_enabled:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Local auth disabled")
    try:
        _, access, refresh = await authenticate_local(
            db, payload.email, payload.password, request_meta=_request_meta(request)
        )
    except AuthError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
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


# --------------------------------------------------------------------------
# OIDC
# --------------------------------------------------------------------------
@router.get("/oidc/login")
async def oidc_login(request: Request, invite: str | None = None):
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
    if invite:
        expected = settings.public_app_url.rstrip("/")
        referer = request.headers.get("referer") or ""
        origin = request.headers.get("origin") or ""
        if not (referer.startswith(expected) or origin == expected):
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
    try:
        token = await oauth.oidc.authorize_access_token(request)
    except Exception as exc:  # noqa: BLE001 — Authlib raises various subclasses
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"OIDC error: {exc}") from exc
    userinfo = token.get("userinfo") or {}
    if not userinfo:
        userinfo = await oauth.oidc.userinfo(token=token)

    subject = userinfo.get("sub")
    email = userinfo.get("email")
    if not subject or not email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="OIDC missing sub/email")
    # CRITICAL: refuse callbacks whose email isn't IdP-verified. Otherwise
    # any attacker who can register an unverified email at the IdP (or one
    # of its tenants, on a multi-tenant provider) could silently claim an
    # existing local account whose email happens to match — instant
    # takeover. The check is binary: ``False`` and missing both fail.
    if not bool(userinfo.get("email_verified")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="OIDC email is not marked verified by the identity provider",
        )

    username = (
        userinfo.get("preferred_username")
        or userinfo.get("nickname")
        or email.split("@")[0]
    )
    full_name = userinfo.get("name")

    # Pop the invite (single-use, even if signup fails for another reason —
    # the user would just re-enter it on a retry).
    invite_code = request.session.pop(_OIDC_INVITE_SESSION_KEY, None)

    try:
        _, access, refresh_tok = await link_or_create_oidc_user(
            db,
            subject=subject,
            email=email,
            username=username,
            full_name=full_name,
            is_admin=claim_indicates_admin(userinfo),
            invite_code=invite_code,
            request_meta=_request_meta(request),
        )
    except AuthError as exc:
        # Bounce the user back to /login with the reason in a query param.
        # A raw JSON 400 mid-OAuth-flow is technically correct but useless to
        # whoever just clicked "Continue with SSO" in the browser.
        from urllib.parse import quote
        return RedirectResponse(
            url=(
                f"{settings.public_app_url.rstrip('/')}/login?oidc_error={quote(str(exc))}"
            ),
            status_code=status.HTTP_302_FOUND,
        )

    # Hand the tokens to the SPA via URL fragment (#) so they never reach our
    # server logs as query strings.
    return RedirectResponse(
        url=(
            f"{settings.public_app_url.rstrip('/')}/auth/oidc-success"
            f"#access_token={access}&refresh_token={refresh_tok}"
        ),
        status_code=status.HTTP_302_FOUND,
    )
