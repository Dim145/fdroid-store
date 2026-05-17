from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class DownloadEvent(Base, IdMixin, TimestampMixin):
    """One row per APK download.

    Auth context is captured at request time. Anonymous downloads (public repo)
    leave ``user_id`` and ``api_key_id`` NULL.
    """
    __tablename__ = "download_events"

    apk_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("apks.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    app_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("apps.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    api_key_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("api_keys.id", ondelete="SET NULL")
    )

    ip_hash: Mapped[str | None] = mapped_column(String(64))  # SHA-256 of IP, never raw
    user_agent: Mapped[str | None] = mapped_column(String(512))
    bytes_served: Mapped[int | None] = mapped_column(Integer)
    status_code: Mapped[int] = mapped_column(Integer, default=200, nullable=False)
