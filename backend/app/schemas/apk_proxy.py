"""DTOs for the APK source-proxy admin + per-app endpoints.

The shapes mirror the protocol documented at
``docs/proxy-protocol.md``. Anything coming from the proxy itself
(catalogue + resolve responses) is validated against these so a
malformed payload from a hostile proxy can't crash the worker.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl


# ---------------------------------------------------------------------------
# Proxy registry (admin-side)
# ---------------------------------------------------------------------------


class ApkProxyCreate(BaseModel):
    """Body for ``POST /api/v1/admin/proxies``.

    ``auth_token`` is optional — loopback / private-network deployments
    may run without a shared secret. Validated server-side via a head-
    less ``/healthz`` round-trip before the row is persisted, so a
    typo'd base_url or wrong token fails fast.
    """

    name: str = Field(min_length=1, max_length=128)
    base_url: HttpUrl
    auth_token: str | None = Field(default=None, max_length=512)
    enabled: bool = True


class ApkProxyUpdate(BaseModel):
    """Partial PATCH. ``None`` on every field means "leave alone";
    ``auth_token == ""`` clears the secret (write-only field — the API
    never returns the current value)."""

    name: str | None = Field(default=None, min_length=1, max_length=128)
    base_url: HttpUrl | None = None
    auth_token: str | None = Field(default=None, max_length=512)
    enabled: bool | None = None


class ApkProxyRead(BaseModel):
    """What the admin UI sees. ``auth_token`` is never returned —
    ``has_auth_token`` is the only signal that one is configured."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    base_url: str
    enabled: bool
    has_auth_token: bool
    last_health_status: str
    last_health_at: datetime | None
    last_health_error: str | None
    cached_sources_at: datetime | None
    cached_sources_json: dict[str, Any] | None
    created_at: datetime
    updated_at: datetime


class ApkProxyPublicRead(BaseModel):
    """Uploader-facing view of a proxy. Slimmed down from
    :class:`ApkProxyRead` so non-admin pages don't leak operational
    detail: the ``base_url`` (which can reveal internal hostnames /
    custom ports), the ``has_auth_token`` flag, ``created_by``, and
    every ``last_health_*`` / ``cached_sources_at`` / timestamp field
    stay admin-only.

    The cached catalogue (``cached_sources_json``) IS exposed because
    the per-app wizard reads provider descriptors out of it — but the
    public endpoint already filters to enabled + healthy + non-empty
    catalogue, so the only catalogues uploaders see are usable ones.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    cached_sources_json: dict[str, Any] | None


# ---------------------------------------------------------------------------
# Proxy catalogue (``GET /sources`` shape, used to validate the response)
# ---------------------------------------------------------------------------


class ProviderSecretField(BaseModel):
    """One row in the dynamic form the frontend renders for
    ``api_token`` / ``basic`` providers."""

    key: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=128)
    secret: bool = False
    required: bool = True
    placeholder: str | None = Field(default=None, max_length=256)


class ProviderOAuthHint(BaseModel):
    """``auth_oauth`` block for OAuth providers."""

    begin_path: str = Field(min_length=1, max_length=256)
    scopes_hint: list[str] = Field(default_factory=list, max_length=32)


class ProviderDescriptor(BaseModel):
    """One ``providers[]`` entry from ``GET /sources``."""

    id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9_-]+$")
    name: str = Field(min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=512)
    icon_url: str | None = Field(default=None, max_length=512)
    url_hint: str | None = Field(default=None, max_length=512)
    url_pattern: str | None = Field(default=None, max_length=512)
    auth_kind: Literal["none", "api_token", "basic", "oauth2"]
    auth_oauth: ProviderOAuthHint | None = None
    secret_fields: list[ProviderSecretField] = Field(default_factory=list)
    supports_search: bool = False


class ProxySourcesCatalogue(BaseModel):
    """``GET /sources`` response shape. The version field is the only
    protocol-evolution signal we honour — backends refuse proxies whose
    declared version is higher than the one they support."""

    version: int
    name: str | None = None
    providers: list[ProviderDescriptor]


# ---------------------------------------------------------------------------
# /resolve (proxy → backend) — used by the worker
# ---------------------------------------------------------------------------


class ResolveResponse(BaseModel):
    """200 body from ``POST /resolve``. Every field is validated even
    when not strictly required — a hostile proxy that returns an
    oversized ``apk_size_bytes`` (e.g. 2^63) needs to be rejected
    before it ever reaches the download loop."""

    release_id: str = Field(min_length=1, max_length=512)
    package_name: str = Field(min_length=1, max_length=255)
    version_name: str = Field(min_length=1, max_length=128)
    version_code: int = Field(ge=1, le=2**31 - 1)
    published_at: datetime | None = None
    apk_url: HttpUrl
    apk_size_bytes: int | None = Field(default=None, ge=0, le=2 * 1024 * 1024 * 1024)
    apk_sha256_hint: str | None = Field(default=None, pattern=r"^[0-9a-fA-F]{64}$")
    apk_headers: dict[str, str] | None = None
    expires_at: datetime | None = None


class ProxyError(BaseModel):
    """Standard error shape from the proxy."""

    error: str
    message: str | None = None
    retry_after: int | None = None


# ---------------------------------------------------------------------------
# Per-app source (user-side)
# ---------------------------------------------------------------------------


class ApkProxySourceCreate(BaseModel):
    """Body for ``PUT /api/v1/apps/{id}/proxy-source``.

    ``secrets`` is the user-supplied credentials blob, shape defined by
    the proxy's ``secret_fields`` declaration. For OAuth providers, the
    only key is ``credential_id`` (assigned by the proxy via the OAuth
    callback flow — see :func:`app.api.v1.proxies.oauth_callback`).
    """

    proxy_id: uuid.UUID
    provider: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9_-]+$")
    source_url: HttpUrl
    secrets: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True


class ApkProxySourceRead(BaseModel):
    """Per-app source view. ``secrets`` are never returned — only
    ``has_secrets`` indicates whether one is set."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    app_id: uuid.UUID
    proxy_id: uuid.UUID
    provider: str
    source_url: str
    enabled: bool
    has_secrets: bool
    last_release_id: str | None
    last_release_at: datetime | None
    last_scanned_at: datetime | None
    last_status: str
    last_error: str | None
    suspended_until: datetime | None
    created_at: datetime
    updated_at: datetime


class ApkProxySourceUpdate(BaseModel):
    """Partial PATCH — ``None`` means leave alone."""

    source_url: HttpUrl | None = None
    secrets: dict[str, str] | None = None
    enabled: bool | None = None


# ---------------------------------------------------------------------------
# /apps/inspect-proxy-source + /apps/with-proxy-source (new-app flow)
# ---------------------------------------------------------------------------


class ProxyInspectRequest(BaseModel):
    """Body for ``POST /api/v1/apks/inspect-proxy-source``.

    Same shape as :class:`ApkProxySourceCreate` minus the listing fields:
    the user pastes a URL + secrets, the backend calls the proxy's
    ``/resolve``, downloads the APK, parses the manifest, and returns
    enough metadata for the New App page to render a preview without
    writing anything to the DB.
    """

    proxy_id: uuid.UUID
    provider: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9_-]+$")
    source_url: HttpUrl
    secrets: dict[str, str] = Field(default_factory=dict)


class ProxyApkInspect(BaseModel):
    """Response from ``POST /api/v1/apks/inspect-proxy-source``.

    Mirrors :class:`GithubApkInspect` field-for-field on the APK side so
    the New App page can reuse the same preview card, plus a tail of
    proxy-context fields (``release_id``, ``provider`` name, ...) the
    second create call needs to wire back up to the persistent source row.
    """

    # APK metadata (identical to ApkInspect)
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
    detected_anti_features: dict[str, list[str]]
    # Proxy context — needed by the with-proxy-source call AND surfaced
    # by the preview card so the user sees what they're about to attach.
    proxy_id: uuid.UUID
    proxy_name: str
    provider: str
    provider_name: str
    source_url: str
    release_id: str
    release_published_at: datetime | None


class AppCreateFromProxy(BaseModel):
    """Body for ``POST /api/v1/apps/with-proxy-source``.

    Combines the App listing fields (mirroring :class:`AppCreate`) with
    the proxy-source descriptor (proxy_id / provider / source_url /
    secrets). The backend re-resolves + re-downloads server-side — the
    inspect-time response is advisory only.
    """

    # Listing
    name: str = Field(min_length=1, max_length=255)
    summary: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=4096)
    license: str | None = Field(default=None, max_length=64)
    website: HttpUrl | None = None
    source_code: HttpUrl | None = None
    issue_tracker: HttpUrl | None = None
    author_name: str | None = Field(default=None, max_length=128)
    visibility: Literal["public", "private"] = "public"
    # Proxy descriptor
    proxy_id: uuid.UUID
    provider: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9_-]+$")
    source_url: HttpUrl
    secrets: dict[str, str] = Field(default_factory=dict)
