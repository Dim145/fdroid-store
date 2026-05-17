from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import RedirectResponse

from app.api.deps import DbSession
from app.core.config import settings
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


@router.get("/methods", response_model=AuthMethodsInfo)
async def auth_methods() -> AuthMethodsInfo:
    """Tells the frontend which login flows are enabled."""
    return AuthMethodsInfo(
        local=settings.local_auth_enabled,
        oidc=settings.oidc_enabled,
        allow_signup=settings.allow_signup,
        oidc_login_url=f"{settings.public_api_url}/api/v1/auth/oidc/login" if settings.oidc_enabled else None,
    )


def _pair(access: str, refresh: str) -> TokenPair:
    return TokenPair(
        access_token=access,
        refresh_token=refresh,
        expires_in=settings.access_token_expire_minutes * 60,
    )


@router.post("/login", response_model=TokenPair)
async def login(payload: LoginRequest, db: DbSession) -> TokenPair:
    if not settings.local_auth_enabled:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Local auth disabled")
    try:
        _, access, refresh = await authenticate_local(db, payload.email, payload.password)
    except AuthError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    return _pair(access, refresh)


@router.post("/signup", response_model=TokenPair, status_code=status.HTTP_201_CREATED)
async def signup(payload: SignupRequest, db: DbSession) -> TokenPair:
    if not settings.local_auth_enabled:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Local auth disabled")
    try:
        _, access, refresh = await signup_local(
            db,
            email=payload.email,
            username=payload.username,
            password=payload.password,
            full_name=payload.full_name,
        )
    except AuthError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return _pair(access, refresh)


@router.post("/refresh", response_model=TokenPair)
async def refresh(payload: RefreshRequest, db: DbSession) -> TokenPair:
    try:
        _, access, refresh_tok = await refresh_tokens(db, payload.refresh_token)
    except AuthError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    return _pair(access, refresh_tok)


# --------------------------------------------------------------------------
# OIDC
# --------------------------------------------------------------------------
@router.get("/oidc/login")
async def oidc_login(request: Request):
    oauth = get_oauth()
    if oauth is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="OIDC disabled")
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

    username = (
        userinfo.get("preferred_username")
        or userinfo.get("nickname")
        or email.split("@")[0]
    )
    full_name = userinfo.get("name")

    try:
        _, access, refresh_tok = await link_or_create_oidc_user(
            db,
            subject=subject,
            email=email,
            username=username,
            full_name=full_name,
            is_admin=claim_indicates_admin(userinfo),
        )
    except AuthError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    # Hand the tokens to the SPA via URL fragment (#) so they never reach our
    # server logs as query strings.
    return RedirectResponse(
        url=(
            f"{settings.public_app_url.rstrip('/')}/auth/oidc-success"
            f"#access_token={access}&refresh_token={refresh_tok}"
        ),
        status_code=status.HTTP_302_FOUND,
    )
