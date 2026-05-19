from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class UserSessionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    last_seen_at: datetime
    ip_hash: str | None
    user_agent: str | None
    revoked_at: datetime | None = None
