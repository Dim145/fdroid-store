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
    # Per-app funding + contribution URLs, matching the keys F-Droid clients
    # render as buttons. We don't enforce schemes so users can drop a custom
    # URL where the protocol differs (e.g. ``bitcoin:`` URIs).
    donate: Mapped[str | None] = mapped_column(String(512))
    liberapay: Mapped[str | None] = mapped_column(String(512))
    bitcoin: Mapped[str | None] = mapped_column(String(512))
    open_collective: Mapped[str | None] = mapped_column(String(512))
    translation: Mapped[str | None] = mapped_column(String(512))

    icon_path: Mapped[str | None] = mapped_column(String(512))  # storage key
    # True when the admin uploaded a custom icon: subsequent APK uploads
    # MUST NOT overwrite the icon. Cleared when the admin reverts to auto.
    icon_is_custom: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    feature_graphic_path: Mapped[str | None] = mapped_column(String(512))
    # F-Droid v2 also ships ``promoGraphic`` (a smaller advertising tile) and
    # ``tvBanner`` (Android TV launcher banner). Same locale-aware storage
    # layout as the feature graphic; emitted in both index variants so the
    # client can surface them on the right device.
    promo_graphic_path: Mapped[str | None] = mapped_column(String(512))
    tv_banner_path: Mapped[str | None] = mapped_column(String(512))

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
    # When True, the owner pinned a specific suggested version and subsequent
    # APK uploads must NOT bump the suggestion automatically. Cleared by the
    # "reset to auto" action, which also re-runs the auto-bump against the
    # current set of published APKs.
    suggested_version_is_manual: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
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
    screenshots = relationship(
        "AppScreenshot",
        back_populates="app",
        cascade="all, delete-orphan",
        order_by="AppScreenshot.display_order",
    )

    @property
    def is_nsfw(self) -> bool:
        """True if any APK is flagged NSFW.

        F-Droid anti-feature labels are free-form strings, so we match case-
        insensitively — admins typing "nsfw", "NSFW", or "NSfw" all count.
        """
        for apk in self.apks:
            for flag in apk.anti_features or ():
                if isinstance(flag, str) and flag.strip().lower() == "nsfw":
                    return True
        return False


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


class AppScreenshot(Base, IdMixin, TimestampMixin):
    """A promotional image (screenshot) for an app.

    Stored at ``<package>/<locale>/phoneScreenshots/<id>.png`` so the F-Droid
    client can fetch it directly via its expected path layout.
    """
    __tablename__ = "app_screenshots"

    app_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("apps.id", ondelete="CASCADE"), index=True, nullable=False
    )
    locale: Mapped[str] = mapped_column(String(16), default="en-US", nullable=False)
    storage_key: Mapped[str] = mapped_column(String(512), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(nullable=False)
    width: Mapped[int | None] = mapped_column()
    height: Mapped[int | None] = mapped_column()
    display_order: Mapped[int] = mapped_column(default=0, nullable=False)

    app = relationship("App", back_populates="screenshots")
