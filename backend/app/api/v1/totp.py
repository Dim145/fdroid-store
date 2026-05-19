"""TOTP enrolment + status endpoints (mounted under ``/me/totp``)."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import DbSession, get_current_user
from app.core.security import verify_password
from app.models.repo_config import RepoConfig
from app.models.user import User
from app.models.user_totp import UserTotp
from app.services.audit import write_event
from app.services.totp import (
    begin_enrolment,
    confirm_enrolment,
    disable as totp_disable,
    is_enrolled,
)

router = APIRouter()


class TotpSetupResponse(BaseModel):
    secret: str
    provisioning_uri: str
    qr_data_uri: str


class TotpConfirmRequest(BaseModel):
    code: str = Field(min_length=6, max_length=8)


class TotpConfirmResponse(BaseModel):
    recovery_codes: list[str]


class TotpDisableRequest(BaseModel):
    """Password is required to disable TOTP — without it a stolen access
    token could turn 2FA off in one POST. OIDC-only users (no password) get
    a 400 from this endpoint and have to disable via an admin."""

    password: str = Field(min_length=1, max_length=128)


class TotpStatusResponse(BaseModel):
    enrolled: bool
    pending: bool = False
    last_used_at: str | None = None


@router.get("/status", response_model=TotpStatusResponse)
async def totp_status(
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
) -> TotpStatusResponse:
    row = (
        await db.execute(select(UserTotp).where(UserTotp.user_id == user.id))
    ).scalar_one_or_none()
    if row is None:
        return TotpStatusResponse(enrolled=False)
    return TotpStatusResponse(
        enrolled=row.confirmed_at is not None,
        pending=row.confirmed_at is None,
        last_used_at=row.last_used_at.isoformat() if row.last_used_at else None,
    )


@router.post("/setup", response_model=TotpSetupResponse)
async def totp_setup(
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
) -> TotpSetupResponse:
    """Stage a new TOTP secret. Returns the QR + provisioning URI so the
    user can register the secret with their authenticator app. The
    enrolment isn't active until they POST a verification code to
    ``/confirm``."""
    repo = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
    issuer = (repo.name if repo else None) or "fdroid-store"
    payload = await begin_enrolment(db, user, issuer=issuer)
    return TotpSetupResponse(**payload)


@router.post("/confirm", response_model=TotpConfirmResponse)
async def totp_confirm(
    payload: TotpConfirmRequest,
    db: DbSession,
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
) -> TotpConfirmResponse:
    codes = await confirm_enrolment(db, user, code=payload.code)
    await write_event(
        db,
        action="user.totp_enrolled",
        actor=user,
        target_type="user",
        target_id=user.id,
        summary="enrolled TOTP",
        request=request,
    )
    return TotpConfirmResponse(recovery_codes=codes)


@router.post(
    "/disable",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    response_class=Response,
)
async def totp_disable_route(
    payload: TotpDisableRequest,
    db: DbSession,
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
) -> None:
    if user.hashed_password is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This account has no local password — ask an admin to disable TOTP",
        )
    if not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Wrong password")
    await totp_disable(db, user)
    await write_event(
        db,
        action="user.totp_disabled",
        actor=user,
        target_type="user",
        target_id=user.id,
        summary="disabled TOTP",
        request=request,
    )
