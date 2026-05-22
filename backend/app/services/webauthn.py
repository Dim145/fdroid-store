"""WebAuthn helpers — RP metadata, challenge minting, options generation.

The crypto is delegated to :mod:`webauthn` (py_webauthn / Duo Labs). This
module just wraps it with our settings + the JWT-backed challenge state
mechanism (no Redis dependency: the registration / assertion challenge is
embedded in a 5-minute JWT the client returns at verify time).

Glossary:
  - **RP ID**: the relying-party identifier, a domain name (no scheme,
    no port). Drawn from ``settings.public_app_url``.
  - **Origin**: the full URL of the page hosting the WebAuthn ceremony;
    the spec requires the assertion's ``clientDataJSON.origin`` to match.
  - **Challenge**: a server-minted random byte string the authenticator
    signs. Replayed challenges trivially break the protocol so they MUST
    be one-shot and short-lived.
"""
from __future__ import annotations

import base64
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlparse

import jwt as _jwt

from app.core.config import settings


# ---------------------------------------------------------------------------
# RP metadata
# ---------------------------------------------------------------------------
def rp_id() -> str:
    """The Relying Party identifier — the hostname the user's browser will
    see in its address bar when running the ceremony. The spec accepts
    suffix-compatible names (e.g. ``example.com`` covers
    ``a.example.com``) but the simplest, most-portable choice is the
    exact host. ``localhost`` is whitelisted by the spec for dev."""
    parsed = urlparse(settings.public_app_url)
    host = parsed.hostname or "localhost"
    return host


def rp_origin() -> str:
    """Full origin (``scheme://host[:port]``) used to validate the
    ``clientDataJSON.origin`` field returned by the authenticator. We
    derive it from the same setting that already underpins the auth
    cookie domain, so a misconfigured prod deployment surfaces here
    rather than at first-passkey time."""
    parsed = urlparse(settings.public_app_url)
    if not parsed.scheme or not parsed.netloc:
        return "http://localhost"
    return f"{parsed.scheme}://{parsed.netloc}"


def rp_name(repo_name: str | None) -> str:
    """Human-readable label the authenticator shows on enrolment
    (e.g. in the browser passkey picker UI). Falls back to a generic
    string when the repo hasn't picked a name yet."""
    return (repo_name or settings.repo_name or "fdroid-store").strip() or "fdroid-store"


# ---------------------------------------------------------------------------
# Challenge tokens
# ---------------------------------------------------------------------------
# We embed the challenge in a JWT so the verification leg of the ceremony
# stays stateless. The JWT carries:
#   - ``sub``       — user id for registration / MFA-step assertion,
#                     or empty string for passwordless assertion (where
#                     we don't know the user yet at /begin time).
#   - ``challenge`` — base64url of the random 32-byte challenge.
#   - ``purpose``   — discriminator so a registration-mode challenge can't
#                     be replayed against the assertion endpoint and vice
#                     versa.
#   - ``exp``       — 5 minutes after issue.
_TOKEN_TYPE = "webauthn_challenge"


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64u_decode(value: str) -> bytes:
    pad = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + pad)


def new_challenge() -> bytes:
    """32 cryptographically-random bytes. The spec recommends at least
    16; we use 32 to match the ``secrets`` module default for token
    helpers."""
    return secrets.token_bytes(32)


def mint_challenge_token(
    user_id: str,
    challenge: bytes,
    purpose: str,
    expires_minutes: int = 5,
) -> str:
    """Wrap a challenge in a short-lived JWT signed with the app secret.

    ``user_id`` may be the empty string for passwordless-assertion challenges
    (the user hasn't been identified yet at the /begin step). The verifier
    handles both cases.
    """
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": user_id,
        "challenge": _b64u(challenge),
        "purpose": purpose,
        "type": _TOKEN_TYPE,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=expires_minutes)).timestamp()),
    }
    return _jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)


def open_challenge_token(token: str, expected_purpose: str) -> tuple[str, bytes]:
    """Decode + validate a challenge token. Returns ``(user_id, challenge_bytes)``.

    Raises a plain :class:`ValueError` on any mismatch so the API layer
    can map it to a uniform 400. Be explicit about *why* the token failed
    only at log-level; the response message should stay generic so an
    attacker can't probe to learn whether their token was malformed vs.
    expired vs. wrong-purpose.
    """
    try:
        claims = _jwt.decode(
            token,
            settings.secret_key,
            algorithms=[settings.jwt_algorithm],
        )
    except Exception as exc:  # noqa: BLE001
        raise ValueError("challenge token invalid") from exc
    if claims.get("type") != _TOKEN_TYPE:
        raise ValueError("challenge token wrong type")
    if claims.get("purpose") != expected_purpose:
        raise ValueError("challenge token wrong purpose")
    challenge_b64 = claims.get("challenge")
    if not isinstance(challenge_b64, str):
        raise ValueError("challenge token missing challenge")
    user_id = claims.get("sub") or ""
    return user_id, _b64u_decode(challenge_b64)


# ---------------------------------------------------------------------------
# Force-policy
# ---------------------------------------------------------------------------
def role_requires_passkey(role: str, repo_admin: bool, repo_uploader: bool) -> bool:
    """Resolve whether the given user role is currently under a force-passkey
    policy. ``repo_admin`` / ``repo_uploader`` are the two toggles on
    RepoConfig. User-tier accounts are never forced — they can register
    a passkey voluntarily but the policy doesn't gate them.

    Accepts either ``UserRole.value`` (lowercase ``"admin"``) or the
    enum's name (``"ADMIN"``) so callers don't have to be cute about
    which one they pass.
    """
    normalised = (role or "").lower()
    if normalised == "admin" and repo_admin:
        return True
    if normalised == "uploader" and repo_uploader:  # noqa: SIM103
        return True
    return False


# ---------------------------------------------------------------------------
# Purpose constants
# ---------------------------------------------------------------------------
PURPOSE_REGISTRATION = "registration"
PURPOSE_AUTHENTICATION = "authentication"
PURPOSE_MFA = "mfa"
