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
    upload_max_apk_mb: int = 200
    # Repo-wide default quotas. NULL = unlimited (no cap). A per-user
    # override on ``User.quota_*`` wins over the default.
    default_quota_max_apps: int | None = None
    default_quota_max_storage_bytes: int | None = None
    default_quota_max_apks_per_month: int | None = None
    # Repo-wide retention cap. NULL = unlimited (keep every APK).
    # Per-app override on ``App.max_versions_override`` wins.
    default_max_versions_per_app: int | None = None
    # ClamAV scanner toggles. ``clamav_available`` is read off the env on
    # the backend and only true when ``FDROID_CLAMAV_HOST`` is set — the
    # frontend uses it to gate the admin toggles.
    clamav_available: bool = False
    clamav_scan_on_upload: bool = False
    clamav_scan_periodic: bool = False
    require_admin_2fa: bool = False
    public_stats: bool = False


class RepoConfigUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    address: HttpUrl | None = None
    mirrors: list[HttpUrl] | None = Field(default=None, max_length=32)
    public_mode: bool | None = None
    registration_policy: RegistrationPolicy | None = None
    # Cap on APK upload size in mebibytes. The backend enforces this via
    # ``read_capped`` on every APK upload endpoint. 5–2000 covers normal
    # F-Droid use; anything outside that range is almost certainly a
    # mis-configuration.
    upload_max_apk_mb: int | None = Field(default=None, ge=5, le=2000)
    # Repo-wide quota defaults — same null-vs-reset semantics as the
    # per-user fields on AdminUserUpdate.
    default_quota_max_apps: int | None = Field(default=None, ge=0)
    default_quota_max_storage_bytes: int | None = Field(default=None, ge=0)
    default_quota_max_apks_per_month: int | None = Field(default=None, ge=0)
    # Repo-wide retention. ``None`` = leave alone, ``0`` = unlimited,
    # any positive integer caps the per-app version count.
    default_max_versions_per_app: int | None = Field(default=None, ge=0)
    quota_reset_apps: bool = False
    quota_reset_storage_bytes: bool = False
    quota_reset_apks_per_month: bool = False
    quota_reset_max_versions_per_app: bool = False
    # ClamAV runtime toggles. Ignored when the env knob isn't set; the
    # admin endpoint rejects them with a 400.
    clamav_scan_on_upload: bool | None = None
    clamav_scan_periodic: bool | None = None
    require_admin_2fa: bool | None = None
    # Admin toggle for /stats public-vs-auth visibility. Independent of
    # ``public_mode`` (which gates the catalogue); when the catalogue is
    # private, /stats is also auth-gated regardless of this flag.
    public_stats: bool | None = None


class SetupStatus(BaseModel):
    setup_complete: bool
    keystore_present: bool
    # ``has_users`` is intentionally NOT exposed: an anonymous caller would
    # otherwise be able to confirm whether the default admin account still
    # exists, which makes brute-forcing the shipped ``changeme_admin``
    # password materially easier.
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
    # Admin-set APK upload cap in megabytes. Exposed publicly so the
    # frontend can fail-fast (clean inline error) instead of waiting
    # for the backend's 413 on a multi-minute upload that exceeded
    # the cap. Knowing the limit is not sensitive — it's a UX limit.
    upload_max_apk_mb: int = 200


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
    # Must be explicitly set to ``True`` to re-generate the keystore once
    # ``setup_complete`` is on the repo config. Rotating the signing key
    # is a one-way decision — every F-Droid client that's already added
    # the repo refuses to update past this point. Defaults to False.
    confirm_destroy: bool = False


class KeystoreInfo(BaseModel):
    present: bool
    fingerprint_sha256: str | None
    alias: str | None
    not_before: datetime | None
    not_after: datetime | None
