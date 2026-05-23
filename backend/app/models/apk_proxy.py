"""APK source proxy registry — admin-configured external services that
extend the source catalogue beyond the built-in forge providers
(GitHub / GitLab / Gitea).

Two related models live here:

  * :class:`ApkProxy` — one row per proxy the admin has registered with
    the instance. Holds the base URL, the shared bearer secret used to
    authenticate fdroid-store → proxy, and a cached snapshot of the
    proxy's last ``GET /sources`` response so the per-app wizard can
    render its providers without an extra round-trip.

  * :class:`ApkProxySource` — per-app row binding an App to a (proxy,
    provider, source URL, secrets) tuple. Mirrors the role
    :class:`GithubSource` plays for forge releases.

The protocol implemented against these models is documented at
``docs/proxy-protocol.md``.
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, backref, mapped_column, relationship

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class ApkProxyHealthStatus(str, enum.Enum):
    """Snapshot of the last ``GET /healthz`` round-trip. The cron + the
    admin UI both consult this to decide whether the proxy is dialable.
    """

    UNKNOWN = "unknown"
    HEALTHY = "healthy"
    UNREACHABLE = "unreachable"
    BAD_RESPONSE = "bad_response"
    AUTH_FAILED = "auth_failed"


class ApkProxySourceStatus(str, enum.Enum):
    """Latest outcome for a per-app source. Mirrors ``GithubSourceStatus``
    so the admin/jobs UI can group both side-by-side without two distinct
    state machines."""

    IDLE = "idle"                  # never scanned
    UP_TO_DATE = "up_to_date"      # /resolve returned 304
    IMPORTED = "imported"          # /resolve returned a release we ingested
    AUTH_REQUIRED = "auth_required"  # proxy returned 401 — user must re-OAuth
    RATE_LIMITED = "rate_limited"  # upstream rate limit, retry after backoff
    ERROR = "error"                # other failure (see last_error)
    SKIPPED = "skipped"            # release found but skipped (signer mismatch, etc.)


class ApkProxy(Base, IdMixin, TimestampMixin):
    """Admin-configured pointer at a source-proxy service.

    The shared bearer secret in ``auth_token_encrypted`` is the only
    credential ``fdroid-store`` ever uses to talk to the proxy. It's
    Fernet-encrypted at rest with a key derived from ``SECRET_KEY``
    (same recipe as :class:`GithubSource.access_token_encrypted`).

    ``cached_sources_json`` is a snapshot of the proxy's last
    ``GET /sources`` response, refreshed by an admin button or by the
    health-check cron. Caching it keeps the per-app wizard from doing a
    round-trip on every open and lets the admin see WHEN the catalogue
    was last refreshed.
    """

    __tablename__ = "apk_proxies"
    __table_args__ = (
        UniqueConstraint("base_url", name="uq_apk_proxy_base_url"),
    )

    # Human-friendly label shown in admin lists + the per-app wizard. Free
    # text but typically the name returned by the proxy's ``/sources``
    # under ``name`` so the labels stay in sync.
    name: Mapped[str] = mapped_column(String(128), nullable=False)

    # Base URL of the proxy, no trailing slash. e.g. ``https://proxy.
    # example.com``. Validated to be http(s) on save, and the SSRF guard
    # runs against the resolved IP before any request leaves the worker.
    base_url: Mapped[str] = mapped_column(String(512), nullable=False)

    # Shared secret used in ``Authorization: Bearer <token>``. Fernet-
    # encrypted at rest. NULL is allowed for loopback/private-network
    # deployments where the operator deliberately runs an open proxy.
    auth_token_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary)

    # Cron toggle. Manual operations (refresh sources, health check)
    # still work even when disabled — they're explicit admin actions.
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # ─── Last health-check snapshot ───────────────────────────────────
    last_health_status: Mapped[ApkProxyHealthStatus] = mapped_column(
        Enum(ApkProxyHealthStatus, name="apk_proxy_health_status"),
        default=ApkProxyHealthStatus.UNKNOWN,
        nullable=False,
    )
    last_health_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_health_error: Mapped[str | None] = mapped_column(Text)

    # ─── Cached ``GET /sources`` response ─────────────────────────────
    # Stored verbatim as JSON; the read schema cherry-picks fields for
    # the frontend. Mirrors what the v1 proxy spec returns.
    cached_sources_json: Mapped[dict | None] = mapped_column(JSON)
    cached_sources_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )

    @property
    def has_auth_token(self) -> bool:
        """True when the proxy is configured with a shared secret. Used
        by the API to expose state without leaking the token."""
        return bool(self.auth_token_encrypted)


class ApkProxySource(Base, IdMixin, TimestampMixin):
    """One row per (app, proxy provider) binding.

    Same role as :class:`GithubSource` but for non-forge upstreams. The
    discriminator ``provider`` (string, not enum) matches a
    ``providers[].id`` from the proxy's ``/sources`` catalogue. We avoid
    a PG enum here because each proxy author defines their own provider
    list — using a database-level enum would force a schema migration
    every time a new proxy ships.
    """

    __tablename__ = "apk_proxy_sources"
    __table_args__ = (
        # One source per (app, provider) pair. The same app could legally
        # have multiple sources across DIFFERENT providers (e.g. F-Droid
        # mirror + Patreon early-access), but we don't want two rows
        # pointing at the same provider for the same app.
        UniqueConstraint("app_id", "provider", name="uq_apk_proxy_source_app_provider"),
    )

    app_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("apps.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    proxy_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("apk_proxies.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # ``provider.id`` from the proxy's ``/sources`` catalogue. Lowercase
    # ``[a-z0-9_-]+`` per the spec. Stored verbatim so re-running the
    # cron uses the same string the proxy declared.
    provider: Mapped[str] = mapped_column(String(64), nullable=False)

    # URL the user pasted. Authoritatively interpreted by the proxy —
    # we just hand it back over the wire. Validated to be http(s) on
    # save; the SSRF guard runs at download time against the
    # ``apk_url`` the proxy returns, not against this one.
    source_url: Mapped[str] = mapped_column(String(1024), nullable=False)

    # Per-source credentials. Shape is provider-defined; for OAuth
    # providers it's typically ``{"credential_id": "uuid"}``. For
    # api_token providers it's ``{"<key>": "value", …}``. Stored
    # Fernet-encrypted as one JSON blob — the per-key shape is
    # intentionally not modelled in SQL so a new provider's keyset
    # doesn't require a migration.
    secrets_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary)

    # Cron toggle. Mirrors the GithubSource flag.
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # ─── Last-scan snapshot ───────────────────────────────────────────
    # The opaque ``release_id`` from the proxy's last ``/resolve``
    # response, fed back on the next call so the proxy can short-
    # circuit with ``304``.
    last_release_id: Mapped[str | None] = mapped_column(String(512))
    last_release_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_scanned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_status: Mapped[ApkProxySourceStatus] = mapped_column(
        Enum(ApkProxySourceStatus, name="apk_proxy_source_status"),
        default=ApkProxySourceStatus.IDLE,
        nullable=False,
    )
    last_error: Mapped[str | None] = mapped_column(Text)
    # When the proxy returned ``rate_limited``, the cron suspends polling
    # this source until this timestamp. NULL = no suspension.
    suspended_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )

    @property
    def has_secrets(self) -> bool:
        """True when ``secrets_encrypted`` is populated. Surfaced to the
        API so the read schema can expose a boolean without leaking
        the credential bytes."""
        return bool(self.secrets_encrypted)

    app = relationship(
        "App",
        backref=backref(
            "proxy_sources",
            cascade="all, delete-orphan",
            passive_deletes=True,
        ),
    )

    proxy = relationship(
        "ApkProxy",
        backref=backref(
            "sources",
            cascade="all, delete-orphan",
            passive_deletes=True,
        ),
    )
