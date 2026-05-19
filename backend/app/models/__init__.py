"""SQLAlchemy ORM models.

All models inherit from :class:`app.core.database.Base`. Importing this package
ensures every model is registered against the declarative metadata, which is
required for ``alembic --autogenerate`` and for ``Base.metadata.create_all``.
"""
from app.models.api_key import ApiKey
from app.models.app import App, AppCategory, AppScreenshot, Category, Localization
from app.models.app_collaborator import AppCollaborator
from app.models.apk import Apk
from app.models.apk_scan import ApkScan, ApkScanStatus
from app.models.audit import DownloadEvent
from app.models.audit_log import AuditLog
from app.models.deploy_token import DeployToken
from app.models.github_source import GithubProvider, GithubSource, GithubSourceStatus
from app.models.invite_code import InviteCode
from app.models.package_signer import PackageSignerPin
from app.models.refresh_token import RefreshToken
from app.models.repo_config import RepoConfig
from app.models.user import User
from app.models.user_session import UserSession
from app.models.user_totp import UserTotp

__all__ = [
    "Apk",
    "ApkScan",
    "ApkScanStatus",
    "ApiKey",
    "App",
    "AppCategory",
    "AppCollaborator",
    "AppScreenshot",
    "AuditLog",
    "Category",
    "DeployToken",
    "DownloadEvent",
    "GithubProvider",
    "GithubSource",
    "GithubSourceStatus",
    "InviteCode",
    "Localization",
    "PackageSignerPin",
    "RefreshToken",
    "RepoConfig",
    "User",
    "UserSession",
    "UserTotp",
]
