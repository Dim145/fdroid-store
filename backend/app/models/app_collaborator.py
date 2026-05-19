from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class AppCollaborator(Base, IdMixin, TimestampMixin):
    """A non-owner user with publish-equivalent rights on an app.

    Co-maintainers can do everything an owner can — upload APKs, edit the
    listing, manage screenshots/translations/categories — EXCEPT four
    owner-only operations: delete the app, transfer ownership, add or
    remove co-maintainers, and change visibility (public↔private).

    The owner is implicit (``App.owner_id``); collaborators are explicit
    rows here.
    """

    __tablename__ = "app_collaborators"

    app_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("apps.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Who added them, for the audit trail. SET NULL on user deletion so the
    # grant row outlives the granter.
    granted_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
    )
    granted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint("app_id", "user_id", name="uq_app_collaborator_app_user"),
    )
