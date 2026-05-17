"""SQLAlchemy ORM models.

All models inherit from :class:`app.core.database.Base`. Importing this package
ensures every model is registered against the declarative metadata, which is
required for ``alembic --autogenerate`` and for ``Base.metadata.create_all``.
"""
from app.models.api_key import ApiKey
from app.models.app import App, AppCategory, Category, Localization
from app.models.apk import Apk
from app.models.audit import DownloadEvent
from app.models.repo_config import RepoConfig
from app.models.user import User

__all__ = [
    "Apk",
    "ApiKey",
    "App",
    "AppCategory",
    "Category",
    "DownloadEvent",
    "Localization",
    "RepoConfig",
    "User",
]
