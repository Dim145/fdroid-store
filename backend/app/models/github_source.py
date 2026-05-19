"""Per-app GitHub release auto-fetch configuration.

When an app has a row here, the worker periodically polls the configured
GitHub repository and imports new releases as APKs — automatically
applying the same signer/quota/anti-feature checks as a manual upload.
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class GithubSourceStatus(str, enum.Enum):
    IDLE = "idle"                # never scanned
    UP_TO_DATE = "up_to_date"    # scanned, no new release to import
    IMPORTED = "imported"        # last scan imported a release
    ERROR = "error"              # last scan failed (see last_error)
    SKIPPED = "skipped"          # release found but skipped (e.g. signer mismatch handled gracefully)


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

    app = relationship("App", backref="github_source", uselist=False)
