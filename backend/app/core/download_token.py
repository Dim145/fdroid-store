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
from datetime import UTC, datetime
from hashlib import sha256

from app.core.config import settings

# 10 minutes is plenty for the browser to begin the download. After that the
# token is dead — a leaked URL stops working before it makes it into a chat
# log or browser-share screenshot.
DEFAULT_TTL_SECONDS = 600


def _payload(file_name: str, exp_ts: int) -> bytes:
    return f"{file_name}|{exp_ts}".encode("utf-8")


def _sign(payload: bytes) -> str:
    return hmac.new(
        settings.secret_key.encode("utf-8"), payload, sha256,
    ).hexdigest()[:32]


def sign_download_token(file_name: str, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> str:
    """Return ``<exp_ts>.<hex_sig>`` to embed in a ``?t=`` query parameter."""
    exp = int(datetime.now(UTC).timestamp()) + ttl_seconds
    return f"{exp}.{_sign(_payload(file_name, exp))}"


def verify_download_token(file_name: str, token: str) -> bool:
    """Constant-time check that the token covers ``file_name`` and is unexpired."""
    if not token:
        return False
    try:
        exp_str, sig = token.split(".", 1)
        exp = int(exp_str)
    except (ValueError, AttributeError):
        return False
    if exp < int(datetime.now(UTC).timestamp()):
        return False
    expected = _sign(_payload(file_name, exp))
    return hmac.compare_digest(expected, sig)
