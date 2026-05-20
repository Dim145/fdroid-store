"""Per-app deploy tokens used by maintainers' CI to push new APKs.

Routes are mounted under ``/apps/{app_id}/deploy-tokens``. Only the
app owner and admins can mint / revoke tokens; co-maintainers can list
but can't manage (a co-maintainer with a leaked CI token shouldn't
become a vector to grant CI access to other systems).

Upload itself happens on the existing ``POST /apks/upload/{app_id}``
endpoint — the deploy token is presented as a Bearer credential, the
dependency in :mod:`app.api.deps` routes it to a synthetic User that
inherits the token's ``created_by`` identity (so quotas + audit attribute
correctly to the human owner).
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select

from app.api.deps import DbSession, get_current_user
from app.core.security import generate_deploy_token
from app.models.app import App
from app.models.deploy_token import DeployToken
from app.models.user import User
from app.schemas.deploy_token import DeployTokenCreate, DeployTokenCreated, DeployTokenRead
from app.services.app_permissions import assert_can_manage_app
from app.services.audit import write_event

router = APIRouter()


async def _load_app_or_404(db, app_id: uuid.UUID) -> App:
    app = (await db.execute(select(App).where(App.id == app_id))).scalar_one_or_none()
    if app is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App not found")
    return app


@router.get(
    "/{app_id}/deploy-tokens",
    response_model=list[DeployTokenRead],
)
async def list_deploy_tokens(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
) -> list[DeployTokenRead]:
    """List every deploy token attached to this app. Visible to owners,
    co-maintainers, and admins. Revoked tokens are returned too — they
    show up greyed out so the operator can see the history."""
    app = await _load_app_or_404(db, app_id)
    await assert_can_manage_app(db, user, app)
    rows = (
        await db.execute(
            select(DeployToken)
            .where(DeployToken.app_id == app_id)
            .order_by(DeployToken.created_at.desc())
        )
    ).scalars().all()
    return [DeployTokenRead.model_validate(r) for r in rows]


@router.post(
    "/{app_id}/deploy-tokens",
    response_model=DeployTokenCreated,
    status_code=status.HTTP_201_CREATED,
)
async def create_deploy_token(
    app_id: uuid.UUID,
    payload: DeployTokenCreate,
    db: DbSession,
    request: Request,
    actor: Annotated[User, Depends(get_current_user)],
) -> DeployTokenCreated:
    """Mint a new deploy token. Any user with manage rights (owner,
    co-maintainer, admin) can create — the token only grants the
    upload-APK capability they already have via the management role,
    so a co-maintainer minting one isn't an escalation."""
    app = await _load_app_or_404(db, app_id)
    await assert_can_manage_app(db, actor, app)

    # Cap the per-app token count to keep the table bounded. Active
    # tokens only — revoked rows are kept for audit but don't count.
    MAX_ACTIVE = 10
    from sqlalchemy import func
    active_count = (
        await db.execute(
            select(func.count(DeployToken.id)).where(
                DeployToken.app_id == app_id,
                DeployToken.revoked_at.is_(None),
            )
        )
    ).scalar_one()
    if active_count >= MAX_ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Per-app deploy token cap reached ({active_count}/{MAX_ACTIVE}). "
                "Revoke an unused token before minting a new one."
            ),
        )

    full, prefix, hashed = generate_deploy_token()
    row = DeployToken(
        app_id=app_id,
        name=payload.name.strip(),
        prefix=prefix,
        hashed_secret=hashed,
        created_by=actor.id,
    )
    db.add(row)
    await write_event(
        db,
        action="deploy_token.created",
        actor=actor,
        target_type="app",
        target_id=app.id,
        summary=f"minted deploy token {payload.name!r} for {app.package_name}",
        payload={"token_prefix": prefix, "name": payload.name},
        request=request,
    )
    await db.flush()
    return DeployTokenCreated(
        id=row.id,
        app_id=row.app_id,
        name=row.name,
        prefix=row.prefix,
        last_used_at=row.last_used_at,
        revoked_at=row.revoked_at,
        created_by=row.created_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
        full_token=full,
    )


@router.delete(
    "/{app_id}/deploy-tokens/{token_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    response_class=Response,
)
async def revoke_deploy_token(
    app_id: uuid.UUID,
    token_id: uuid.UUID,
    db: DbSession,
    request: Request,
    actor: Annotated[User, Depends(get_current_user)],
) -> None:
    """Anyone with manage rights can revoke — same reasoning as
    minting. Co-maintainers leaving the team should also be able to
    pull tokens they shipped to CI behind them."""
    app = await _load_app_or_404(db, app_id)
    await assert_can_manage_app(db, actor, app)
    row = (
        await db.execute(
            select(DeployToken).where(
                DeployToken.id == token_id,
                DeployToken.app_id == app_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Deploy token not found")
    if row.revoked_at is None:
        row.revoked_at = datetime.now(UTC)
    await write_event(
        db,
        action="deploy_token.revoked",
        actor=actor,
        target_type="app",
        target_id=app.id,
        summary=f"revoked deploy token {row.name!r} on {app.package_name}",
        payload={"token_prefix": row.prefix},
        request=request,
    )
    await db.flush()
