from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class AuditLogRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    actor_id: uuid.UUID | None
    # Joined client-side; the admin UI prefers username/email over the UUID.
    actor_username: str | None = None
    actor_email: str | None = None
    action: str
    target_type: str | None
    target_id: str | None
    summary: str | None
    payload: dict[str, Any] | None
    ip_hash: str | None
    user_agent: str | None


class AuditLogPage(BaseModel):
    items: list[AuditLogRead]
    total: int
