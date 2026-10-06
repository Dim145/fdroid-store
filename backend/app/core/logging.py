"""Structured logging setup with structlog."""
from __future__ import annotations

import logging
import re
import sys

import structlog

from app.core.config import settings

# Credentials that travel in URLs: API keys in ``/r/<key>/fdroid/repo/…``
# (F-Droid clients that can't do Basic auth), signed download/media tokens,
# and the OIDC callback's code/state + SSO nonce.
_SECRET_PATH = re.compile(r"^/r/[^/?#]+")
_SECRET_QUERY = re.compile(r"([?&](?:t|token|code|state|bind)=)[^&#\s]+")


def redact_url(path: str) -> str:
    return _SECRET_QUERY.sub(r"\1<redacted>", _SECRET_PATH.sub("/r/<redacted>", path))


class _RedactAccessLog(logging.Filter):
    """uvicorn's access line is ``client - "METHOD path HTTP/x" status`` with
    the path (query included) as the third argument."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str):
            record.args = (*args[:2], redact_url(args[2]), *args[3:])
        return True


def configure_logging() -> None:
    level = getattr(logging, settings.log_level.upper(), logging.INFO)

    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=level,
    )
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, _RedactAccessLog) for f in access.filters):
        access.addFilter(_RedactAccessLog())

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.dev.ConsoleRenderer()
            if settings.environment == "development"
            else structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None) -> structlog.BoundLogger:
    return structlog.get_logger(name)
