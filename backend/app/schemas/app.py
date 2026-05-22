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
    # ``{locale: text}`` — empty dict and NULL both render as "no notes".
    whats_new: dict[str, str] | None = None
    published_at: datetime | None
    created_at: datetime
    # Reproducible Builds tracking — see ``ReproducibilityStatus``.
    reproducibility_status: str = "unknown"
    reproducibility_reference_sha256: str | None = None
    reproducibility_reference_url: str | None = None
    reproducibility_verified_at: datetime | None = None
    reproducibility_notes: str | None = None


class ReproducibilitySet(BaseModel):
    """Body for ``POST /apks/{id}/reproducibility``.

    Either ``status`` is provided directly (declarative path), or
    ``reference_sha256`` is provided (auto-decide path — match against
    ``Apk.sha256``). Setting both is allowed: the auto-decide wins so
    a typo in ``status`` can't override a hash mismatch.
    """

    status: str | None = Field(default=None, max_length=16)
    reference_sha256: str | None = Field(default=None, min_length=64, max_length=64)
    reference_url: str | None = Field(default=None, max_length=512)
    notes: str | None = Field(default=None, max_length=1000)


class ReproducibilityFromUrl(BaseModel):
    """Body for ``POST /apks/{id}/reproducibility/verify-from-url``.

    ``reference_url`` MUST be http/https. The handler fetches the URL,
    extracts a 64-char hex SHA-256 from the response body (either raw
    or a sha256sum-style line ``<hash>  <filename>``), compares to the
    APK's own hash and persists the verdict.
    """

    reference_url: str = Field(min_length=10, max_length=512)
    notes: str | None = Field(default=None, max_length=1000)


class ApkUpdate(BaseModel):
    """Fields editable on an existing APK row.

    The changelog and the anti-feature flags are admin-curated metadata; the
    rest is extracted from the binary and would be rewritten by a rescan.
    """
    # ``{locale: text}`` per BCP47. ``None`` leaves it alone; an explicit
    # empty dict clears it. The handler validates locale shape + total
    # per-entry length so the JSON column stays tidy.
    whats_new: dict[str, str] | None = Field(default=None)
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
    # Heuristic anti-feature detection: ``{flag: [human label, …]}``. The
    # frontend renders these as pre-selected chips that the uploader can
    # toggle off if they're a false positive. Empty dict = no signatures
    # hit (or scanning was skipped).
    detected_anti_features: dict[str, list[str]] = {}
    # Signed handle that lets the SPA confirm the create / add-APK step
    # without re-uploading the file. The backend stashes the bytes under
    # ``staging/<sha256>.apk`` during inspect; ``POST /apps/with-staged-apk``
    # and ``POST /apks/upload-staged/{app_id}`` redeem this token to skip
    # the second upload. NULL when staging failed (network, S3 outage) —
    # caller falls back to the legacy double-upload flow.
    staging_token: str | None = None


class GithubInspectRequest(BaseModel):
    """Body for ``POST /apks/inspect-github``. The name is historical;
    the endpoint now handles GitHub, GitLab and Gitea/Forgejo."""
    repo: str = Field(min_length=3, max_length=255)
    asset_pattern: str | None = Field(default=None, max_length=255)
    include_prereleases: bool = False
    provider: str = Field(default="github", max_length=16)
    base_url: str | None = Field(default=None, max_length=255)
    # Optional one-shot PAT, used only for this inspect call. The
    # backend never persists it — the create / upsert endpoints have
    # their own token field for the on-disk row.
    access_token: str | None = Field(default=None, max_length=1024)


class AppCreateFromGithub(BaseModel):
    """Body for ``POST /apps/with-github-source`` — creates the App,
    downloads the latest matching release as the first APK, and stores
    a :class:`~app.models.github_source.GithubSource` row so the daily
    cron keeps the app in sync. The package name is taken from the
    parsed APK manifest; the client must not provide it.
    """
    name: str = Field(min_length=1, max_length=255)
    summary: str | None = Field(default=None, max_length=255)
    # Same cap as ``AppCreate.description`` — kept literal here so this
    # class body doesn't depend on the module-level constant defined
    # further down.
    description: str | None = Field(default=None, max_length=20_000)
    license: str | None = Field(default=None, max_length=128)
    website: HttpUrl | None = None
    source_code: HttpUrl | None = None
    issue_tracker: HttpUrl | None = None
    author_name: str | None = Field(default=None, max_length=255)
    visibility: AppVisibility = AppVisibility.PUBLIC
    # Release source bits — the same shape as GithubSourceUpsert but
    # repeated here so this endpoint stays self-contained.
    repo: str = Field(min_length=3, max_length=255)
    asset_pattern: str | None = Field(default=None, max_length=255)
    include_prereleases: bool = False
    provider: str = Field(default="github", max_length=16)
    base_url: str | None = Field(default=None, max_length=255)
    # Per-source PAT persisted alongside the source. Same write-only
    # semantics as :class:`GithubSourceUpsert`.
    access_token: str | None = Field(default=None, max_length=1024)


class GithubApkInspect(ApkInspect):
    """Extends :class:`ApkInspect` with the GitHub release context. The
    New App page surfaces these alongside the parsed APK metadata so
    the operator can confirm they're about to import the right binary."""
    repo: str
    release_tag: str
    release_published_at: datetime
    release_is_prerelease: bool
    asset_name: str
    asset_pattern_used: str

    # Repository-level metadata pulled from ``GET /repos/{owner}/{repo}``.
    # Surfaced so the New App page can prefill the listing fields that
    # GitHub already knows about (summary, license, etc.). All optional
    # — a repo without a description or homepage just leaves them empty.
    repo_html_url: str
    repo_description: str | None = None
    repo_homepage: str | None = None
    repo_license_spdx: str | None = None
    repo_owner_login: str | None = None


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


class AppCreateFromStagedApk(BaseModel):
    """Body for ``POST /apps/with-staged-apk``. All the listing fields
    the operator filled in, plus the redemption token returned by
    ``POST /apks/inspect``. The APK bytes are pulled from staging
    server-side so the SPA doesn't re-upload the file."""
    staging_token: str = Field(min_length=10, max_length=512)
    # Package name is normally inferred from the manifest; allow override
    # only when the operator typed something explicitly and the parser
    # accepts it as a match. Same rule as ``create_app_with_apk``.
    package_name: str | None = Field(
        default=None,
        min_length=3,
        max_length=255,
        pattern=r"^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$",
    )
    name: str = Field(min_length=1, max_length=255)
    summary: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=20_000)
    license: str | None = Field(default=None, max_length=128)
    website: HttpUrl | None = None
    source_code: HttpUrl | None = None
    issue_tracker: HttpUrl | None = None
    author_name: str | None = Field(default=None, max_length=255)
    visibility: AppVisibility = AppVisibility.PUBLIC


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
    # Suggested version override. An explicit integer pins that version_code
    # (must match a published APK); an explicit null clears the pin and
    # restarts auto-tracking from the current set of published APKs. The
    # field uses ``model_fields_set`` semantics so omitting it leaves the
    # current state alone.
    suggested_version_code: int | None = None


class AppAdminUpdate(AppUpdate):
    status: AppStatus | None = None
    rejection_reason: str | None = Field(default=None, max_length=512)
    # Retention override. Admin-only because raising it bypasses the
    # global retention policy. ``model_fields_set`` semantics — omit
    # to leave the current value alone, send an explicit integer to
    # set, send ``null`` (via the corresponding reset field) to clear.
    max_versions_override: int | None = Field(default=None, ge=0)
    reset_max_versions_override: bool = False


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
    # Short-lived signed query token the SPA appends as ``?t=<token>`` on
    # every media URL of this app. Required for the owner's browser to
    # render private-app images, because ``<img src>`` tags carry no
    # Authorization header and the media route would otherwise 404 the
    # request. Populated only when the caller is authorised to view this
    # app's private media; ``None`` for public apps + anonymous callers.
    media_token: str | None = None
    visibility: AppVisibility
    status: AppStatus
    suggested_version_code: int | None
    suggested_version_name: str | None
    suggested_version_is_manual: bool = False
    locked_signer_sha256: str | None = None
    # Per-app override on the global APK-retention cap. ``None`` means
    # "use the repo-wide default" (``RepoConfig.default_max_versions_per_app``).
    # ``0`` means "no cap on this app" even when the global default
    # would otherwise kick in. Read-only for owners + co-maintainers;
    # only admins can write via ``AppUpdate.max_versions_override``.
    max_versions_override: int | None = None
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
    owner_id: uuid.UUID | None = None
    owner_username: str | None = None
    # Resolved retention cap (override → repo default → unlimited).
    # ``None`` means no cap. Computed server-side so the frontend
    # doesn't need to fetch RepoConfig (which is admin-only) to
    # render the banner.
    effective_max_versions: int | None = None
    # The repo-wide default in force, exposed for reference so the
    # admin override input can show what value the per-app override
    # will be clamped against. ``None`` means "no global cap".
    repo_default_max_versions: int | None = None
    # Total successful APK downloads across every version of this app,
    # counting both authenticated and anonymous traffic.
    download_count: int = 0
