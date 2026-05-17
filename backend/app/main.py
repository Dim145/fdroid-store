"""FastAPI application entry point."""
from __future__ import annotations

from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware

from app import __version__
from app.api.fdroid import router as fdroid_router
from app.api.v1 import api_router
from app.core.config import settings
from app.core.logging import configure_logging, get_logger
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

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # SessionMiddleware is required by Authlib for the OIDC flow.
    app.add_middleware(SessionMiddleware, secret_key=settings.secret_key)

    # API routes (JSON, admin/client zone consumes them)
    app.include_router(api_router, prefix="/api/v1")

    # F-Droid repo path (consumed by F-Droid Android clients)
    app.include_router(fdroid_router, prefix="/fdroid/repo")

    return app


app = create_app()
