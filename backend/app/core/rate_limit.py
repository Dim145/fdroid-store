"""Per-IP rate limiting for the auth endpoints.

Used to throttle login / signup / refresh / OIDC callback so an attacker
can't credential-stuff at the speed of the argon2 verify. Default storage
is in-process; for multi-worker deployments the operator can configure a
Redis-backed limiter via ``RATE_LIMIT_STORAGE_URI``.

Limits are deliberately conservative:
  * Login / refresh / signup: 5 requests / minute / IP. Burst of 5 covers
    legitimate UX (mistyped password, retry on flaky network); attacker
    is throttled to ~7 200 tries / day even with IP rotation budget.
  * Invite code probe (``POST /auth/signup``): same bucket.
"""
from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address

from app.core.config import settings

# ``key_func`` here looks at ``request.client.host`` by default. In a
# reverse-proxy deployment that resolves to the nginx host IP for every
# request; the nginx config sets ``X-Forwarded-For`` so we use that when
# the trust list is configured.
def _client_key(request) -> str:
    if settings.trust_forwarded_headers:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            # First entry is the original client; nginx appends $remote_addr
            # so the chain is "<client>, <proxy>".
            return fwd.split(",")[0].strip()
    return get_remote_address(request)


limiter = Limiter(
    key_func=_client_key,
    default_limits=[],  # No default — apply explicit limits per route.
    # ``headers_enabled=True`` would require every decorated handler to
    # declare a ``response: Response`` parameter for slowapi to inject the
    # ``RateLimit-*`` headers. The middleware emits a 429 with a clear
    # body either way, so we skip the header injection to keep the route
    # signatures uncluttered.
    headers_enabled=False,
)
