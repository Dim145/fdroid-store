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


# --------------------------------------------------------------------------
# Media tokens
# --------------------------------------------------------------------------
# Private-app media (icons, screenshots, feature/promo/tv graphics) face the
# same problem as APK downloads: ``<img src>`` carries no Authorization
# header, so the logged-in SPA owner can't render their own private app's
# images. Mirror the APK signed-URL pattern, but bind the token to the
# **package name** instead of an individual filename — one token covers all
# the assets of one app for the SPA's session, so we don't have to mint a
# new URL per image.
#
# Token format / key derivation match the download path, except the HMAC
# subkey is ``media`` (separate purpose, per the same CWE-1188 hygiene).
_MEDIA_DEFAULT_TTL = 3600  # one hour — comfortable for a page sit


def _sign_media(payload: bytes) -> str:
    return hmac.new(_derived_key("media"), payload, sha256).hexdigest()[:32]


def _media_payload(package_name: str, user_id: str, exp_ts: int) -> bytes:
    return f"{package_name}|{user_id}|{exp_ts}".encode("utf-8")


def sign_media_token(
    package_name: str,
    user_id: str | uuid.UUID,
    ttl_seconds: int = _MEDIA_DEFAULT_TTL,
) -> str:
    """Mint a ``?t=`` token that unlocks every media URL under ``<package>/``."""
    uid = str(user_id)
    exp = int(datetime.now(UTC).timestamp()) + ttl_seconds
    return f"{uid}.{exp}.{_sign_media(_media_payload(package_name, uid, exp))}"


def verify_media_token(package_name: str, token: str) -> str | None:
    """Constant-time check bound to a package. Returns the user_id if valid."""
    if not token:
        return None
    try:
        uid, exp_str, sig = token.split(".", 2)
        exp = int(exp_str)
    except (ValueError, AttributeError):
        return None
    if exp < int(datetime.now(UTC).timestamp()):
        return None
    expected = _sign_media(_media_payload(package_name, uid, exp))
    if not hmac.compare_digest(expected, sig):
        return None
    return uid


# --------------------------------------------------------------------------
# Staging tokens
# --------------------------------------------------------------------------
# The new-app + new-APK flows used to upload the file twice: once for
# ``/apks/inspect`` (parse metadata, throw the bytes away) and once
# for the final ``/apps/with-apk`` (parse again, persist). For a 200 MB
# APK over a slow link that's 5+ minutes of double upload.
#
# Staging tokens fix that: ``inspect_apk`` parks the bytes under
# ``staging/<sha256>.apk`` in the storage backend, returns a token
# bound to (sha256, user_id, exp). The follow-up "create app from
# staging" / "add APK from staging" endpoints redeem the token,
# fetch the bytes back from staging, and skip the upload entirely.
#
# Subkey ``staging`` keeps the HMAC separated from the other token
# purposes (same CWE-1188 hygiene as the rest of this module).
_STAGING_DEFAULT_TTL = 3600  # one hour — plenty for filling the form


def _sign_staging(payload: bytes) -> str:
    return hmac.new(_derived_key("staging"), payload, sha256).hexdigest()[:32]


def _staging_payload(content_hash: str, user_id: str, exp_ts: int) -> bytes:
    return f"{content_hash}|{user_id}|{exp_ts}".encode("utf-8")


def sign_staging_token(
    content_hash: str,
    user_id: str | uuid.UUID,
    ttl_seconds: int = _STAGING_DEFAULT_TTL,
) -> str:
    """Mint a token redeemable for the staged APK at ``staging/<content_hash>.apk``.

    Format ``<sha>.<user>.<exp>.<sig>`` — same layout as the other tokens
    in this module but with the content hash up front so the redemption
    handler can derive the storage key without trusting the caller.
    """
    uid = str(user_id)
    exp = int(datetime.now(UTC).timestamp()) + ttl_seconds
    return f"{content_hash}.{uid}.{exp}.{_sign_staging(_staging_payload(content_hash, uid, exp))}"


def verify_staging_token(token: str, user_id: str | uuid.UUID) -> str | None:
    """Returns the bound content_hash when the token is valid for this user.

    Refuses tokens that aren't bound to ``user_id`` — even if signed
    correctly — so a leaked token can't be redeemed by anyone else.
    """
    if not token:
        return None
    try:
        content_hash, uid, exp_str, sig = token.split(".", 3)
        exp = int(exp_str)
    except (ValueError, AttributeError):
        return None
    if uid != str(user_id):
        return None
    if exp < int(datetime.now(UTC).timestamp()):
        return None
    expected = _sign_staging(_staging_payload(content_hash, uid, exp))
    if not hmac.compare_digest(expected, sig):
        return None
    return content_hash
