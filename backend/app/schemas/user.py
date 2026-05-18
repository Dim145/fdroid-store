from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.models.user import AuthProvider, UserRole


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: EmailStr
    username: str
    full_name: str | None
    role: UserRole
    auth_provider: AuthProvider
    is_active: bool
    last_login_at: datetime | None
    created_at: datetime
    show_nsfw: bool = False
    preferred_locale: str | None = None


# BCP47-ish locale tag — keep tight enough to reject obvious garbage but
# permissive enough to accept the long tail (script subtags, regional
# variants, etc.). Same shape as the apps endpoint accepts.
_LOCALE_PATTERN = r"^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,4})?$"


class UserUpdate(BaseModel):
    full_name: str | None = Field(default=None, max_length=255)
    show_nsfw: bool | None = None
    # ``"null"`` (JSON null) clears the preference; an empty string is
    # rejected so the API doesn't store junk values that won't match
    # anything in the resolver.
    preferred_locale: str | None = Field(default=None, max_length=16, pattern=_LOCALE_PATTERN)


class AdminUserCreate(BaseModel):
    email: EmailStr
    username: str = Field(min_length=3, max_length=64, pattern=r"^[a-zA-Z0-9_.-]+$")
    password: str = Field(min_length=8, max_length=128)
    full_name: str | None = Field(default=None, max_length=255)
    role: UserRole = UserRole.USER


class AdminUserUpdate(BaseModel):
    full_name: str | None = Field(default=None, max_length=255)
    role: UserRole | None = None
    is_active: bool | None = None
    new_password: str | None = Field(default=None, min_length=8, max_length=128)
