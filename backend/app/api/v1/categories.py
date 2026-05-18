from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.api.deps import DbSession, get_current_admin, require_browse_access
from app.models.app import Category, app_categories_table
from app.models.user import User
from app.schemas.app import (
    CategoryCreate,
    CategoryRead,
    CategoryUpdate,
    CategoryWithCount,
)

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
            id=cat.id,
            name=cat.name,
            description=cat.description,
            app_count=int(count),
        )
        for cat, count in rows
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
    return CategoryRead.model_validate(cat)


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
