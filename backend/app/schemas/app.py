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


class CategoryWithCount(CategoryRead):
    """List-view variant that also reports how many apps reference the row.

    Used by the admin categories page to surface usage before a deletion.
    """
    app_count: int = 0


class CategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str | None = Field(default=None, max_length=255)


class CategoryUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
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


_DESCRIPTION_MAX = 20_000


class AppCreate(BaseModel):
    package_name: str = Field(min_length=3, max_length=255, pattern=r"^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$")
    name: str = Field(min_length=1, max_length=255)
    summary: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=_DESCRIPTION_MAX)
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
    description: str | None = Field(default=None, max_length=_DESCRIPTION_MAX)
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
    promo_graphic_path: str | None = None
    tv_banner_path: str | None = None
    visibility: AppVisibility
    status: AppStatus
    suggested_version_code: int | None
    suggested_version_name: str | None
    last_published_at: datetime | None
    created_at: datetime
    updated_at: datetime
    categories: list[CategoryRead] = Field(default_factory=list)
    is_nsfw: bool = False


class LocalizationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    locale: str
    name: str | None = None
    summary: str | None = None
    description: str | None = None
    video: str | None = None


class LocalizationUpsert(BaseModel):
    """Per-locale overrides. Locale comes from the URL — anything you can
    leave blank you should (an unset field falls back to the app's default
    values in the F-Droid client). At least one field has to be set so an
    empty PUT doesn't create an empty row."""
    name: str | None = Field(default=None, max_length=255)
    summary: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=20_000)
    video: str | None = Field(default=None, max_length=512)


class AppDetail(AppRead):
    apks: list[ApkRead] = Field(default_factory=list)
    screenshots: list["ScreenshotRead"] = Field(default_factory=list)
    localizations: list[LocalizationRead] = Field(default_factory=list)
    owner_username: str | None = None
    # Total successful APK downloads across every version of this app,
    # counting both authenticated and anonymous traffic.
    download_count: int = 0
