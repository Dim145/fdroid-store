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
    anti_features: list[str] = Field(default_factory=list)
    status: ApkStatus
    rejection_reason: str | None
    whats_new: str | None = None
    published_at: datetime | None
    created_at: datetime


class ApkUpdate(BaseModel):
    """Fields editable on an existing APK row.

    The changelog and the anti-feature flags are admin-curated metadata; the
    rest is extracted from the binary and would be rewritten by a rescan.
    """
    whats_new: str | None = Field(default=None, max_length=10_000)
    # ``None`` = leave as-is. Empty list explicitly clears the flags.
    anti_features: list[str] | None = Field(default=None, max_length=20)


class ApkInspect(BaseModel):
    """Returned by ``POST /apks/inspect`` — parsed metadata without DB writes."""
    package_name: str
    app_name: str | None
    version_code: int
    version_name: str
    min_sdk: int | None
    target_sdk: int | None
    sha256: str
    size_bytes: int
    signer_sha256: str
    permissions: list[str]
    native_code: list[str]
    has_icon: bool


class ScreenshotRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    storage_key: str
    sha256: str
    size_bytes: int
    width: int | None
    height: int | None
    locale: str
    display_order: int


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
    author_email: str | None = Field(default=None, max_length=255)
    donate: str | None = Field(default=None, max_length=512)
    liberapay: str | None = Field(default=None, max_length=512)
    bitcoin: str | None = Field(default=None, max_length=512)
    open_collective: str | None = Field(default=None, max_length=512)
    translation: str | None = Field(default=None, max_length=512)
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
    author_email: str | None = Field(default=None, max_length=255)
    donate: str | None = Field(default=None, max_length=512)
    liberapay: str | None = Field(default=None, max_length=512)
    bitcoin: str | None = Field(default=None, max_length=512)
    open_collective: str | None = Field(default=None, max_length=512)
    translation: str | None = Field(default=None, max_length=512)
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
    author_email: str | None = None
    donate: str | None = None
    liberapay: str | None = None
    bitcoin: str | None = None
    open_collective: str | None = None
    translation: str | None = None
    icon_path: str | None
    icon_is_custom: bool = False
    feature_graphic_path: str | None = None
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
    screenshots: list["ScreenshotRead"] = Field(default_factory=list)
    owner_username: str | None = None
