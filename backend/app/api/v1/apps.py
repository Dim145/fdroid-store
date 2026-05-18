from __future__ import annotations

import re
import uuid
from typing import Annotated

# Mirrors the ``package_name`` regex in ``AppCreate`` — kept module-level so
# the multipart endpoint can reuse it without going through the JSON
# pipeline. Standard Android package id: at least two dot-separated
# segments, each starting with a letter, alphanumeric + underscore.
_PACKAGE_NAME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$")

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile, status
from sqlalchemy import or_, select
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession, get_current_user, require_browse_access
from app.api.v1.apks import (
    _apk_size_cap_bytes,
    attach_apk_to_app,
    parse_or_400,
    save_upload_to_temp,
)
from app.models.app import App, AppStatus, AppVisibility, Category
from app.models.apk import ApkStatus
from app.models.user import User, UserRole
from app.schemas.app import AppCreate, AppDetail, AppRead, AppUpdate
from app.services.queue import enqueue_reindex

router = APIRouter()


def _app_visible_to(app: App, user: User | None) -> bool:
    """Public published apps are visible to anyone. Otherwise the requester
    must be the owner or an admin."""
    if app.visibility == AppVisibility.PUBLIC and app.status == AppStatus.PUBLISHED:
        return True
    if user is None:
        return False
    if user.role == UserRole.ADMIN:
        return True
    return app.owner_id == user.id


@router.get("", response_model=list[AppRead])
async def list_apps(
    db: DbSession,
    user: Annotated[User | None, Depends(require_browse_access)],
    q: str | None = Query(default=None, max_length=200),
    category: str | None = Query(default=None, max_length=64),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> list[AppRead]:
    """Browse apps. Anonymous callers only see PUBLIC + PUBLISHED apps; they
    are rejected outright when the repo is not in public mode. NSFW-flagged
    apps are hidden unless the caller has opted in via ``show_nsfw``."""
    stmt = (
        select(App)
        .options(selectinload(App.categories), selectinload(App.apks))
        .order_by(App.last_published_at.desc().nullslast(), App.name)
    )
    if user is None or user.role != UserRole.ADMIN:
        # Public listing: PUBLIC + PUBLISHED
        stmt = stmt.where(
            App.visibility == AppVisibility.PUBLIC,
            App.status == AppStatus.PUBLISHED,
        )

    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(App.name.ilike(like), App.summary.ilike(like), App.package_name.ilike(like)))
    if category:
        stmt = stmt.join(App.categories).where(Category.name == category)

    stmt = stmt.limit(min(limit, 200)).offset(offset)
    rows = (await db.execute(stmt)).scalars().unique().all()
    show_nsfw = bool(user and user.show_nsfw)
    if not show_nsfw:
        rows = [a for a in rows if not a.is_nsfw]
    return [AppRead.model_validate(a) for a in rows]


@router.post("/with-apk", response_model=AppDetail, status_code=status.HTTP_201_CREATED)
async def create_app_with_apk(
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
    file: UploadFile = File(...),
    name: str = Form(..., min_length=1, max_length=255),
    package_name: str | None = Form(default=None, max_length=255),
    summary: str | None = Form(default=None, max_length=255),
    description: str | None = Form(default=None, max_length=20_000),
    license: str | None = Form(default=None, max_length=128),
    website: str | None = Form(default=None, max_length=512),
    source_code: str | None = Form(default=None, max_length=512),
    issue_tracker: str | None = Form(default=None, max_length=512),
    author_name: str | None = Form(default=None, max_length=255),
    visibility: str = Form(default="public", max_length=16),
) -> AppDetail:
    """Create an App + attach an APK in one multipart request.

    All form fields run through the same constraints as ``AppCreate``
    (length caps, enum validation) so this multipart path can't be used
    to bypass the JSON Pydantic validation. URL fields are validated as
    proper http(s) URLs to avoid storing ``javascript:`` etc. that would
    later become an XSS surface.
    """
    try:
        visibility_enum = AppVisibility(visibility)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="visibility must be 'public' or 'private'",
        ) from exc

    # URL fields: reuse Pydantic's HttpUrl validator so we reject
    # ``javascript:``, ``data:``, mailto, and other non-http schemes.
    from pydantic import HttpUrl as _HttpUrl, ValidationError as _VErr

    def _check_url(value: str | None, label: str) -> str | None:
        if not value:
            return None
        try:
            return str(_HttpUrl(value))
        except _VErr as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"{label} must be an http(s) URL",
            ) from exc

    website = _check_url(website, "website")
    source_code = _check_url(source_code, "source_code")
    issue_tracker = _check_url(issue_tracker, "issue_tracker")

    tmp_path = await save_upload_to_temp(file, max_bytes=await _apk_size_cap_bytes(db))
    try:
        meta = await parse_or_400(tmp_path)
        pkg = (package_name or meta.package_name).strip()
        # Enforce the same package-name regex used on the JSON path; an
        # APK manifest with a wonky package would otherwise slip through.
        if not _PACKAGE_NAME_RE.match(pkg):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="package name must be a valid Android package id",
            )
        if pkg != meta.package_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"package_name {pkg!r} does not match the APK manifest "
                    f"({meta.package_name!r})"
                ),
            )
        if (
            await db.execute(select(App).where(App.package_name == pkg))
        ).scalar_one_or_none() is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Package {pkg} already exists",
            )

        app = App(
            package_name=pkg,
            name=name,
            summary=summary,
            description=description,
            license=license,
            website=website,
            source_code=source_code,
            issue_tracker=issue_tracker,
            author_name=author_name,
            visibility=visibility_enum,
            status=AppStatus.DRAFT,
            owner_id=user.id,
            apks=[],
            screenshots=[],  # initialise to avoid lazy-load during index build
        )
        db.add(app)
        await db.flush()

        apk = await attach_apk_to_app(
            db, app=app, tmp_path=tmp_path, meta=meta, uploader=user
        )
        if apk.status == ApkStatus.PUBLISHED:
            await enqueue_reindex()

        # Reload with eager relationships for the response.
        # populate_existing forces SQLAlchemy to overwrite the identity-map
        # cache so the just-added APK shows up in app.apks.
        result = (
            await db.execute(
                select(App)
                .execution_options(populate_existing=True)
                .options(
                    selectinload(App.categories),
                    selectinload(App.apks),
                    selectinload(App.owner),
                    selectinload(App.screenshots),
                )
                .where(App.id == app.id)
            )
        ).scalar_one()
        payload = AppDetail.model_validate(result)
        payload.owner_username = result.owner.username if result.owner else None
        return payload
    finally:
        tmp_path.unlink(missing_ok=True)


@router.post("", response_model=AppRead, status_code=status.HTTP_201_CREATED)
async def create_app(
    payload: AppCreate,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
) -> AppRead:
    existing = (
        await db.execute(select(App).where(App.package_name == payload.package_name))
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Package {payload.package_name} already exists",
        )

    categories: list[Category] = []
    if payload.category_ids:
        categories = list(
            (
                await db.execute(select(Category).where(Category.id.in_(payload.category_ids)))
            ).scalars().all()
        )

    app = App(
        package_name=payload.package_name,
        name=payload.name,
        summary=payload.summary,
        description=payload.description,
        license=payload.license,
        website=str(payload.website) if payload.website else None,
        source_code=str(payload.source_code) if payload.source_code else None,
        issue_tracker=str(payload.issue_tracker) if payload.issue_tracker else None,
        author_name=payload.author_name,
        visibility=payload.visibility,
        status=AppStatus.DRAFT,
        owner_id=user.id,
        categories=categories,
    )
    db.add(app)
    await db.flush()
    return AppRead.model_validate(app)


async def _load_app_or_404(db, app_id_or_pkg: str) -> App:
    stmt = select(App).options(
        selectinload(App.categories),
        selectinload(App.apks),
        selectinload(App.owner),
        selectinload(App.screenshots),
    )
    try:
        pk = uuid.UUID(app_id_or_pkg)
        stmt = stmt.where(App.id == pk)
    except ValueError:
        stmt = stmt.where(App.package_name == app_id_or_pkg)
    app = (await db.execute(stmt)).scalar_one_or_none()
    if app is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App not found")
    return app


@router.get("/{app_ref}", response_model=AppDetail)
async def get_app(
    app_ref: str,
    db: DbSession,
    user: Annotated[User | None, Depends(require_browse_access)],
) -> AppDetail:
    app = await _load_app_or_404(db, app_ref)
    if not _app_visible_to(app, user):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App not found")
    payload = AppDetail.model_validate(app)
    payload.owner_username = app.owner.username if app.owner else None
    return payload


@router.patch("/{app_id}", response_model=AppRead)
async def update_app(
    app_id: uuid.UUID,
    payload: AppUpdate,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
) -> AppRead:
    app = await _load_app_or_404(db, str(app_id))
    if app.owner_id != user.id and user.role != UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")

    if payload.name is not None:
        app.name = payload.name
    if payload.summary is not None:
        app.summary = payload.summary
    if payload.description is not None:
        app.description = payload.description
    if payload.license is not None:
        app.license = payload.license
    if payload.website is not None:
        app.website = str(payload.website)
    if payload.source_code is not None:
        app.source_code = str(payload.source_code)
    if payload.issue_tracker is not None:
        app.issue_tracker = str(payload.issue_tracker)
    if payload.author_name is not None:
        app.author_name = payload.author_name
    if payload.author_email is not None:
        app.author_email = payload.author_email
    if payload.donate is not None:
        app.donate = payload.donate
    if payload.liberapay is not None:
        app.liberapay = payload.liberapay
    if payload.bitcoin is not None:
        app.bitcoin = payload.bitcoin
    if payload.open_collective is not None:
        app.open_collective = payload.open_collective
    if payload.translation is not None:
        app.translation = payload.translation
    if payload.visibility is not None:
        app.visibility = payload.visibility
    if payload.category_ids is not None:
        cats = list(
            (
                await db.execute(select(Category).where(Category.id.in_(payload.category_ids)))
            ).scalars().all()
        )
        app.categories = cats

    await db.flush()
    return AppRead.model_validate(app)


@router.delete("/{app_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None, response_class=Response)
async def delete_app(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
) -> None:
    app = await _load_app_or_404(db, str(app_id))
    if app.owner_id != user.id and user.role != UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    await db.delete(app)
    await db.flush()
