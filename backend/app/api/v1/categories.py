from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import select

from app.api.deps import DbSession, get_current_admin, require_browse_access
from app.models.app import Category
from app.models.user import User
from app.schemas.app import CategoryCreate, CategoryRead

router = APIRouter()


@router.get("", response_model=list[CategoryRead])
async def list_categories(
    db: DbSession,
    _: Annotated[User | None, Depends(require_browse_access)],
) -> list[CategoryRead]:
    rows = (
        await db.execute(select(Category).order_by(Category.name))
    ).scalars().all()
    return [CategoryRead.model_validate(c) for c in rows]


@router.post("", response_model=CategoryRead)
async def create_category(
    payload: CategoryCreate,
    db: DbSession,
    _: Annotated[User, Depends(get_current_admin)],
) -> CategoryRead:
    cat = Category(name=payload.name, description=payload.description)
    db.add(cat)
    await db.flush()
    return CategoryRead.model_validate(cat)
