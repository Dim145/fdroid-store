"""OIDC integration via Authlib."""
from __future__ import annotations

from functools import lru_cache

from authlib.integrations.starlette_client import OAuth

from app.core.config import settings


@lru_cache(maxsize=1)
def get_oauth() -> OAuth | None:
    """Return a configured Authlib OAuth instance, or None if OIDC is disabled."""
    if not settings.oidc_enabled:
        return None
    oauth = OAuth()
    oauth.register(
        name="oidc",
        server_metadata_url=f"{settings.oidc_issuer.rstrip('/')}/.well-known/openid-configuration",
        client_id=settings.oidc_client_id,
        client_secret=settings.oidc_client_secret,
        client_kwargs={"scope": settings.oidc_scopes},
    )
    return oauth


def claim_indicates_admin(userinfo: dict) -> bool:
    """Apply the OIDC_ADMIN_CLAIM mapping, if configured.

    Format: ``claim=value``. The user is admin when the claim is the given
    string OR a list containing that string. Useful with Keycloak groups.
    """
    raw = (settings.oidc_admin_claim or "").strip()
    if not raw or "=" not in raw:
        return False
    claim, expected = raw.split("=", 1)
    claim = claim.strip()
    expected = expected.strip()
    if not claim:
        return False
    value = userinfo.get(claim)
    if value is None:
        return False
    if isinstance(value, list):
        return expected in value
    return str(value) == expected
