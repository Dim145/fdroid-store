"""Common SQLAlchemy column mixins."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, declared_attr, mapped_column


def _utcnow() -> datetime:
    return datetime.now(UTC)


class IdMixin:
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )


class TimestampMixin:
    @declared_attr
    def created_at(cls) -> Mapped[datetime]:  # noqa: N805
        return mapped_column(
            DateTime(timezone=True),
            nullable=False,
            default=_utcnow,
            server_default=func.now(),
        )

    @declared_attr
    def updated_at(cls) -> Mapped[datetime]:  # noqa: N805
        return mapped_column(
            DateTime(timezone=True),
            nullable=False,
            default=_utcnow,
            onupdate=_utcnow,
            server_default=func.now(),
        )
