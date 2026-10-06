from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class AppCollaboratorRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    user_id: uuid.UUID
    granted_at: datetime
    # Joined client-side from the User row — saves the frontend an N+1.
    username: str
    # Only filled for admins (see api/v1/collaborators.py); plain str —
    # SSO addresses are stored as the IdP sent them.
    email: str | None = None
    full_name: str | None = None


class AppCollaboratorAdd(BaseModel):
    """One of the two fields must be provided.

    Username lookup is the common case (admin types it in). Email is a
    fallback when the username isn't memorable; both are unique on the
    user table so either resolves a single row.
    """

    username: str | None = Field(default=None, min_length=1, max_length=64)
    email: EmailStr | None = None
