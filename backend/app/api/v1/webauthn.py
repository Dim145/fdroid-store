"""WebAuthn / passkey endpoints.

Two routers are exposed:

* :data:`me_router` (mounted at ``/me/webauthn``) — credential management
  for the authenticated user: register a new passkey, list registered
  passkeys, revoke one.

* :data:`auth_router` (mounted at ``/auth/webauthn``) — login ceremonies
  that don't require an active session yet:

  - ``/auth/webauthn/login/begin`` + ``/finish`` — passwordless sign-in
    starting from an email or username.
  - ``/auth/webauthn/mfa/begin`` + ``/finish`` — second-factor step
    initiated by a ``mfa_token`` returned from ``/auth/login`` when the
    account has at least one registered passkey.
  - ``/auth/webauthn/enroll/begin`` + ``/finish`` — forced enrolment for
    accounts whose role is under a passkey-required policy but who
    haven't enrolled one yet. The ``enrollment_token`` is minted by
    ``/auth/login`` in that case.

The crypto is delegated to :mod:`webauthn`; we just bind the options +
verify the assertion against the credential rows in the DB.
"""
from __future__ import annotations

import base64
import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers.cose import COSEAlgorithmIdentifier
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from app.api.deps import DbSession, get_current_user
from app.core.config import settings
from app.core.rate_limit import limiter
from app.core.security import decode_token
from app.models.repo_config import RepoConfig
from app.models.user import User, UserRole
from app.models.webauthn_credential import WebAuthnCredential
from app.services.audit import write_event
from app.services.auth_service import issue_tokens_for_user
from app.services.webauthn import (
    PURPOSE_AUTHENTICATION,
    PURPOSE_MFA,
    PURPOSE_REGISTRATION,
    mint_challenge_token,
    new_challenge,
    open_challenge_token,
    role_requires_passkey,
    rp_id,
    rp_name,
    rp_origin,
)

logger = logging.getLogger(__name__)

me_router = APIRouter()
auth_router = APIRouter()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class _CredentialSummary(BaseModel):
    id: str
    label: str
    created_at: str
    last_used_at: str | None = None
    transports: list[str] = Field(default_factory=list)


class CredentialList(BaseModel):
    items: list[_CredentialSummary]


class RegisterBeginRequest(BaseModel):
    """Caller picks a friendly label for the new credential up front.
    Stored verbatim and shown in the /account list."""

    label: str = Field(min_length=1, max_length=100)


class RegisterBeginResponse(BaseModel):
    challenge_token: str
    options: dict[str, Any]


class RegisterFinishRequest(BaseModel):
    challenge_token: str
    # Full ``PublicKeyCredential`` returned by ``navigator.credentials.create``.
    # We forward it to py_webauthn untouched.
    credential: dict[str, Any]


class LoginBeginRequest(BaseModel):
    """``identifier`` accepts either the user's email or their username; we
    look up both. Returns assertion options + a challenge token. Note:
    the response is the same shape whether the account exists or not —
    we don't want to leak account presence at this step. The shape with
    an empty ``allowCredentials`` covers the no-user / no-credentials
    case."""

    identifier: str = Field(min_length=1, max_length=320)


class LoginFinishRequest(BaseModel):
    challenge_token: str
    credential: dict[str, Any]


class MfaBeginRequest(BaseModel):
    mfa_token: str


class MfaFinishRequest(BaseModel):
    mfa_token: str
    challenge_token: str
    credential: dict[str, Any]


class EnrollBeginRequest(BaseModel):
    enrollment_token: str
    label: str = Field(min_length=1, max_length=100)


class EnrollFinishRequest(BaseModel):
    enrollment_token: str
    challenge_token: str
    credential: dict[str, Any]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _options_to_json_dict(options: Any) -> dict[str, Any]:
    """py_webauthn returns dataclasses; the browser expects base64url-encoded
    bytes. Use the lib's options_to_json then parse it back so the dict is
    JSON-clean (no bytes objects leaking into FastAPI's serializer)."""
    from webauthn.helpers import options_to_json

    return json.loads(options_to_json(options))


async def _repo(db: Any) -> RepoConfig | None:
    return (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()


def _resolve_repo_name(repo: RepoConfig | None) -> str:
    return rp_name(repo.name if repo else None)


def _serialize_credential(cred: WebAuthnCredential) -> _CredentialSummary:
    return _CredentialSummary(
        id=str(cred.id),
        label=cred.label,
        created_at=cred.created_at.isoformat(),
        last_used_at=cred.last_used_at.isoformat() if cred.last_used_at else None,
        transports=json.loads(cred.transports_json or "[]"),
    )


async def _user_credentials(db: Any, user_id: uuid.UUID) -> list[WebAuthnCredential]:
    rows = (
        await db.execute(
            select(WebAuthnCredential)
            .where(WebAuthnCredential.user_id == user_id)
            .order_by(WebAuthnCredential.created_at.asc())
        )
    ).scalars().all()
    return list(rows)


# ---------------------------------------------------------------------------
# /me/webauthn — credential management
# ---------------------------------------------------------------------------
@me_router.get("/credentials", response_model=CredentialList)
async def list_credentials(
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
) -> CredentialList:
    creds = await _user_credentials(db, user.id)
    return CredentialList(items=[_serialize_credential(c) for c in creds])


@me_router.post("/register/begin", response_model=RegisterBeginResponse)
async def register_begin(
    payload: RegisterBeginRequest,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
) -> RegisterBeginResponse:
    repo = await _repo(db)
    existing = await _user_credentials(db, user.id)
    # ``excludeCredentials`` stops the same physical authenticator being
    # double-enrolled to the same account — the browser will skip those
    # in the picker UI.
    exclude = [
        PublicKeyCredentialDescriptor(id=c.credential_id) for c in existing
    ]
    challenge = new_challenge()
    options = generate_registration_options(
        rp_id=rp_id(),
        rp_name=_resolve_repo_name(repo),
        user_id=user.id.bytes,
        user_name=user.username,
        user_display_name=user.full_name or user.username,
        challenge=challenge,
        # Both platform (Touch ID, Windows Hello) and roaming (YubiKey)
        # are acceptable; we leave the choice to the browser. UV is
        # preferred but not required — some platform authenticators
        # can't enforce it without an extra prompt.
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.PREFERRED,
        ),
        exclude_credentials=exclude,
        # The spec defaults are fine but enumerating them keeps the
        # admin-visible attestation format stable across py_webauthn
        # releases.
        supported_pub_key_algs=[
            COSEAlgorithmIdentifier.ECDSA_SHA_256,
            COSEAlgorithmIdentifier.RSASSA_PKCS1_v1_5_SHA_256,
        ],
    )
    token = mint_challenge_token(str(user.id), challenge, PURPOSE_REGISTRATION)
    return RegisterBeginResponse(
        challenge_token=token,
        options=_options_to_json_dict(options),
    )


@me_router.post("/register/finish", response_model=_CredentialSummary)
async def register_finish(
    payload: RegisterFinishRequest,
    db: DbSession,
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
) -> _CredentialSummary:
    try:
        sub, challenge = open_challenge_token(
            payload.challenge_token, PURPOSE_REGISTRATION
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid challenge") from exc
    if sub != str(user.id):
        raise HTTPException(status_code=400, detail="Challenge / user mismatch")

    label = (payload.credential.pop("__label__", None)
             if isinstance(payload.credential, dict) else None)
    # Re-derive label from the begin step. The frontend MUST pass it via
    # a separate /register/begin call; we don't trust the credential
    # blob's contents.
    if not label:
        # Fall back to a generic label if the client forgot.
        label = "Passkey"

    try:
        verification = verify_registration_response(
            credential=payload.credential,
            expected_challenge=challenge,
            expected_origin=rp_origin(),
            expected_rp_id=rp_id(),
            require_user_verification=False,
        )
    except Exception as exc:  # noqa: BLE001
        logger.info("webauthn register verify failed", extra={"error": str(exc)})
        raise HTTPException(status_code=400, detail="Verification failed") from exc

    transports = []
    raw_transports = payload.credential.get("response", {}).get("transports")
    if isinstance(raw_transports, list):
        transports = [str(t) for t in raw_transports if isinstance(t, str)]

    cred = WebAuthnCredential(
        user_id=user.id,
        credential_id=verification.credential_id,
        public_key=verification.credential_public_key,
        sign_count=verification.sign_count,
        transports_json=json.dumps(transports),
        label=label,
    )
    db.add(cred)
    await write_event(
        db,
        action="webauthn.registered",
        actor=user,
        target_type="webauthn_credential",
        target_id=cred.id,
        summary=f"passkey '{label}' enrolled",
        payload={"label": label, "transports": transports},
    )
    await db.commit()
    await db.refresh(cred)
    return _serialize_credential(cred)


@me_router.delete("/credentials/{credential_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_credential(
    credential_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
) -> None:
    cred = (
        await db.execute(
            select(WebAuthnCredential).where(
                WebAuthnCredential.id == credential_id,
                WebAuthnCredential.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if cred is None:
        raise HTTPException(status_code=404, detail="Credential not found")
    label = cred.label
    await db.delete(cred)
    await write_event(
        db,
        action="webauthn.revoked",
        actor=user,
        target_type="webauthn_credential",
        target_id=credential_id,
        summary=f"passkey '{label}' revoked",
        payload={"label": label},
    )
    await db.commit()


# ---------------------------------------------------------------------------
# /auth/webauthn — passwordless login + MFA + forced enrolment
# ---------------------------------------------------------------------------
def _request_meta(request: Request) -> tuple[str | None, str | None]:
    """Hash IP + truncate UA the same way :mod:`auth` does. Inlined to
    avoid importing auth.py (which imports us, eventually)."""
    import hashlib

    fwd = request.headers.get("x-forwarded-for")
    ip = fwd.split(",", 1)[0].strip() if fwd else (
        request.client.host if request.client else None
    )
    ip_hash = hashlib.sha256(ip.encode("utf-8")).hexdigest() if ip else None
    ua = request.headers.get("user-agent")
    ua = ua[:255] if ua else None
    return ip_hash, ua


async def _lookup_user_by_identifier(db: Any, identifier: str) -> User | None:
    """Email or username, case-insensitive on email (RFC 5321 local-parts
    are case-sensitive in theory but no real-world mail server enforces it)."""
    normalised = identifier.strip()
    row = (
        await db.execute(
            select(User).where(
                (User.email == normalised.lower()) | (User.username == normalised)
            )
        )
    ).scalar_one_or_none()
    return row


async def _build_assertion_options(
    db: Any, user: User | None
) -> tuple[bytes, dict[str, Any]]:
    """Generate the assertion options for a user. When ``user`` is ``None``
    we still return a valid options object with an empty
    ``allowCredentials`` list — this makes the response shape stable
    whether the identifier matches an existing account or not, so an
    attacker can't probe for usernames."""
    challenge = new_challenge()
    allow_credentials: list[PublicKeyCredentialDescriptor] = []
    if user is not None:
        creds = await _user_credentials(db, user.id)
        allow_credentials = [
            PublicKeyCredentialDescriptor(id=c.credential_id) for c in creds
        ]
    options = generate_authentication_options(
        rp_id=rp_id(),
        challenge=challenge,
        allow_credentials=allow_credentials,
        user_verification=UserVerificationRequirement.PREFERRED,
    )
    return challenge, _options_to_json_dict(options)


async def _verify_assertion(
    db: Any,
    user: User,
    expected_challenge: bytes,
    credential_payload: dict[str, Any],
) -> WebAuthnCredential:
    """Look the credential up by raw-id, run py_webauthn's verification,
    bump the sign-count + last-used-at on success. Raises HTTPException
    on any failure."""
    raw_id_b64 = credential_payload.get("rawId") or credential_payload.get("id")
    if not isinstance(raw_id_b64, str):
        raise HTTPException(status_code=400, detail="Missing credential id")
    try:
        pad = "=" * (-len(raw_id_b64) % 4)
        credential_id = base64.urlsafe_b64decode(raw_id_b64 + pad)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Invalid credential id") from exc

    cred = (
        await db.execute(
            select(WebAuthnCredential).where(
                WebAuthnCredential.credential_id == credential_id,
                WebAuthnCredential.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if cred is None:
        raise HTTPException(status_code=400, detail="Unknown credential")

    try:
        verification = verify_authentication_response(
            credential=credential_payload,
            expected_challenge=expected_challenge,
            expected_rp_id=rp_id(),
            expected_origin=rp_origin(),
            credential_public_key=cred.public_key,
            credential_current_sign_count=cred.sign_count,
            require_user_verification=False,
        )
    except Exception as exc:  # noqa: BLE001
        logger.info("webauthn assertion failed", extra={"error": str(exc)})
        raise HTTPException(status_code=400, detail="Verification failed") from exc

    cred.sign_count = verification.new_sign_count
    cred.last_used_at = datetime.now(UTC)
    return cred


@auth_router.post("/login/begin", response_model=RegisterBeginResponse)
@limiter.limit("10/minute")
async def passwordless_begin(
    request: Request,
    payload: LoginBeginRequest,
    db: DbSession,
) -> RegisterBeginResponse:
    """Step 1 of passwordless: caller submits their identifier; we return
    assertion options. The challenge token carries the resolved user id
    (or empty when the identifier matched nothing — the /finish step
    will then reject as usual)."""
    user = await _lookup_user_by_identifier(db, payload.identifier)
    challenge, options_dict = await _build_assertion_options(db, user)
    user_sub = str(user.id) if user is not None else ""
    token = mint_challenge_token(user_sub, challenge, PURPOSE_AUTHENTICATION)
    return RegisterBeginResponse(challenge_token=token, options=options_dict)


@auth_router.post("/login/finish")
@limiter.limit("10/minute")
async def passwordless_finish(
    request: Request,
    payload: LoginFinishRequest,
    db: DbSession,
):
    """Step 2 of passwordless: verify the assertion + mint a token pair."""
    try:
        sub, challenge = open_challenge_token(
            payload.challenge_token, PURPOSE_AUTHENTICATION
        )
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid challenge") from exc
    if not sub:
        # The /begin step matched no account. Use a generic message to
        # avoid leaking the account-presence oracle.
        raise HTTPException(status_code=401, detail="Authentication failed")
    try:
        user_id = uuid.UUID(sub)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid challenge") from exc
    user = (
        await db.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Account unavailable")

    await _verify_assertion(db, user, challenge, payload.credential)
    await write_event(
        db,
        action="webauthn.login",
        actor=user,
        target_type="user",
        target_id=user.id,
        summary="passwordless login",
        payload={"method": "webauthn"},
    )
    access, refresh = await issue_tokens_for_user(
        db, user, request_meta=_request_meta(request)
    )
    return {
        "access_token": access,
        "refresh_token": refresh,
        "token_type": "bearer",
        "expires_in": settings.access_token_expire_minutes * 60,
    }


@auth_router.post("/mfa/begin", response_model=RegisterBeginResponse)
async def mfa_begin(
    payload: MfaBeginRequest,
    db: DbSession,
) -> RegisterBeginResponse:
    """Step 1 of the passkey MFA flow: the caller already passed the
    password step and holds an ``mfa_token`` from /auth/login. Returns
    assertion options for that specific user."""
    try:
        claims = decode_token(payload.mfa_token)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=401, detail="Invalid MFA token") from exc
    if claims.get("type") != "mfa_challenge":
        raise HTTPException(status_code=401, detail="Not an MFA challenge token")
    sub = claims.get("sub")
    try:
        user_id = uuid.UUID(sub) if sub else None
    except ValueError:
        user_id = None
    if user_id is None:
        raise HTTPException(status_code=401, detail="Invalid challenge")
    user = (
        await db.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Account unavailable")
    challenge, options_dict = await _build_assertion_options(db, user)
    token = mint_challenge_token(str(user.id), challenge, PURPOSE_MFA)
    return RegisterBeginResponse(challenge_token=token, options=options_dict)


@auth_router.post("/mfa/finish")
async def mfa_finish(
    payload: MfaFinishRequest,
    request: Request,
    db: DbSession,
):
    """Step 2 of the passkey MFA flow: verify the assertion against the
    user resolved from the MFA token, then mint a real token pair."""
    try:
        claims = decode_token(payload.mfa_token)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=401, detail="Invalid MFA token") from exc
    if claims.get("type") != "mfa_challenge":
        raise HTTPException(status_code=401, detail="Not an MFA challenge token")
    sub = claims.get("sub")
    try:
        user_id = uuid.UUID(sub) if sub else None
    except ValueError:
        user_id = None
    if user_id is None:
        raise HTTPException(status_code=401, detail="Invalid challenge")
    user = (
        await db.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Account unavailable")

    try:
        challenge_user_sub, challenge = open_challenge_token(
            payload.challenge_token, PURPOSE_MFA
        )
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid challenge") from exc
    if challenge_user_sub != str(user.id):
        raise HTTPException(status_code=401, detail="Challenge / user mismatch")

    await _verify_assertion(db, user, challenge, payload.credential)
    await write_event(
        db,
        action="webauthn.mfa",
        actor=user,
        target_type="user",
        target_id=user.id,
        summary="passkey MFA accepted",
        payload={"method": "webauthn"},
    )
    access, refresh = await issue_tokens_for_user(
        db, user, request_meta=_request_meta(request)
    )
    return {
        "access_token": access,
        "refresh_token": refresh,
        "token_type": "bearer",
        "expires_in": settings.access_token_expire_minutes * 60,
    }


# Forced enrolment: a separate token type ``enrollment_required`` carries
# the user id. The login endpoint issues it when policy requires a passkey
# but the account has none. The token is single-use in spirit (we don't
# track it server-side, but it's discarded after the /finish step mints
# real tokens) and has the same 5-minute lifetime as the MFA challenge.
def _open_enrollment_token(token: str) -> uuid.UUID:
    try:
        claims = decode_token(token)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=401, detail="Invalid enrolment token") from exc
    if claims.get("type") != "webauthn_enrollment":
        raise HTTPException(status_code=401, detail="Not an enrolment token")
    sub = claims.get("sub")
    try:
        return uuid.UUID(sub) if sub else uuid.UUID(int=0)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid enrolment token") from exc


@auth_router.post("/enroll/begin", response_model=RegisterBeginResponse)
async def enroll_begin(
    payload: EnrollBeginRequest,
    db: DbSession,
) -> RegisterBeginResponse:
    user_id = _open_enrollment_token(payload.enrollment_token)
    user = (
        await db.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Account unavailable")
    repo = await _repo(db)
    existing = await _user_credentials(db, user.id)
    exclude = [PublicKeyCredentialDescriptor(id=c.credential_id) for c in existing]
    challenge = new_challenge()
    options = generate_registration_options(
        rp_id=rp_id(),
        rp_name=_resolve_repo_name(repo),
        user_id=user.id.bytes,
        user_name=user.username,
        user_display_name=user.full_name or user.username,
        challenge=challenge,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.PREFERRED,
        ),
        exclude_credentials=exclude,
        supported_pub_key_algs=[
            COSEAlgorithmIdentifier.ECDSA_SHA_256,
            COSEAlgorithmIdentifier.RSASSA_PKCS1_v1_5_SHA_256,
        ],
    )
    token = mint_challenge_token(str(user.id), challenge, PURPOSE_REGISTRATION)
    return RegisterBeginResponse(
        challenge_token=token,
        options=_options_to_json_dict(options),
    )


@auth_router.post("/enroll/finish")
async def enroll_finish(
    payload: EnrollFinishRequest,
    request: Request,
    db: DbSession,
):
    user_id = _open_enrollment_token(payload.enrollment_token)
    user = (
        await db.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Account unavailable")

    try:
        challenge_sub, challenge = open_challenge_token(
            payload.challenge_token, PURPOSE_REGISTRATION
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid challenge") from exc
    if challenge_sub != str(user.id):
        raise HTTPException(status_code=400, detail="Challenge / user mismatch")

    label_raw = payload.credential.get("__label__") if isinstance(payload.credential, dict) else None
    # The enrolment flow gets its label off ``payload`` (we don't store it
    # on the begin step — the token is meant to be lightweight). Caller
    # sends the chosen label via ``__label__`` in the credential blob.
    label = label_raw if isinstance(label_raw, str) and label_raw.strip() else "Passkey"
    label = label[:100]

    try:
        verification = verify_registration_response(
            credential=payload.credential,
            expected_challenge=challenge,
            expected_origin=rp_origin(),
            expected_rp_id=rp_id(),
            require_user_verification=False,
        )
    except Exception as exc:  # noqa: BLE001
        logger.info("webauthn enroll verify failed", extra={"error": str(exc)})
        raise HTTPException(status_code=400, detail="Verification failed") from exc

    transports = []
    raw_transports = payload.credential.get("response", {}).get("transports")
    if isinstance(raw_transports, list):
        transports = [str(t) for t in raw_transports if isinstance(t, str)]

    cred = WebAuthnCredential(
        user_id=user.id,
        credential_id=verification.credential_id,
        public_key=verification.credential_public_key,
        sign_count=verification.sign_count,
        transports_json=json.dumps(transports),
        label=label,
    )
    db.add(cred)
    await write_event(
        db,
        action="webauthn.enrolled_forced",
        actor=user,
        target_type="webauthn_credential",
        target_id=cred.id,
        summary=f"passkey '{label}' enrolled via forced flow",
        payload={"label": label, "transports": transports, "role": user.role.value},
    )
    # Mint real tokens — the user is now logged in.
    access, refresh = await issue_tokens_for_user(
        db, user, request_meta=_request_meta(request)
    )
    await db.commit()
    return {
        "access_token": access,
        "refresh_token": refresh,
        "token_type": "bearer",
        "expires_in": settings.access_token_expire_minutes * 60,
    }


# ---------------------------------------------------------------------------
# Helper for /auth/login — exported so auth.py can decide whether to send
# the user down the passkey path.
# ---------------------------------------------------------------------------
async def passkey_login_state(
    db: Any, user: User, repo: RepoConfig | None
) -> dict[str, Any]:
    """Inspect the user's passkey enrolment + the repo's force-policy to
    tell the login endpoint what to do next:

    * ``{"action": "mfa_passkey"}`` — at least one passkey is registered;
      the login response should be a normal MfaChallenge with method
      flagged as ``webauthn``.
    * ``{"action": "enrollment_required", "token": "..."}`` — role is
      under a force-policy and no passkey is registered. Caller minted
      an enrolment token; the login response surfaces it so the SPA can
      route the user through the enrolment screen.
    * ``{"action": "none"}`` — no passkeys, no force-policy; let the
      caller fall through to the normal TOTP / no-MFA path.

    OIDC accounts are *always* exempted from the force-passkey policy.
    Rationale: the IdP already owns the second-factor story, and double-
    prompting on every sign-in is hostile UX. They can still voluntarily
    enrol a passkey through /me/webauthn/register/* — that path runs
    just fine (no auth_provider filter there) — and use it for the
    passwordless flow as a fallback when the IdP is unreachable.
    The check below is defense-in-depth: today OIDC users physically
    cannot reach /auth/login (``verify_local_credentials`` refuses them
    for lacking a password hash), but if a future change routes them
    through here we don't want the policy gate to surprise anyone.
    """
    from app.models.user import AuthProvider as _AuthProvider

    if user.auth_provider == _AuthProvider.OIDC:
        # OIDC accounts can optionally have passkeys — let the SPA see
        # them in the MFA branch only if they exist, never block via
        # forced enrolment.
        creds = await _user_credentials(db, user.id)
        if creds:
            return {"action": "mfa_passkey"}
        return {"action": "none"}

    creds = await _user_credentials(db, user.id)
    if creds:
        return {"action": "mfa_passkey"}
    forced = repo is not None and role_requires_passkey(
        user.role.value,
        repo.webauthn_required_admin,
        repo.webauthn_required_uploader,
    )
    if not forced:
        return {"action": "none"}
    from datetime import UTC as _UTC, datetime as _datetime, timedelta as _timedelta

    import jwt as _jwt

    now = _datetime.now(_UTC)
    payload = {
        "sub": str(user.id),
        "type": "webauthn_enrollment",
        "iat": int(now.timestamp()),
        "exp": int((now + _timedelta(minutes=5)).timestamp()),
    }
    token = _jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)
    return {"action": "enrollment_required", "token": token}
