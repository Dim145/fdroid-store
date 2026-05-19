"""Per-app GitHub release auto-fetch configuration.

When an app has a row here, the worker periodically polls the configured
GitHub repository and imports new releases as APKs — automatically
applying the same signer/quota/anti-feature checks as a manual upload.
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, backref, mapped_column, relationship

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class GithubSourceStatus(str, enum.Enum):
    IDLE = "idle"                # never scanned
    UP_TO_DATE = "up_to_date"    # scanned, no new release to import
    IMPORTED = "imported"        # last scan imported a release
    ERROR = "error"              # last scan failed (see last_error)
    SKIPPED = "skipped"          # release found but skipped (e.g. signer mismatch handled gracefully)


class GithubProvider(str, enum.Enum):
    """Which forge the ``repo`` field refers to. Drives which release
    API + auth header we use. ``base_url`` on the row pairs with this
    to point at a self-hosted instance (gitlab.example.com, codeberg.org,
    a private Gitea, …)."""
    GITHUB = "github"
    GITLAB = "gitlab"
    GITEA = "gitea"


class GithubSource(Base, IdMixin, TimestampMixin):
    __tablename__ = "github_sources"
    __table_args__ = (
        UniqueConstraint("app_id", name="uq_github_source_app"),
    )

    app_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("apps.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # GitHub repository in the canonical ``owner/name`` shape (case preserved
    # for display; matching is case-insensitive on GitHub's side).
    repo: Mapped[str] = mapped_column(String(255), nullable=False)

    # Which forge ``repo`` belongs to. Defaults to GitHub so existing
    # rows on upgraded deployments keep working without a backfill.
    provider: Mapped[GithubProvider] = mapped_column(
        Enum(GithubProvider, name="github_provider"),
        default=GithubProvider.GITHUB,
        nullable=False,
    )
    # Optional self-hosted instance URL (e.g. ``https://gitlab.example.com``,
    # ``https://codeberg.org``). NULL means use the provider's canonical
    # public host. Validated to be https on save.
    base_url: Mapped[str | None] = mapped_column(String(255))

    # Per-source personal access token, encrypted at rest with a key
    # derived from ``settings.secret_key`` (see services.crypto). Used
    # by the scan to authenticate against private repos; NULL means
    # fall back to the env-var token for the provider.
    access_token_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary)

    # fnmatch-style glob applied to release asset ``name``. NULL falls back
    # to ``*.apk`` (any first APK in the release). Useful when a release
    # ships multiple ABI splits and the owner wants the universal one only.
    asset_pattern: Mapped[str | None] = mapped_column(String(255))

    # When True, pre-releases are eligible. Drafts are always skipped.
    include_prereleases: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Toggle the cron without losing the config. Manual scans still work
    # when disabled — they're explicit operator actions.
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # Snapshot of the last release we imported (or just observed). Keyed on
    # tag_name because GitHub release ids change when a maintainer recreates
    # a release with the same tag.
    last_release_tag: Mapped[str | None] = mapped_column(String(255))
    last_release_published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    last_scanned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_status: Mapped[GithubSourceStatus] = mapped_column(
        Enum(GithubSourceStatus, name="github_source_status"),
        default=GithubSourceStatus.IDLE,
        nullable=False,
    )
    last_error: Mapped[str | None] = mapped_column(Text)

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )

    @property
    def has_access_token(self) -> bool:
        """True when the source has a per-source PAT configured (used by
        the API to expose the boolean state without leaking the token)."""
        return bool(self.access_token_encrypted)

    app = relationship(
        "App",
        # ``passive_deletes`` lets the DB-level ``ondelete=CASCADE`` on
        # ``app_id`` actually fire — without it SQLAlchemy fetches the
        # relationship and tries to NULL the FK first, which violates
        # the NOT NULL constraint and aborts the App delete.
        backref=backref(
            "github_source",
            uselist=False,
            cascade="all, delete-orphan",
            passive_deletes=True,
        ),
    )
