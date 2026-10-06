"""FastAPI application entry point."""
from __future__ import annotations

import re
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy.exc import IntegrityError
from starlette.middleware.sessions import SessionMiddleware
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app import __version__
from app.api.fdroid import router as fdroid_router, token_router as fdroid_token_router
from app.api.v1 import api_router
from app.core.config import settings
from app.core.logging import configure_logging, get_logger
from app.core.rate_limit import limiter
from app.services.bootstrap import bootstrap_first_run

log = get_logger(__name__)

# Request bodies the app buffers itself (JSON, form fields) are capped here:
# FastAPI reads and json-decodes the whole body before any rate limit runs,
# and the edge proxy lets 500 MB through on /api/, so an anonymous
# ``POST /auth/login`` could otherwise pin hundreds of MB per request.
MAX_BODY_BYTES = 2 * 1024 * 1024
# Multipart upload routes. They stream the file to disk / storage under
# their own (admin-configurable) caps, so they are exempt from the default.
UPLOAD_ROUTES = re.compile(
    r"/api/v1/(?:"
    r"apks/(?:inspect|upload/[^/]+)"
    r"|apps/with-apk"
    r"|apps/[^/]+/(?:icon|feature-graphic|promo-graphic|tv-banner|screenshots)"
    r"|admin/repo/icon"
    r"|admin/backup/restore"
    r")/?$"
)


class BodySizeLimitMiddleware:
    """413 for request bodies over ``max_bytes``: up front from
    ``Content-Length``, and while streaming for bodies without one
    (chunked). Pure ASGI on purpose — ``BaseHTTPMiddleware`` buffers
    responses (see the rate-limiter note in :func:`create_app`)."""

    def __init__(self, app: ASGIApp, max_bytes: int = MAX_BODY_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or UPLOAD_ROUTES.search(scope["path"]):
            await self.app(scope, receive, send)
            return
        for name, value in scope["headers"]:
            if name == b"content-length" and value.isdigit() and int(value) > self.max_bytes:
                response = JSONResponse({"detail": "Request body too large"}, status_code=413)
                await response(scope, receive, send)
                return
        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    # Raised inside the body read: FastAPI re-raises an
                    # HTTPException from there and renders it as a 413.
                    raise HTTPException(status_code=413, detail="Request body too large")
            return message

        await self.app(scope, limited_receive, send)


async def integrity_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """A unique / foreign-key violation — typically a race between two
    requests, surfacing at flush or at the request's commit — is a 409, not
    a 500. The constraint details stay in the log."""
    log.warning(
        "integrity error",
        path=request.url.path,
        error=str(getattr(exc, "orig", exc))[:500],
    )
    return JSONResponse(status_code=409, content={"detail": "Conflict with existing data"})


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
    app.add_exception_handler(IntegrityError, integrity_error_handler)

    # Added before CORS so it runs inside it: a 413 still carries the CORS
    # headers the SPA needs to read it.
    app.add_middleware(BodySizeLimitMiddleware)
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
