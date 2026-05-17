from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, HttpUrl

from app.models.app import AppStatus, AppVisibility
from app.models.apk import ApkStatus


class CategoryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    description: str | None


class CategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str | None = Field(default=None, max_length=255)


class ApkRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    app_id: uuid.UUID
    file_name: str
    size_bytes: int
    sha256: str
    version_code: int
    version_name: str
    min_sdk: int | None
    target_sdk: int | None
    signer_sha256: str
    permissions: list[str]
    native_code: list[str]
    status: ApkStatus
    rejection_reason: str | None
    published_at: datetime | None
    created_at: datetime


class AppCreate(BaseModel):
    package_name: str = Field(min_length=3, max_length=255, pattern=r"^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$")
    name: str = Field(min_length=1, max_length=255)
    summary: str | None = Field(default=None, max_length=255)
    description: str | None = None
    license: str | None = Field(default=None, max_length=128)
    website: HttpUrl | None = None
    source_code: HttpUrl | None = None
    issue_tracker: HttpUrl | None = None
    author_name: str | None = Field(default=None, max_length=255)
    visibility: AppVisibility = AppVisibility.PUBLIC
    category_ids: list[uuid.UUID] = Field(default_factory=list)


class AppUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    summary: str | None = Field(default=None, max_length=255)
    description: str | None = None
    license: str | None = Field(default=None, max_length=128)
    website: HttpUrl | None = None
    source_code: HttpUrl | None = None
    issue_tracker: HttpUrl | None = None
    author_name: str | None = Field(default=None, max_length=255)
    visibility: AppVisibility | None = None
    category_ids: list[uuid.UUID] | None = None


class AppAdminUpdate(AppUpdate):
    status: AppStatus | None = None
    rejection_reason: str | None = Field(default=None, max_length=512)


class AppRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    package_name: str
    name: str
    summary: str | None
    description: str | None
    license: str | None
    website: str | None
    source_code: str | None
    issue_tracker: str | None
    author_name: str | None
    icon_path: str | None
    visibility: AppVisibility
    status: AppStatus
    suggested_version_code: int | None
    suggested_version_name: str | None
    last_published_at: datetime | None
    created_at: datetime
    updated_at: datetime
    categories: list[CategoryRead] = Field(default_factory=list)


class AppDetail(AppRead):
    apks: list[ApkRead] = Field(default_factory=list)
    owner_username: str | None = None
