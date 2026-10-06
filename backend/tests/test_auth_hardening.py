"""Authentication hardening: log redaction, password hashing, TOTP replay
and lockout, SSO usernames, WebAuthn labels and decoys."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pyotp
import pytest

from app.api.v1 import webauthn as webauthn_api
from app.core.logging import redact_url
from app.core.security import _bcrypt_safe, _password_hash, hash_password, verify_password
from app.models.user import User
from app.models.user_totp import UserTotp
from app.services import totp as totp_service
from app.services.auth_service import AuthError, _oidc_username


def test_redact_url_hides_url_credentials() -> None:
    redacted = redact_url("/r/fdr_abc_SECRET/fdroid/repo/entry.jar")
    assert redacted == "/r/<redacted>/fdroid/repo/entry.jar"
    assert redact_url("/fdroid/repo/a.apk?t=SIGNED&x=1") == "/fdroid/repo/a.apk?t=<redacted>&x=1"
    assert "AUTH" not in redact_url("/api/v1/auth/oidc/callback?code=AUTH&state=ST")
    assert redact_url("/fdroid/repo/r/x") == "/fdroid/repo/r/x"


def test_long_passwords_are_hashed_in_full() -> None:
    hashed = hash_password("A" * 72 + "x")
    assert verify_password("A" * 72 + "x", hashed)
    assert not verify_password("A" * 72 + "y", hashed)


def test_argon2_hashes_of_truncated_passwords_still_verify() -> None:
    legacy = _password_hash.hash(_bcrypt_safe("B" * 80))
    assert verify_password("B" * 80, legacy)


def test_auth_error_carries_a_stable_code() -> None:
    assert AuthError("x").code == "auth_failed"
    assert AuthError("x", code="signup_closed").code == "signup_closed"


@pytest.mark.parametrize(
    ("preferred", "email", "expected"),
    [
        ("alice", "a@x.org", "alice"),
        ("Łukasz Wiśniewski", "l@x.org", "ukaszWiniewski"),
        ("a@b", "bob@x.org", "bob"),
        (None, "carol.d@x.org", "carol.d"),
        ("x" * 200, "e@x.org", "x" * 60),
        ("!!", "??@x.org", "user"),
    ],
)
def test_oidc_usernames_follow_the_signup_shape(preferred, email, expected) -> None:
    assert _oidc_username(preferred, email) == expected


def test_passkey_labels_are_cleaned() -> None:
    assert webauthn_api._clean_label("  Laptop  ") == "Laptop"
    assert webauthn_api._clean_label("x" * 300) == "x" * 100
    assert webauthn_api._clean_label({"evil": 1}) == "Passkey"
    assert webauthn_api._clean_label("   ") == "Passkey"


def test_decoy_credentials_are_stable_per_identifier() -> None:
    a1 = webauthn_api._decoy_credential_id("alice@example.com")
    assert a1 == webauthn_api._decoy_credential_id("alice@example.com")
    assert a1 != webauthn_api._decoy_credential_id("bob@example.com")


# --------------------------------------------------------------------------
# TOTP: a code works once; repeated failures lock the second factor
# --------------------------------------------------------------------------
class _Result:
    def __init__(self, row: UserTotp) -> None:
        self.row = row

    def scalar_one_or_none(self) -> UserTotp:
        return self.row


class _Db:
    def __init__(self, row: UserTotp) -> None:
        self.row = row

    async def execute(self, _stmt: object) -> _Result:
        return _Result(self.row)


@pytest.fixture
def totp_env(monkeypatch: pytest.MonkeyPatch):
    claimed: set[str] = set()
    fails: dict[str, int] = {}

    async def claim_once(key: str, ttl: int) -> bool:
        if key in claimed:
            return False
        claimed.add(key)
        return True

    async def failures(key: str) -> int:
        return fails.get(key, 0)

    async def register_failure(key: str, window: int) -> None:
        fails[key] = fails.get(key, 0) + 1

    async def clear_failures(key: str) -> None:
        fails.pop(key, None)

    monkeypatch.setattr(totp_service, "claim_once", claim_once)
    monkeypatch.setattr(totp_service, "failures", failures)
    monkeypatch.setattr(totp_service, "register_failure", register_failure)
    monkeypatch.setattr(totp_service, "clear_failures", clear_failures)
    secret = pyotp.random_base32()
    user = User(id=uuid.uuid4(), email="t@example.com", username="totp")
    row = UserTotp(
        user_id=user.id, secret=secret, confirmed_at=datetime.now(UTC), recovery_codes_hash="[]"
    )
    return user, row, secret


async def test_totp_code_cannot_be_replayed(totp_env) -> None:
    user, row, secret = totp_env
    code = pyotp.TOTP(secret).now()
    assert await totp_service.verify_login(_Db(row), user, code=code)
    assert not await totp_service.verify_login(_Db(row), user, code=code)


async def test_totp_locks_after_repeated_failures(totp_env) -> None:
    user, row, secret = totp_env
    wrong = "000000" if pyotp.TOTP(secret).now() != "000000" else "111111"
    for _ in range(totp_service._MAX_FAILURES):
        assert not await totp_service.verify_login(_Db(row), user, code=wrong)
    assert not await totp_service.verify_login(_Db(row), user, code=pyotp.TOTP(secret).now())
