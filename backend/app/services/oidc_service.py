"""OIDC integration via Authlib."""
from __future__ import annotations

from functools import lru_cache

from authlib.integrations.starlette_client import OAuth
from joserfc.jws import JWSRegistry

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)

if settings.oidc_enabled and not settings.oidc_require_email_verified:
    # Loud at boot. Surfacing this once per process restart catches
    # operators who flipped the toggle and forgot why — the takeover
    # vector this protects against is documented next to the env var
    # in core/config.py and at the gate site in api/v1/auth.py.
    log.warning(
        "OIDC email-verified gate is disabled "
        "(OIDC_REQUIRE_EMAIL_VERIFIED=false). "
        "Unverified IdP emails can now claim local accounts by email match."
    )

# Some OIDC providers (Defguard observed at 700+ bytes; Keycloak too when
# configured to include ``x5c`` cert chains in the ``kid``) ship ID-token
# JOSE headers that exceed joserfc's conservative 512-byte default. The
# resulting ``ExceededSizeError: Header size exceeds 512 bytes`` blocks
# the whole token-exchange path. Raising the cap to 8 KiB covers any
# realistic header layout including a full embedded JWK or a multi-cert
# x5c chain; the validation that matters (signature, claims) is unchanged.
JWSRegistry.max_header_length = 8 * 1024


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
