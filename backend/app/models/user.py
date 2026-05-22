from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, Enum, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.mixins import IdMixin, TimestampMixin


class UserRole(str, enum.Enum):
    USER = "user"          # browse + download only — no upload, no /my-apps
    UPLOADER = "uploader"  # can manage own apps + browse, no admin UI
    ADMIN = "admin"        # full access (admin UI inclus)


class AuthProvider(str, enum.Enum):
    LOCAL = "local"
    OIDC = "oidc"


class User(Base, IdMixin, TimestampMixin):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    full_name: Mapped[str | None] = mapped_column(String(255))

    # local auth (nullable for OIDC-only users)
    hashed_password: Mapped[str | None] = mapped_column(String(255))

    # OIDC link
    auth_provider: Mapped[AuthProvider] = mapped_column(
        Enum(AuthProvider, name="auth_provider"),
        default=AuthProvider.LOCAL,
        nullable=False,
    )
    oidc_subject: Mapped[str | None] = mapped_column(String(255), unique=True, index=True)

    role: Mapped[UserRole] = mapped_column(
        Enum(UserRole, name="user_role"),
        default=UserRole.USER,
        nullable=False,
    )

    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # When False (default), NSFW-flagged apps are hidden from this user's
    # discovery surfaces — catalogue, search, public profiles, and the
    # F-Droid index served to their API keys. The detail page still opens
    # behind a confirmation interstitial. Flipping this triggers a reindex
    # so the F-Droid client view stays in sync with the web one.
    show_nsfw: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # BCP47 tag used to pick the right ``Localization`` row when serving
    # catalogue / detail / public-profile responses. NULL = the app's
    # default (en-US) fields are returned, matching the anonymous experience.
    preferred_locale: Mapped[str | None] = mapped_column(String(16))
    # Set on every password change. The JWT decoder rejects access /
    # refresh tokens whose ``iat`` predates this value, so a stolen
    # token stops working the moment the victim rotates their password.
    password_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Per-user quota overrides. NULL = fall back to ``RepoConfig.default_*``
    # (which itself can be NULL = unlimited). Stored on the user row so an
    # admin can grant a generous individual cap without changing the repo
    # default for everyone.
    quota_max_apps: Mapped[int | None] = mapped_column(Integer)
    quota_max_storage_bytes: Mapped[int | None] = mapped_column(BigInteger)
    quota_max_apks_per_month: Mapped[int | None] = mapped_column(Integer)

    # relationships
    api_keys = relationship("ApiKey", back_populates="user", cascade="all, delete-orphan")
    apps = relationship("App", back_populates="owner", foreign_keys="App.owner_id")

    @property
    def is_admin(self) -> bool:
        return self.role == UserRole.ADMIN

    @property
    def can_upload(self) -> bool:
        """True for ``uploader`` or ``admin``. Gates every endpoint that
        creates, edits, or attaches an APK / metadata / asset to an app
        — and the /my-apps surface that wraps them in the SPA."""
        return self.role in (UserRole.UPLOADER, UserRole.ADMIN)
