from __future__ import annotations

import base64
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select

from app.api.deps import DbSession, get_current_admin
from app.core.config import settings
from app.core.logging import get_logger
from app.fdroid.keystore import (
    KeystoreError,
    delete_keystore,
    generate_keystore,
    import_keystore,
    read_keystore_info,
)
from app.models.repo_config import RepoConfig
from app.models.user import User
from app.schemas.repo import KeystoreInfo, RepoConfigRead, SetupStatus, SetupWizardRequest

router = APIRouter()
log = get_logger(__name__)


@router.get("/status", response_model=SetupStatus)
async def setup_status(db: DbSession) -> SetupStatus:
    config = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
    keystore_present = Path(settings.keystore_path).exists()
    return SetupStatus(
        setup_complete=bool(config and config.setup_complete),
        keystore_present=keystore_present,
        repo_name=config.name if config else None,
        repo_description=config.description if config else None,
        repo_address=config.address if config else None,
        repo_icon_path=config.icon_path if config else None,
        repo_fingerprint=config.keystore_fingerprint_sha256 if config else None,
        public_mode=config.public_mode if config else True,
        upload_max_apk_mb=config.upload_max_apk_mb if config else 200,
    )


@router.post("/wizard", response_model=RepoConfigRead)
async def run_setup_wizard(
    payload: SetupWizardRequest,
    db: DbSession,
    admin: Annotated[User, Depends(get_current_admin)],
) -> RepoConfigRead:
    """One-shot setup: pick repo metadata + create-or-import the signing key."""
    config = (await db.execute(select(RepoConfig).limit(1))).scalar_one()

    # ---- Repo metadata --------------------------------------------------
    config.name = payload.repo_name
    config.description = payload.repo_description
    config.address = str(payload.repo_address).rstrip("/")

    # ---- Keystore -------------------------------------------------------
    # The password / alias / key password are sourced from environment
    # variables, NOT from the wizard. The wizard only chooses whether to
    # generate or import. Rationale: the worker reads these from the env
    # too; if the wizard changed them the worker would drift.
    keystore_path = Path(settings.keystore_path)
    keystore_password = settings.keystore_password
    alias = settings.key_alias
    key_password = settings.key_password

    # C9: refuse to silently destroy the signing identity once setup is
    # complete. Regenerating the keystore changes the SHA-256 fingerprint,
    # which F-Droid clients pin on first add — every existing subscriber
    # then rejects the next index update with no in-app recovery path.
    # The admin must explicitly opt in via ``confirm_destroy=true`` after
    # backing up the current keystore.
    if (
        payload.keystore_mode == "generate"
        and keystore_path.exists()
        and config.setup_complete
        and not payload.confirm_destroy
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Regenerating the keystore would invalidate the trust chain "
                "for every F-Droid client already subscribed to this repo. "
                "Pass ``confirm_destroy=true`` to acknowledge this is irrecoverable, "
                "and back up the current keystore file first."
            ),
        )

    try:
        if payload.keystore_mode == "generate":
            if keystore_path.exists():
                # Archive the old keystore alongside the new one so an
                # operator with shell access can recover the previous
                # signer identity if they confirmed by mistake.
                ts = int(datetime.now(UTC).timestamp())
                backup = keystore_path.with_suffix(keystore_path.suffix + f".bak-{ts}")
                try:
                    keystore_path.rename(backup)
                except OSError:
                    await delete_keystore(keystore_path)
            info = await generate_keystore(
                keystore_path,
                keystore_password=keystore_password,
                alias=alias,
                key_password=key_password,
                dname=payload.key_dname or settings.key_dname,
            )
        elif payload.keystore_mode == "import":
            if not payload.keystore_b64:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="keystore_b64 is required when keystore_mode=import",
                )
            try:
                content = base64.b64decode(payload.keystore_b64)
            except Exception as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="keystore_b64 is not valid base64",
                ) from exc
            info = await import_keystore(
                keystore_path,
                content=content,
                keystore_password=keystore_password,
            )
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid keystore_mode",
            )
    except KeystoreError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    config.keystore_fingerprint_sha256 = info.fingerprint_sha256
    config.setup_complete = True
    await db.flush()
    log.info(
        "setup wizard completed",
        admin=admin.username,
        keystore_mode=payload.keystore_mode,
        fingerprint=info.fingerprint_sha256,
    )
    return RepoConfigRead.model_validate(config)


@router.get("/keystore", response_model=KeystoreInfo)
async def keystore_info(
    _: Annotated[User, Depends(get_current_admin)],
) -> KeystoreInfo:
    path = Path(settings.keystore_path)
    if not path.exists():
        return KeystoreInfo(present=False, fingerprint_sha256=None, alias=None, not_before=None, not_after=None)
    try:
        info = await read_keystore_info(path, settings.keystore_password)
    except KeystoreError as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc
    return KeystoreInfo(
        present=info.present,
        fingerprint_sha256=info.fingerprint_sha256,
        alias=info.alias,
        not_before=info.not_before,
        not_after=info.not_after,
    )
