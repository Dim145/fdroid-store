from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class RepoConfig(Base, IdMixin, TimestampMixin):
    """Single-row table holding mutable repo metadata.

    The row is created during the setup wizard. We keep it in DB (rather than
    only env vars) so admins can change the repo name/description/icon from
    the UI without restarting the container.
    """
    __tablename__ = "repo_config"

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    icon_path: Mapped[str | None] = mapped_column(String(512))
    address: Mapped[str] = mapped_column(String(512), nullable=False)

    # Mirrors as JSON-encoded list of strings — admin-editable in the UI.
    mirrors_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)

    # Setup state
    setup_complete: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    keystore_fingerprint_sha256: Mapped[str | None] = mapped_column(String(64))

    # Index versioning
    last_index_version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_indexed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
