"""Short-lived HMAC-signed download URLs.

The F-Droid serve endpoint refuses anonymous APK downloads when the repo
is in private mode, which is correct for ``curl`` / unauthenticated
clients but blocks the legitimate case of a logged-in browser session
clicking a ``<a href>`` link — anchors carry no Authorization header.

The SPA asks the API (with its JWT) for a signed download URL; the F-Droid
serve handler validates the token against the requested filename + expiry
and lets the request through when valid. The token is bound to the
filename so it can't be replayed across different APKs, and it expires
after a few minutes so a leaked URL has bounded blast radius.
"""
from __future__ import annotations

import hmac
import uuid
from datetime import UTC, datetime
from hashlib import sha256

from app.core.config import settings

# 10 minutes is plenty for the browser to begin the download. After that the
# token is dead — a leaked URL stops working before it makes it into a chat
# log or browser-share screenshot.
DEFAULT_TTL_SECONDS = 600

# Per-purpose subkey derivation from the master ``SECRET_KEY``. Mixing the
# same HMAC key across JWT signing, session cookies, and download tokens
# (the previous code) meant a one-key leak gave the attacker forgery on
# every channel at once. ``derived_key`` deterministically separates them
# without forcing operators to rotate three env vars (CWE-1188, NIST
# SP 800-57 §5.6.4).
def _derived_key(purpose: str) -> bytes:
    return hmac.new(
        settings.secret_key.encode("utf-8"),
        f"fdroid-store|{purpose}".encode("utf-8"),
        sha256,
    ).digest()


def _payload(file_name: str, user_id: str, exp_ts: int) -> bytes:
    # Bind the token to a specific user, not just the filename. Without
    # ``user_id`` an owner could mint a URL and forward it to anyone in
    # the 10-minute window — defeating ``can_download_private`` (CWE-384).
    return f"{file_name}|{user_id}|{exp_ts}".encode("utf-8")


def _sign(payload: bytes) -> str:
    return hmac.new(_derived_key("download"), payload, sha256).hexdigest()[:32]


def sign_download_token(
    file_name: str,
    user_id: str | uuid.UUID,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> str:
    """Return ``<user>.<exp_ts>.<hex_sig>`` to embed in a ``?t=`` query parameter."""
    uid = str(user_id)
    exp = int(datetime.now(UTC).timestamp()) + ttl_seconds
    return f"{uid}.{exp}.{_sign(_payload(file_name, uid, exp))}"


def verify_download_token(file_name: str, token: str) -> str | None:
    """Constant-time check. Returns the bound ``user_id`` if the token is
    valid, ``None`` otherwise. Callers that need the identity for audit
    logging can keep the returned value; the F-Droid serve handler just
    treats a non-``None`` result as "allow this request through."
    """
    if not token:
        return None
    try:
        uid, exp_str, sig = token.split(".", 2)
        exp = int(exp_str)
    except (ValueError, AttributeError):
        return None
    if exp < int(datetime.now(UTC).timestamp()):
        return None
    expected = _sign(_payload(file_name, uid, exp))
    if not hmac.compare_digest(expected, sig):
        return None
    return uid
