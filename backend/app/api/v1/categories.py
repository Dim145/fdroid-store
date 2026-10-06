from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession, get_current_admin, require_browse_access
from app.fdroid.categories_catalog import (
    OFFICIAL_CATEGORIES,
    localized_descriptions,
    localized_names,
)
from app.models.app import App, Category, app_categories_table
from app.models.user import User
from app.schemas.app import (
    CategoryCreate,
    CategoryMerge,
    CategoryRead,
    CategoryUpdate,
    CategoryWithCount,
    OfficialCategoryRead,
)
from app.services.queue import enqueue_reindex

router = APIRouter()


@router.get("", response_model=list[CategoryWithCount])
async def list_categories(
    db: DbSession,
    _: Annotated[User | None, Depends(require_browse_access)],
) -> list[CategoryWithCount]:
    """Every category + how many apps reference it.

    The count comes from a single grouped query so admins can see usage at a
    glance before renaming or deleting. Anonymous browse access is preserved
    because the catalogue's category filter calls this same endpoint.
    """
    stmt = (
        select(
            Category,
            func.count(app_categories_table.c.app_id).label("app_count"),
        )
        .outerjoin(
            app_categories_table,
            Category.id == app_categories_table.c.category_id,
        )
        .group_by(Category.id)
        .order_by(Category.name)
    )
    rows = (await db.execute(stmt)).all()
    return [
        CategoryWithCount(
            **CategoryRead.model_validate(cat).model_dump(),
            app_count=int(count),
        )
        for cat, count in rows
    ]


@router.get("/catalog", response_model=list[OfficialCategoryRead])
async def official_catalog(
    db: DbSession,
    _: Annotated[User | None, Depends(require_browse_access)],
) -> list[OfficialCategoryRead]:
    """The official F-Droid category IDs (F-Droid 2.0 gives these an icon
    and a Discover group), with our localized texts and whether a local
    category already uses each one. Feeds the admin "add" suggestions and
    the "merge into" picker for legacy categories."""
    used = set((await db.execute(select(Category.name))).scalars().all())
    return [
        OfficialCategoryRead(
            id=cid,
            group=entry.group,
            names=localized_names(cid),
            descriptions=localized_descriptions(cid),
            in_use=cid in used,
        )
        for cid, entry in sorted(OFFICIAL_CATEGORIES.items())
    ]


@router.post("", response_model=CategoryRead, status_code=status.HTTP_201_CREATED)
async def create_category(
    payload: CategoryCreate,
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> CategoryRead:
    cat = Category(name=payload.name, description=payload.description)
    db.add(cat)
    try:
        await db.flush()
    except IntegrityError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A category with that name already exists",
        ) from None
    return CategoryRead.model_validate(cat)


@router.patch("/{category_id}", response_model=CategoryRead)
async def update_category(
    category_id: uuid.UUID,
    payload: CategoryUpdate,
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> CategoryRead:
    cat = (
        await db.execute(select(Category).where(Category.id == category_id))
    ).scalar_one_or_none()
    if cat is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if payload.name is not None:
        cat.name = payload.name
    if payload.description is not None:
        cat.description = payload.description
    try:
        await db.flush()
    except IntegrityError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A category with that name already exists",
        ) from None
    # The name is the category ID inside the index — republish it.
    await enqueue_reindex()
    return CategoryRead.model_validate(cat)


@router.post("/{category_id}/merge", response_model=CategoryRead)
async def merge_category(
    category_id: uuid.UUID,
    payload: CategoryMerge,
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> CategoryRead:
    """Re-tag every app of the source category with ``target_id``, then
    delete the source. Meant for legacy IDs F-Droid 2.0 no longer knows
    (``Games``, ``Money``, ``Time``…) — renaming would collide with the
    official category once it exists."""
    if payload.target_id == category_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot merge a category into itself",
        )
    found = {
        c.id: c
        for c in (
            await db.execute(
                select(Category)
                .options(selectinload(Category.apps).selectinload(App.categories))
                .where(Category.id.in_([category_id, payload.target_id]))
            )
        ).scalars().all()
    }
    source, target = found.get(category_id), found.get(payload.target_id)
    if source is None or target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    for app in list(source.apps):
        if target not in app.categories:
            app.categories.append(target)
        app.categories.remove(source)
    await db.delete(source)
    await db.flush()
    await enqueue_reindex()
    return CategoryRead.model_validate(target)


@router.delete(
    "/{category_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_category(
    category_id: uuid.UUID,
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> None:
    """Drop a category. Apps that referenced it lose the tag via cascade on
    the ``app_categories`` join table — no orphan rows, no app payload
    rewrite needed.
    """
    cat = (
        await db.execute(select(Category).where(Category.id == category_id))
    ).scalar_one_or_none()
    if cat is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    await db.delete(cat)
    await db.flush()
    await enqueue_reindex()
