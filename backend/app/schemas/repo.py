from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl


class RepoConfigRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None
    icon_path: str | None
    address: str
    setup_complete: bool
    keystore_fingerprint_sha256: str | None
    last_index_version: int
    last_indexed_at: datetime | None


class RepoConfigUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    address: HttpUrl | None = None
    mirrors: list[HttpUrl] | None = None


class SetupStatus(BaseModel):
    setup_complete: bool
    keystore_present: bool
    has_users: bool


class SetupWizardRequest(BaseModel):
    repo_name: str = Field(min_length=1, max_length=255)
    repo_description: str | None = Field(default=None, max_length=2000)
    repo_address: HttpUrl
    keystore_mode: Literal["generate", "import"]
    keystore_password: str | None = Field(default=None, min_length=6)
    key_alias: str | None = Field(default=None, min_length=1, max_length=64)
    key_password: str | None = Field(default=None, min_length=6)
    key_dname: str | None = Field(default=None, max_length=255)
    # When keystore_mode = "import":
    keystore_b64: str | None = None  # base64-encoded .p12 / .jks


class KeystoreInfo(BaseModel):
    present: bool
    fingerprint_sha256: str | None
    alias: str | None
    not_before: datetime | None
    not_after: datetime | None
