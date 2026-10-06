"""SQLAlchemy async engine + session factory.

The engine is shared process-wide; sessions are created per request via the
:func:`get_db` dependency.
"""
from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from contextvars import ContextVar

from sqlalchemy.exc import DBAPIError, InterfaceError
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


def _create_engine() -> AsyncEngine:
    return create_async_engine(
        settings.database_url,
        echo=False,
        pool_pre_ping=True,
        pool_size=10,
        max_overflow=20,
    )


engine: AsyncEngine = _create_engine()

SessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


AfterCommitHook = Callable[[], Awaitable[None]]

# Work a request asked for that must only happen once its transaction is
# durable (queueing an index rebuild that reads the new rows). ``None``
# outside a request-scoped session.
_after_commit_hooks: ContextVar[dict[str, AfterCommitHook] | None] = ContextVar(
    "after_commit_hooks", default=None
)


def run_after_commit(key: str, hook: AfterCommitHook) -> bool:
    """Run ``hook`` once the current request's transaction has committed.

    Hooks registered under the same ``key`` coalesce (the last one wins);
    they are dropped when the request fails or its commit does. Returns
    ``False`` outside a request (worker, scripts) — the caller then does the
    work itself, after its own commit.
    """
    hooks = _after_commit_hooks.get()
    if hooks is None:
        return False
    hooks[key] = hook
    return True


async def get_db() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency that yields an AsyncSession scoped to one request.

    Declared with ``scope="function"`` (see ``app.api.deps.DbSession``) so
    the commit lands *before* the response is sent: a client chaining calls
    (create an app, then upload to it) never races an uncommitted row, and a
    failed commit surfaces as an error instead of a success response whose
    data was silently rolled back. Hooks queued with
    :func:`run_after_commit` run once the commit succeeded.

    The admin Backup-Restore feature terminates every other PG session as
    part of its work — the dependency's bound connection can be one of the
    victims, so commit/rollback/close at cleanup time raise
    ``InterfaceError: connection is closed``. Only that case is swallowed;
    if the request handler itself raised, the exception still propagates
    (FastAPI requires it — bare-except-swallow in a yield dependency breaks
    response handling). pool_pre_ping refreshes the dead pool entries on the
    next acquisition.
    """
    session = SessionLocal()
    hooks: dict[str, AfterCommitHook] = {}
    token = _after_commit_hooks.set(hooks)
    try:
        try:
            yield session
        except Exception:
            # Request raised — rollback (best-effort) then let the exception
            # propagate so FastAPI can render the error response.
            try:
                await session.rollback()
            except Exception:
                pass
            raise
        try:
            await session.commit()
        except DBAPIError as exc:
            if not (exc.connection_invalidated or isinstance(exc, InterfaceError)):
                raise
            # Connection killed mid-request (Backup-Restore): nothing was
            # committed, so nothing must run after it.
            hooks.clear()
            try:
                await session.rollback()
            except Exception:
                pass
    finally:
        try:
            _after_commit_hooks.reset(token)
        except ValueError:
            pass
        # Close once, swallow connection-already-gone errors (backup-restore
        # tears down the pool mid-request). Re-raising here would mask the
        # actual request exception that started the unwind.
        try:
            await session.close()
        except Exception:
            pass
    for key, hook in hooks.items():
        try:
            await hook()
        except Exception as exc:  # noqa: BLE001 — the data is committed; don't fail the request
            log.warning("after-commit hook failed", hook=key, error=str(exc))
