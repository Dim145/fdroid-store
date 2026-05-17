"""Application settings loaded from environment variables.

A single ``settings`` instance is exposed at module import time and reused
throughout the app. All env vars documented in ``.env.example``.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ----- Public URLs --------------------------------------------------------
    public_repo_url: str = "http://localhost:8080/fdroid/repo"
    public_app_url: str = "http://localhost:3000"
    public_api_url: str = "http://localhost:8000"

    # ----- Database -----------------------------------------------------------
    database_url: str = "postgresql+asyncpg://fdroid:fdroid@localhost:5432/fdroid"

    # ----- Redis --------------------------------------------------------------
    redis_url: str = "redis://localhost:6379/0"

    # ----- Secrets ------------------------------------------------------------
    secret_key: str = Field(min_length=32)
    access_token_expire_minutes: int = 60
    refresh_token_expire_days: int = 30
    jwt_algorithm: str = "HS256"

    # ----- Initial admin ------------------------------------------------------
    initial_admin_email: str = "admin@example.com"
    initial_admin_password: str = "changeme_admin"

    # ----- Storage ------------------------------------------------------------
    storage_backend: Literal["local", "s3"] = "local"
    local_storage_path: str = "/data/storage"
    s3_endpoint_url: str | None = None
    s3_region: str = "us-east-1"
    s3_bucket: str = "fdroid-store"
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_use_path_style: bool = True
    s3_public_base_url: str | None = None

    # ----- F-Droid repo metadata ---------------------------------------------
    repo_name: str = "My F-Droid Repo"
    repo_description: str = "A self-hosted F-Droid repository"
    repo_icon: str = "fdroid-icon.png"

    # ----- Keystore -----------------------------------------------------------
    keystore_path: str = "/data/keystores/repo.p12"
    keystore_password: str = "changeme_keystore"
    key_alias: str = "repokey"
    key_password: str = "changeme_key"
    key_dname: str = "CN=fdroid-store, OU=Self-hosted, O=Self, L=City, ST=State, C=US"

    # ----- Auth ---------------------------------------------------------------
    auth_methods: str = "local"  # comma-separated: local,oidc
    allow_signup: bool = True

    # OIDC
    oidc_issuer: str | None = None
    oidc_client_id: str | None = None
    oidc_client_secret: str | None = None
    oidc_scopes: str = "openid profile email"
    oidc_admin_claim: str | None = None  # "claim=value" → admin role when claim equals value

    # ----- CORS ---------------------------------------------------------------
    cors_origins: str = "http://localhost:3000"

    # ----- Misc ---------------------------------------------------------------
    log_level: str = "INFO"
    environment: Literal["development", "production", "test"] = "development"

    # ------------------------------------------------------------------
    # Computed / helpers
    # ------------------------------------------------------------------
    @property
    def auth_methods_list(self) -> list[str]:
        return [m.strip().lower() for m in self.auth_methods.split(",") if m.strip()]

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def oidc_enabled(self) -> bool:
        return (
            "oidc" in self.auth_methods_list
            and bool(self.oidc_issuer)
            and bool(self.oidc_client_id)
            and bool(self.oidc_client_secret)
        )

    @property
    def local_auth_enabled(self) -> bool:
        return "local" in self.auth_methods_list

    @field_validator("secret_key")
    @classmethod
    def _check_secret(cls, v: str) -> str:
        if v == "replace_with_a_long_random_string_at_least_64_chars_long":
            raise ValueError("SECRET_KEY must be set to a unique random value")
        return v


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


settings = get_settings()
