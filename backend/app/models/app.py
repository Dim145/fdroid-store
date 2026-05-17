from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    String,
    Table,
    Text,
    UniqueConstraint,
    Column,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class AppVisibility(str, enum.Enum):
    PUBLIC = "public"     # included in the public F-Droid repo index
    PRIVATE = "private"   # only available via the authenticated repo URL


class AppStatus(str, enum.Enum):
    DRAFT = "draft"             # created, no APK yet
    PENDING_REVIEW = "pending_review"  # awaiting admin validation
    PUBLISHED = "published"
    REJECTED = "rejected"
    ARCHIVED = "archived"


# many-to-many App <-> Category
app_categories_table = Table(
    "app_categories",
    Base.metadata,
    Column("app_id", UUID(as_uuid=True), ForeignKey("apps.id", ondelete="CASCADE"), primary_key=True),
    Column("category_id", UUID(as_uuid=True), ForeignKey("categories.id", ondelete="CASCADE"), primary_key=True),
)


class App(Base, IdMixin, TimestampMixin):
    """An Android application tracked in the repo.

    Identified by its Java-style package name (e.g. ``org.example.app``).
    Holds metadata; the actual APK binaries live in the :class:`Apk` model.
    """
    __tablename__ = "apps"

    package_name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    summary: Mapped[str | None] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text)
    license: Mapped[str | None] = mapped_column(String(128))
    website: Mapped[str | None] = mapped_column(String(512))
    source_code: Mapped[str | None] = mapped_column(String(512))
    issue_tracker: Mapped[str | None] = mapped_column(String(512))
    author_name: Mapped[str | None] = mapped_column(String(255))
    author_email: Mapped[str | None] = mapped_column(String(255))

    icon_path: Mapped[str | None] = mapped_column(String(512))  # storage key
    feature_graphic_path: Mapped[str | None] = mapped_column(String(512))

    visibility: Mapped[AppVisibility] = mapped_column(
        Enum(AppVisibility, name="app_visibility"),
        default=AppVisibility.PUBLIC,
        nullable=False,
    )
    status: Mapped[AppStatus] = mapped_column(
        Enum(AppStatus, name="app_status"),
        default=AppStatus.DRAFT,
        nullable=False,
    )

    # The certificate SHA-256 of the signer of accepted APKs. Locked after the
    # first published APK so that an attacker can't push a different signature
    # for the same package name.
    locked_signer_sha256: Mapped[str | None] = mapped_column(String(64), index=True)

    suggested_version_code: Mapped[int | None] = mapped_column()
    suggested_version_name: Mapped[str | None] = mapped_column(String(128))
    last_published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
    )

    # relationships
    owner = relationship("User", back_populates="apps", foreign_keys=[owner_id])
    apks = relationship(
        "Apk",
        back_populates="app",
        cascade="all, delete-orphan",
        order_by="Apk.version_code.desc()",
    )
    categories = relationship("Category", secondary=app_categories_table, back_populates="apps")
    localizations = relationship("Localization", back_populates="app", cascade="all, delete-orphan")


class Category(Base, IdMixin, TimestampMixin):
    __tablename__ = "categories"

    name: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(String(255))

    apps = relationship("App", secondary=app_categories_table, back_populates="categories")


class AppCategory(Base, IdMixin, TimestampMixin):
    """Reserved for future tagging metadata (e.g. anti-features per app)."""
    __tablename__ = "app_category_meta"
    __table_args__ = (UniqueConstraint("app_id", "category_id", name="uq_app_category"),)

    app_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("apps.id", ondelete="CASCADE"))
    category_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("categories.id", ondelete="CASCADE"))
    is_featured: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class Localization(Base, IdMixin, TimestampMixin):
    """Per-locale strings for an app (name, summary, description, screenshots)."""
    __tablename__ = "app_localizations"
    __table_args__ = (UniqueConstraint("app_id", "locale", name="uq_app_locale"),)

    app_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("apps.id", ondelete="CASCADE"), index=True
    )
    locale: Mapped[str] = mapped_column(String(16), nullable=False)  # e.g. "en-US"
    name: Mapped[str | None] = mapped_column(String(255))
    summary: Mapped[str | None] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text)
    whats_new: Mapped[str | None] = mapped_column(Text)
    video: Mapped[str | None] = mapped_column(String(512))

    app = relationship("App", back_populates="localizations")
