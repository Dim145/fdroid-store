from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class DeployTokenRead(BaseModel):
    """Returned by the list / revoke endpoints. The full secret is
    intentionally absent — only :class:`DeployTokenCreated` exposes it,
    and only once on creation."""
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    app_id: uuid.UUID
    name: str
    prefix: str
    last_used_at: datetime | None
    revoked_at: datetime | None
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


class DeployTokenCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)


class DeployTokenCreated(DeployTokenRead):
    """The full secret, returned once on creation. The frontend stages
    a one-time reveal card and tells the user to copy it before
    dismissing."""
    full_token: str
