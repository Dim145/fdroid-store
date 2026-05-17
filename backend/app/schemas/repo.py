from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl


RegistrationPolicy = Literal["public", "invite", "closed"]


class RepoConfigRead(BaseModel):
    # The ``RepoConfig`` ORM row exposes a ``mirrors`` property (decoded from
    # ``mirrors_json``) so Pydantic's ``from_attributes`` reads the list
    # straight off the model — no custom validator needed here.
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
    public_mode: bool
    registration_policy: RegistrationPolicy
    mirrors: list[str] = []


class RepoConfigUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    address: HttpUrl | None = None
    mirrors: list[HttpUrl] | None = None
    public_mode: bool | None = None
    registration_policy: RegistrationPolicy | None = None


class SetupStatus(BaseModel):
    setup_complete: bool
    keystore_present: bool
    has_users: bool
    # Public-safe repo metadata exposed alongside setup state so anonymous
    # visitors can render the masthead without a separate request.
    repo_name: str | None = None
    repo_description: str | None = None
    repo_address: str | None = None
    repo_icon_path: str | None = None
    # SHA-256 fingerprint of the repo signing cert. Safe to expose publicly:
    # it's the value F-Droid clients use to verify the repo signature, so
    # putting it in a QR code is its intended use.
    repo_fingerprint: str | None = None
    # Whether anonymous browsing is currently allowed. Echoed here (in
    # addition to /auth/methods) so the SPA can decide synchronously, on the
    # same fetch it already does, whether to gate the catalogue.
    public_mode: bool = True


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
