"""Per-app bearer token used by a maintainer's CI to upload APKs.

Unlike user :class:`~app.models.api_key.ApiKey` rows (which scope to a
user account and grant whatever permissions the user has), deploy
tokens are pinned to a single app and can only do one thing: upload
new APK versions to *that* app. This narrower blast radius means a
leaked CI token compromises one app, not the maintainer's whole
catalogue.

Tokens are minted on the manage-app page; the full secret is shown
once, only the prefix + hashed secret are persisted.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class DeployToken(Base, IdMixin, TimestampMixin):
    __tablename__ = "deploy_tokens"

    app_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("apps.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # User-supplied label so the operator can tell tokens apart ("GitHub
    # Actions", "GitLab CI", "Buildkite", …).
    name: Mapped[str] = mapped_column(String(128), nullable=False)

    # ``prefix`` matches the format ``fdci_<16hex>_<secret>``; only the
    # prefix is searchable so a token lookup is a single indexed scan.
    prefix: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    hashed_secret: Mapped[str] = mapped_column(String(128), nullable=False)

    # Audit trail. Owner of the token + last successful use timestamp.
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    app = relationship("App", backref="deploy_tokens", passive_deletes=True)

    @property
    def is_active(self) -> bool:
        return self.revoked_at is None
