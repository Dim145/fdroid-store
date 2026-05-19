"""Application settings loaded from environment variables.

A single ``settings`` instance is exposed at module import time and reused
throughout the app. All env vars documented in ``.env.example``.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Default credentials shipped in the repo. Production deployments MUST
# override these; the model validator below refuses to start otherwise.
_INSECURE_DEFAULTS = {
    "initial_admin_password": "changeme_admin",
    "keystore_password": "changeme_keystore",
    "key_password": "changeme_key",
}


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

    # ----- Reverse-proxy trust --------------------------------------------
    # When True, ``X-Forwarded-For`` is read for rate-limit key derivation
    # (so an entire network doesn't share one bucket because every
    # request looks like it came from the nginx container). MUST stay
    # False if the API is exposed directly to the internet without a
    # trusted proxy in front — otherwise a client can spoof their IP.
    trust_forwarded_headers: bool = True

    # ----- ClamAV (optional malware scanning) -------------------------------
    # When set, the backend exposes the "Malware scanning" section in the
    # admin panel and the worker is allowed to run periodic rescans. The
    # value is the ``host:port`` of a clamd-protocol server reachable from
    # both the backend and the worker containers. Empty → feature disabled.
    clamav_host: str | None = None
    clamav_port: int = 3310
    # Hard limit on the bytes the scanner will read before bailing. clamd's
    # default StreamMaxLength is 25 MB; we mirror that here so a 200 MB APK
    # doesn't hang the scanner thread.
    clamav_max_stream_mb: int = 100

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

    @property
    def clamav_available(self) -> bool:
        """True when an operator has wired a clamd endpoint in. Drives the
        admin UI toggle and gates the scan code paths."""
        return bool(self.clamav_host)

    @field_validator("secret_key")
    @classmethod
    def _check_secret(cls, v: str) -> str:
        if v == "replace_with_a_long_random_string_at_least_64_chars_long":
            raise ValueError("SECRET_KEY must be set to a unique random value")
        return v

    @field_validator("cors_origins")
    @classmethod
    def _check_cors_origins(cls, v: str) -> str:
        # ``CORS_ORIGINS="*"`` paired with ``allow_credentials=True`` (which we
        # hard-code in main.py) is a known footgun: the browser blocks the
        # literal star but the laxer reflective behaviour of some middleware
        # versions still echoes the request origin back. Refuse the
        # combination outright.
        if any(o.strip() == "*" for o in v.split(",")):
            raise ValueError(
                "CORS_ORIGINS=\"*\" is not allowed when credentials are enabled; "
                "list explicit origins instead.",
            )
        return v

    @field_validator("oidc_issuer")
    @classmethod
    def _check_oidc_issuer(cls, v: str | None) -> str | None:
        # OIDC discovery + token exchange MUST happen over HTTPS. We allow
        # ``http://localhost`` for development convenience but block any
        # other plain-HTTP issuer.
        if v is None or v == "":
            return v
        lowered = v.lower()
        if lowered.startswith("https://"):
            return v
        if lowered.startswith("http://localhost") or lowered.startswith("http://127.0.0.1"):
            return v
        raise ValueError("OIDC_ISSUER must be served over HTTPS (or localhost for dev)")

    @model_validator(mode="after")
    def _refuse_insecure_defaults(self) -> "Settings":
        # Refuse the ``changeme_*`` defaults in production. Development
        # deployments are still allowed to boot with them so local
        # ``docker compose up`` keeps working; the stdout warning makes
        # the trade-off loud enough that a careless promote-to-prod
        # gets caught before the backend touches the internet. (CWE-798)
        leftovers = [
            name for name, default in _INSECURE_DEFAULTS.items()
            if getattr(self, name) == default
        ]
        if not leftovers:
            return self
        if self.environment == "production":
            raise ValueError(
                "Refusing to start in production with the shipped default "
                f"credentials: {', '.join(leftovers)}. Override them in .env."
            )
        # Dev / test: don't block, but print a clearly-flagged warning.
        import sys as _sys
        print(
            "[fdroid-store] WARNING: running with default credentials "
            f"({', '.join(leftovers)}). Override before exposing the port.",
            file=_sys.stderr,
            flush=True,
        )
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


settings = get_settings()
