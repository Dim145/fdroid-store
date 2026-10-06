"""The client's IP address — one definition for rate limits, session rows,
audit rows and download stats."""
from __future__ import annotations

import hashlib
import hmac

from starlette.requests import Request

from app.core.config import settings

# HMAC key for stored IP fingerprints: a bare SHA-256 of an IPv4 address is
# reversed by hashing all 2^32 candidates.
_IP_KEY = hashlib.sha256(b"fdroid-store/ip-fingerprint/v1:" + settings.secret_key.encode()).digest()


def client_ip(request: Request) -> str | None:
    """First ``X-Forwarded-For`` hop when the deployment trusts its proxy
    (the bundled nginx overwrites the header with the address it saw), else
    the socket peer."""
    if settings.trust_forwarded_headers:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            first = fwd.split(",")[0].strip()
            if first:
                return first
    return request.client.host if request.client else None


def hash_ip(ip: str | None) -> str | None:
    """Keyed fingerprint stored instead of the address (never the raw IP)."""
    if not ip:
        return None
    return hmac.new(_IP_KEY, ip.encode("utf-8"), hashlib.sha256).hexdigest()
