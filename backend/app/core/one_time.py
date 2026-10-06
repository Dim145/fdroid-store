"""Small redis-backed guards for authentication flows.

* :func:`claim_once` — single-use markers (WebAuthn challenges, enrolment
  tokens, TOTP time-steps): the first claim wins, replays are refused.
* :func:`register_failure` / :func:`failures` / :func:`clear_failures` — a
  per-subject failure counter used to lock brute-force attempts on second
  factors.

Both fail *open* when redis is unreachable: they harden flows that are
already authenticated by something else (a signed token, a password), and
an outage of the queue backend must not lock every user out.
"""
from __future__ import annotations

from redis.asyncio import Redis

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)

_PREFIX = "fdroid:auth:"
_client: Redis | None = None


def _redis() -> Redis:
    global _client
    if _client is None:
        _client = Redis.from_url(settings.redis_url, socket_timeout=2, socket_connect_timeout=2)
    return _client


async def claim_once(key: str, ttl_seconds: int) -> bool:
    """True the first time ``key`` is claimed within ``ttl_seconds``."""
    try:
        return bool(await _redis().set(f"{_PREFIX}once:{key}", "1", nx=True, ex=ttl_seconds))
    except Exception as exc:
        log.warning("one-time claim store unavailable", error=str(exc))
        return True


async def failures(key: str) -> int:
    try:
        raw = await _redis().get(f"{_PREFIX}fail:{key}")
    except Exception as exc:
        log.warning("failure counter unavailable", error=str(exc))
        return 0
    return int(raw or 0)


async def register_failure(key: str, window_seconds: int) -> None:
    try:
        name = f"{_PREFIX}fail:{key}"
        # One transaction: a crash between INCR and EXPIRE must not leave a
        # counter (and a lockout) that never expires.
        async with _redis().pipeline(transaction=True) as pipe:
            pipe.incr(name)
            pipe.expire(name, window_seconds, nx=True)
            await pipe.execute()
    except Exception as exc:
        log.warning("failure counter unavailable", error=str(exc))


async def clear_failures(key: str) -> None:
    try:
        await _redis().delete(f"{_PREFIX}fail:{key}")
    except Exception as exc:
        log.warning("failure counter unavailable", error=str(exc))
