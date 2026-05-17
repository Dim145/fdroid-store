from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ApiKeyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    can_download_private: bool = True
    can_manage_apps: bool = False
    expires_in_days: int | None = Field(default=None, ge=1, le=3650)


class ApiKeyRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    prefix: str
    can_download_private: bool
    can_manage_apps: bool
    expires_at: datetime | None
    last_used_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime


class ApiKeyCreated(ApiKeyRead):
    """Returned only once at creation: includes the plaintext key."""
    full_key: str
