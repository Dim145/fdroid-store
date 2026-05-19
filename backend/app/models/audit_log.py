from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class AuditLog(Base, IdMixin, TimestampMixin):
    """Append-only record of consequential admin/user actions.

    Each row captures who did what, on which entity, from which IP, with a
    free-form JSON payload for the specifics (the diff, the reason, the
    affected count). Reads are admin-only.
    """

    __tablename__ = "audit_log"

    # The user who performed the action. NULL when the action is system-driven
    # (cron, bootstrap, scheduled cleanup) — we still want a row so the
    # timeline is complete.
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
    )

    # Short slug, e.g. ``user.role_changed``, ``app.deleted``, ``apk.published``,
    # ``repo.reindex_triggered``. Kept as a plain string to avoid migrating an
    # enum every time we add a new action.
    action: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    # The entity affected. ``target_type`` is a model name slug
    # (``user`` / ``app`` / ``apk`` / ``repo_config`` / …), ``target_id`` is
    # the affected row's primary key when there is one (NULL for repo-wide
    # actions like reindex). Together they let the admin UI link from a row
    # to the affected entity.
    target_type: Mapped[str | None] = mapped_column(String(32), index=True)
    target_id: Mapped[str | None] = mapped_column(String(64))

    # Optional one-line summary suitable for showing in a list view without
    # decoding the JSON payload. Keep it short — the JSON has the details.
    summary: Mapped[str | None] = mapped_column(Text)

    # Structured payload (the diff, before/after, reason text, …). JSONB so
    # we can query/filter on keys later if needed.
    payload: Mapped[dict[str, Any] | None] = mapped_column(JSONB)

    # Trust signals around the request that produced this row. ``ip_hash``
    # follows the same hashed-IP pattern as ``DownloadEvent`` (privacy: the
    # raw IP is not persisted).
    ip_hash: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(255))

    __table_args__ = (
        # Reverse-chronological scans are the hot path for the admin view.
        Index("ix_audit_log_created_at_desc", "created_at"),
    )
