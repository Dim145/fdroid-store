from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, EmailStr, Field


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class SignupRequest(BaseModel):
    email: EmailStr
    username: str = Field(min_length=3, max_length=64, pattern=r"^[a-zA-Z0-9_.-]+$")
    password: str = Field(min_length=8, max_length=128)
    full_name: str | None = Field(default=None, max_length=255)
    # Required when the repo's registration_policy is "invite".
    invite_code: str | None = Field(default=None, max_length=32)


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int  # seconds


class MfaChallenge(BaseModel):
    """Returned by /auth/login when the password check passed but a second
    factor is required. ``method`` distinguishes the kind of factor the
    client should prompt for: ``totp`` for the existing 6-digit /
    recovery-code flow, ``webauthn`` for a passkey assertion against
    /auth/webauthn/mfa/begin + /finish.

    When the user has both factors registered we prefer passkey by
    default; the SPA can still fall back to the TOTP endpoint with the
    same ``mfa_token`` if the user clicks "use code instead"."""

    mfa_required: bool = True
    mfa_token: str
    expires_in: int = 300  # seconds — matches the token's exp
    method: str = "totp"


class EnrollmentRequired(BaseModel):
    """Returned by /auth/login when the password step succeeded but the
    user's role is under a forced-passkey policy AND they have no
    credentials registered. The SPA reads ``enrollment_token`` and posts
    it to /auth/webauthn/enroll/{begin,finish} to enrol a passkey, after
    which the /enroll/finish call mints the actual session tokens."""

    enrollment_required: bool = True
    enrollment_token: str
    expires_in: int = 300


class MfaVerifyRequest(BaseModel):
    mfa_token: str
    code: str = Field(min_length=4, max_length=20)


class RefreshRequest(BaseModel):
    refresh_token: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)


class AuthMethodsInfo(BaseModel):
    local: bool
    oidc: bool
    allow_signup: bool
    oidc_login_url: str | None = None
    # Repo-level access flags, exposed so the login/signup pages can render
    # the right CTA without a second request.
    public_mode: bool = True
    registration_policy: Literal["public", "invite", "closed"] = "public"
