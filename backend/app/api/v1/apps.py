from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import or_, select
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession, get_current_user, get_current_user_optional
from app.models.app import App, AppStatus, AppVisibility, Category
from app.models.user import User, UserRole
from app.schemas.app import AppCreate, AppDetail, AppRead, AppUpdate

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
    user: Annotated[User | None, Depends(get_current_user_optional)],
    q: str | None = None,
    category: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[AppRead]:
    """Browse apps. Anonymous callers only see PUBLIC + PUBLISHED apps."""
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
    return [AppRead.model_validate(a) for a in rows]


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
    user: Annotated[User | None, Depends(get_current_user_optional)],
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
