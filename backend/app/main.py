"""FastAPI application entry point."""
from __future__ import annotations

from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from starlette.middleware.sessions import SessionMiddleware

from app import __version__
from app.api.fdroid import router as fdroid_router, token_router as fdroid_token_router
from app.api.v1 import api_router
from app.core.config import settings
from app.core.logging import configure_logging, get_logger
from app.core.rate_limit import limiter
from app.services.bootstrap import bootstrap_first_run

log = get_logger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    configure_logging()
    log.info("starting fdroid-store backend", version=__version__, env=settings.environment)
    await bootstrap_first_run()
    yield
    log.info("shutting down fdroid-store backend")


def create_app() -> FastAPI:
    app = FastAPI(
        title="fdroid-store",
        version=__version__,
        description="Self-hosted F-Droid repository — admin & client API",
        lifespan=lifespan,
        # Hide docs in production unless explicitly enabled
        docs_url="/api/docs" if settings.environment != "production" else None,
        redoc_url=None,
        openapi_url="/api/openapi.json" if settings.environment != "production" else None,
    )

    # Rate limiter (slowapi). The state must be attached BEFORE the route
    # decorators run; including the dependency module at import time
    # already prepares the registry, here we just expose the limiter on
    # ``app.state`` (so the ``@limiter.limit(...)`` decorators can find
    # it) and register the 429 handler.
    #
    # We deliberately do NOT install ``SlowAPIMiddleware``. It's a
    # ``BaseHTTPMiddleware`` subclass, which buffers every response body
    # before re-emitting it — fine for small JSON, but it silently
    # drops bytes for ``StreamingResponse`` of any meaningful size.
    # That's how a 93 MB APK download arrived at the client as 0 bytes
    # while still returning 200. The decorators on individual routes
    # are what actually enforce the limit (they raise
    # ``RateLimitExceeded``, which the handler above turns into a 429);
    # the middleware only added the X-RateLimit-* response headers,
    # which we're willing to give up.
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # SessionMiddleware is required by Authlib for the OIDC flow. Cookie
    # lifetime is capped at one hour because the only thing we stash there
    # is the OIDC ``state``/``nonce`` pair (Authlib) + an optional invite
    # code — both consumed by the callback. ``https_only`` is on outside
    # development; ``same_site=lax`` allows the cross-site GET that the IdP
    # redirects back with.
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.secret_key,
        max_age=3600,
        same_site="lax",
        https_only=settings.environment == "production",
        session_cookie="fdroid_session",
    )

    # API routes (JSON, admin/client zone consumes them)
    app.include_router(api_router, prefix="/api/v1")

    # F-Droid repo path (consumed by F-Droid Android clients)
    app.include_router(fdroid_router, prefix="/fdroid/repo")
    # Alternate path-based token path. See app/api/fdroid.py for the rationale.
    app.include_router(fdroid_token_router, prefix="/r")

    return app


app = create_app()
