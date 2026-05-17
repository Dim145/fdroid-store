from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class InviteCodeCreate(BaseModel):
    note: str | None = Field(default=None, max_length=255)
    # Lifetime in days. ``None`` means "never expires until used".
    expires_in_days: int | None = Field(default=None, ge=1, le=365)


class InviteCodeRead(BaseModel):
    """Admin-facing invite row. Carries denormalised usernames so the UI can
    render who created/consumed each code without a second round-trip."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    note: str | None
    created_at: datetime
    expires_at: datetime | None
    used_at: datetime | None
    created_by_username: str | None = None
    used_by_username: str | None = None
