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

    # Access control:
    #   public_mode=True  → catalogue + F-Droid index are reachable anonymously
    #                       (existing app-level visibility still applies)
    #   public_mode=False → everything requires auth (JWT for the web UI,
    #                       an API key for the F-Droid client)
    public_mode: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # Self-signup policy. Values are kept as plain strings (rather than a PG
    # enum) so changes don't require a schema migration each time we add a
    # mode. Validated at the schema layer.
    #   "public" → anyone may sign up (legacy behaviour)
    #   "invite" → an admin-generated invite code is required
    #   "closed" → no new accounts; OIDC only lets existing users log in
    registration_policy: Mapped[str] = mapped_column(
        String(16), default="public", nullable=False
    )

    # Max APK upload size in mebibytes. Admin-configurable from the UI so
    # operators can tighten the upload surface without redeploying. The
    # backend enforces it via ``read_capped`` on the upload endpoints.
    upload_max_apk_mb: Mapped[int] = mapped_column(Integer, default=200, nullable=False)

    # Index versioning
    last_index_version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_indexed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    @property
    def mirrors(self) -> list[str]:
        """Decoded view of ``mirrors_json`` for serializers + the index builder."""
        import json as _json
        if not self.mirrors_json:
            return []
        try:
            value = _json.loads(self.mirrors_json)
        except _json.JSONDecodeError:
            return []
        return [str(u) for u in value if u] if isinstance(value, list) else []
