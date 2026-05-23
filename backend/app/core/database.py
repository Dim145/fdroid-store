"""SQLAlchemy async engine + session factory.

The engine is shared process-wide; sessions are created per request via the
:func:`get_db` dependency.
"""
from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings


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


async def get_db() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency that yields an AsyncSession scoped to one request.

    The admin Backup-Restore endpoint terminates every other PG session as
    part of its work — the dependency's bound connection is one of the
    victims, so commit/rollback/close at *cleanup time* all raise
    ``InterfaceError: connection is closed``. We swallow those only on the
    no-error happy path; if the request handler itself raised, we still
    propagate the exception (FastAPI requires it — bare-except-swallow in
    a yield dependency breaks response handling). pool_pre_ping refreshes
    the dead pool entries on the next acquisition.
    """
    session = SessionLocal()
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
        # Happy path. Commit; if the connection was killed mid-request
        # (e.g. by the Backup-Restore feature), don't burn the response —
        # the restore subprocess already did its work via a separate
        # connection.
        try:
            await session.commit()
        except Exception:
            try:
                await session.rollback()
            except Exception:
                pass
    finally:
        # Close once, swallow connection-already-gone errors (backup-restore
        # tears down the pool mid-request). Re-raising here would mask the
        # actual request exception that started the unwind.
        try:
            await session.close()
        except Exception:
            pass
