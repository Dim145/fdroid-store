from __future__ import annotations

import re
import uuid
from typing import Annotated

# Mirrors the ``package_name`` regex in ``AppCreate`` — kept module-level so
# the multipart endpoint can reuse it without going through the JSON
# pipeline. Standard Android package id: at least two dot-separated
# segments, each starting with a letter, alphanumeric + underscore.
_PACKAGE_NAME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$")

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession, get_current_user, get_current_uploader, require_browse_access
from app.core.download_token import sign_media_token
from app.core.rate_limit import limiter
from app.api.v1.apks import (
    _apk_size_cap_bytes,
    attach_apk_to_app,
    parse_or_400,
    save_upload_to_temp,
)
from app.models.app import App, AppStatus, AppVisibility, Category, Localization
from app.models.apk import ApkStatus
from app.models.audit import DownloadEvent
from app.models.user import User, UserRole
from app.schemas.app import (
    AppCreate,
    AppCreateFromGithub,
    AppCreateFromStagedApk,
    AppDetail,
    AppRead,
    AppUpdate,
    LocalizationRead,
    LocalizationUpsert,
)
from app.services.queue import enqueue_reindex

router = APIRouter()


def _pick_locale_overrides(
    app: App, preferred_locale: str | None,
) -> tuple[str | None, str | None, str | None]:
    """Resolve the caller's preferred locale against ``app.localizations``.

    Returns ``(name, summary, description)`` overrides — values may be None
    individually when a partial localization only sets some fields, in
    which case the caller leaves that field at the app-level default.

    Resolution order:
      1. Exact locale match (``fr-CA`` → fr-CA).
      2. Language-only match (``fr-CA`` → first row whose primary subtag
         is ``fr``).
      3. None — caller should keep the en-US defaults.
    """
    if not preferred_locale or not app.localizations:
        return None, None, None
    exact = next(
        (loc for loc in app.localizations if loc.locale == preferred_locale),
        None,
    )
    if exact is None:
        primary = preferred_locale.split("-", 1)[0].lower()
        exact = next(
            (
                loc for loc in app.localizations
                if loc.locale.split("-", 1)[0].lower() == primary
            ),
            None,
        )
    if exact is None:
        return None, None, None
    return exact.name, exact.summary, exact.description


def _attach_media_token(payload, app: App, user: User | None) -> None:
    """Mint a per-app media token when the caller is allowed to see this
    app's private images. Anonymous + non-owner callers get ``None``.

    Private-app icons / screenshots / banners are gated by
    ``_media_anonymously_visible`` in the F-Droid route, which only
    recognises Basic-auth API keys. Browser ``<img src>`` tags carry no
    Authorization header, so the SPA needs a query-string token to
    unlock the same files. This helper is the one place that decides
    whether to mint it; callers attach the result to the response.
    """
    if app.visibility == AppVisibility.PUBLIC:
        return
    if user is None:
        return
    is_owner = app.owner_id is not None and user.id == app.owner_id
    if user.role == UserRole.ADMIN or is_owner:
        payload.media_token = sign_media_token(app.package_name, user.id)


def _apply_locale(payload, app: App, preferred_locale: str | None):
    """Overlay localized strings on a freshly serialized AppRead/AppDetail.

    Each field is replaced only when the resolution actually surfaced a
    non-empty value, so a partial localization that only sets the summary
    keeps the default name and description.
    """
    name, summary, description = _pick_locale_overrides(app, preferred_locale)
    if name:
        payload.name = name
    if summary:
        payload.summary = summary
    if description:
        payload.description = description
    return payload


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
        .options(
            selectinload(App.categories),
            selectinload(App.apks),
            selectinload(App.localizations),
        )
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
    preferred_locale = user.preferred_locale if user else None
    out = []
    for a in rows:
        p = _apply_locale(AppRead.model_validate(a), a, preferred_locale)
        _attach_media_token(p, a, user)
        out.append(p)
    return out


@router.post("/with-apk", response_model=AppDetail, status_code=status.HTTP_201_CREATED)
async def create_app_with_apk(
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
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

    from app.services.quotas import ensure_can_create_app, ensure_can_upload_apk

    await ensure_can_create_app(db, user)
    tmp_path = await save_upload_to_temp(file, max_bytes=await _apk_size_cap_bytes(db))
    try:
        await ensure_can_upload_apk(db, user, incoming_size_bytes=tmp_path.stat().st_size)
        # Apply the same opt-in clamd scan as ``/apks/upload`` so the
        # combined "create + upload" endpoint can't be used to bypass it.
        from app.api.v1.apks import _maybe_scan_upload as _apks_scan

        await _apks_scan(db, tmp_path=tmp_path)
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
        # Retention enforcement — no-op on a fresh app with one APK,
        # but kept here so all attach paths share the same hook.
        from app.services.apk_eviction import evict_oldest_if_needed
        await evict_oldest_if_needed(db, app=app, actor_id=user.id)
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
                    # ``AppDetail.localizations`` is read during model_validate
                    # below — without this the sync Pydantic walker triggers a
                    # lazy load and SQLAlchemy raises ``MissingGreenlet``.
                    # The two sibling create paths (with-github-source,
                    # patch) already eager-load it; this one was the outlier.
                    selectinload(App.localizations),
                )
                .where(App.id == app.id)
            )
        ).scalar_one()
        payload = AppDetail.model_validate(result)
        payload.owner_username = result.owner.username if result.owner else None
        _attach_media_token(payload, result, user)
        return payload
    finally:
        tmp_path.unlink(missing_ok=True)


@router.post(
    "/with-staged-apk",
    response_model=AppDetail,
    status_code=status.HTTP_201_CREATED,
)
@limiter.limit("10/minute")
async def create_app_with_staged_apk(
    request: Request,
    payload: AppCreateFromStagedApk,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> AppDetail:
    """Mirror of :func:`create_app_with_apk` that redeems a staging
    token (from ``POST /apks/inspect``) instead of accepting a fresh
    multipart upload. Cuts the create flow's network cost in half for
    large APKs — the bytes are already on the server.
    """
    from app.api.v1.apks import (
        _discard_staged_apk,
        _materialise_staged_apk,
        _maybe_scan_upload,
        attach_apk_to_app,
        parse_or_400,
    )
    from app.services.quotas import ensure_can_create_app, ensure_can_upload_apk

    await ensure_can_create_app(db, user)
    tmp_path, content_hash = await _materialise_staged_apk(
        payload.staging_token, user_id=user.id,
    )
    try:
        # Drop the staged blob on EVERY exit path (success → promoted,
        # failure → don't orphan in storage forever). See the matching
        # comment in ``upload_apk_staged``.
        await ensure_can_upload_apk(db, user, incoming_size_bytes=tmp_path.stat().st_size)
        await _maybe_scan_upload(db, tmp_path=tmp_path)
        meta = await parse_or_400(tmp_path)
        if meta.sha256 != content_hash:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Staged content hash does not match parsed APK",
            )
        pkg = (payload.package_name or meta.package_name).strip()
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
            apks=[],
            screenshots=[],
        )
        db.add(app)
        await db.flush()

        apk = await attach_apk_to_app(
            db, app=app, tmp_path=tmp_path, meta=meta, uploader=user,
        )
        from app.services.apk_eviction import evict_oldest_if_needed
        await evict_oldest_if_needed(db, app=app, actor_id=user.id)
        if apk.status == ApkStatus.PUBLISHED:
            await enqueue_reindex()

        result = (
            await db.execute(
                select(App)
                .execution_options(populate_existing=True)
                .options(
                    selectinload(App.categories),
                    selectinload(App.apks),
                    selectinload(App.owner),
                    selectinload(App.screenshots),
                    selectinload(App.localizations),
                )
                .where(App.id == app.id)
            )
        ).scalar_one()
        payload_out = AppDetail.model_validate(result)
        payload_out.owner_username = result.owner.username if result.owner else None
        _attach_media_token(payload_out, result, user)
        return payload_out
    finally:
        tmp_path.unlink(missing_ok=True)
        await _discard_staged_apk(content_hash)


@router.post("/with-github-source", response_model=AppDetail, status_code=status.HTTP_201_CREATED)
@limiter.limit("10/minute")
async def create_app_with_github_source(
    request: Request,
    payload: AppCreateFromGithub,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> AppDetail:
    """Create an App + first APK + GithubSource in one shot.

    Mirror of :func:`create_app_with_apk` but the APK comes from a
    GitHub release. The repo is re-resolved + re-downloaded server-side
    so the client can't smuggle a tampered binary through the inspect
    response. After creation the daily cron will keep this app in sync
    with the configured repo.
    """
    from datetime import UTC as _UTC, datetime as _dt
    from app.models.github_source import GithubProvider, GithubSource, GithubSourceStatus
    from app.services.crypto import encrypt as _encrypt_token
    from app.services.github_releases import (
        GithubReleaseError,
        download_asset,
        fetch_repo_metadata,
        find_latest_asset,
        validate_base_url,
        validate_repo,
    )
    from app.services.quotas import ensure_can_create_app, ensure_can_upload_apk

    try:
        repo = validate_repo(payload.repo)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    try:
        base_url = validate_base_url(payload.base_url)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    provider_name = (payload.provider or "github").lower()
    try:
        provider_enum = GithubProvider(provider_name)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown provider: {provider_name!r}",
        ) from exc

    pattern = (payload.asset_pattern or "").strip() or None
    raw_token = (payload.access_token or "").strip() or None

    await ensure_can_create_app(db, user)

    # 1. Resolve + download the matching release asset.
    try:
        asset = await find_latest_asset(
            repo,
            asset_pattern=pattern,
            include_prereleases=payload.include_prereleases,
            provider=provider_name,
            base_url=base_url,
            token=raw_token,
        )
    except GithubReleaseError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    if asset is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"No release with a matching APK found for {repo!r}"
            ),
        )

    # Best-effort repo metadata fetch — feeds the server-side defaults
    # for the listing fields the user didn't explicitly set.
    repo_meta = await fetch_repo_metadata(
        repo, provider=provider_name, base_url=base_url, token=raw_token
    )

    try:
        tmp_path = await download_asset(asset)
    except GithubReleaseError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    try:
        # 2. Quota + AV scan + parse, identical to the manual-upload path.
        await ensure_can_upload_apk(db, user, incoming_size_bytes=tmp_path.stat().st_size)
        from app.api.v1.apks import _maybe_scan_upload as _apks_scan

        await _apks_scan(db, tmp_path=tmp_path)
        meta = await parse_or_400(tmp_path)
        if not _PACKAGE_NAME_RE.match(meta.package_name):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="parsed package name is not a valid Android package id",
            )
        if (
            await db.execute(select(App).where(App.package_name == meta.package_name))
        ).scalar_one_or_none() is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Package {meta.package_name} already exists",
            )

        # 3. Create the App + first Apk row. When the caller leaves a
        # listing field empty AND GitHub has a value for it, we fill it
        # — the explicit-empty case (an API client that wants to keep
        # the field blank) is indistinguishable from "not provided", so
        # we err on the side of "more populated is more useful".
        gh_summary = repo_meta.description if repo_meta else None
        gh_homepage = repo_meta.homepage if repo_meta else None
        gh_license = repo_meta.license_spdx if repo_meta else None
        gh_owner_login = repo_meta.owner_login if repo_meta else None
        gh_html_url = repo_meta.html_url if repo_meta else f"https://github.com/{repo}"

        app = App(
            package_name=meta.package_name,
            name=payload.name,
            summary=payload.summary or gh_summary,
            description=payload.description,
            license=payload.license or gh_license,
            website=str(payload.website) if payload.website else gh_homepage,
            source_code=str(payload.source_code) if payload.source_code else gh_html_url,
            issue_tracker=str(payload.issue_tracker) if payload.issue_tracker else None,
            author_name=payload.author_name or gh_owner_login,
            visibility=payload.visibility,
            status=AppStatus.DRAFT,
            owner_id=user.id,
            apks=[],
            screenshots=[],
            localizations=[],
        )
        db.add(app)
        await db.flush()

        apk = await attach_apk_to_app(
            db, app=app, tmp_path=tmp_path, meta=meta, uploader=user
        )
        # Retention enforcement (no-op on a fresh app with one APK).
        from app.services.apk_eviction import evict_oldest_if_needed
        await evict_oldest_if_needed(db, app=app, actor_id=user.id)

        # 4. Wire the persistent GithubSource so the cron can keep
        # importing future releases. Snapshot the just-imported tag so
        # the next scan considers it up_to_date instead of re-importing.
        db.add(
            GithubSource(
                app_id=app.id,
                repo=repo,
                provider=provider_enum,
                base_url=base_url,
                asset_pattern=pattern,
                include_prereleases=payload.include_prereleases,
                enabled=True,
                last_release_tag=asset.release_tag,
                last_release_published_at=asset.release_published_at,
                last_scanned_at=_dt.now(_UTC),
                last_status=GithubSourceStatus.IMPORTED,
                created_by=user.id,
                # Encrypt + persist the PAT alongside the source so the
                # daily cron uses the same credential. None means the
                # cron falls back to the env-var default.
                access_token_encrypted=_encrypt_token(raw_token) if raw_token else None,
            )
        )

        if apk.status == ApkStatus.PUBLISHED:
            await enqueue_reindex()

        # 5. Reload with eager relationships for the response. We must
        # also hydrate ``localizations`` because AppDetail iterates it
        # during serialisation and a lazy load inside an async context
        # would raise MissingGreenlet.
        result = (
            await db.execute(
                select(App)
                .execution_options(populate_existing=True)
                .options(
                    selectinload(App.categories),
                    selectinload(App.apks),
                    selectinload(App.owner),
                    selectinload(App.screenshots),
                    selectinload(App.localizations),
                )
                .where(App.id == app.id)
            )
        ).scalar_one()
        out = AppDetail.model_validate(result)
        out.owner_username = result.owner.username if result.owner else None
        _attach_media_token(out, result, user)
        return out
    finally:
        tmp_path.unlink(missing_ok=True)


@router.post("/import-metadata")
async def import_metadata(
    payload: dict,
    user: Annotated[User, Depends(get_current_uploader)],
) -> dict:
    """Parse a pasted ``metadata.yml`` (fdroiddata upstream format) and
    return a flat dict the New App page can use to prefill its fields.

    Body: ``{"yaml": "<the raw metadata.yml content>"}``.

    Returns the parsed dict — no DB writes. The user is responsible for
    reviewing the prefilled values before submitting the actual create
    request. We don't try to match category names against the local
    taxonomy here (the UI does that with its loaded category list).
    """
    from app.services.metadata_import import parse_metadata_yaml

    raw = payload.get("yaml") if isinstance(payload, dict) else None
    if not isinstance(raw, str):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Body must be {\"yaml\": \"...\"}",
        )
    return parse_metadata_yaml(raw)


@router.post("", response_model=AppRead, status_code=status.HTTP_201_CREATED)
async def create_app(
    payload: AppCreate,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> AppRead:
    from app.services.quotas import ensure_can_create_app

    await ensure_can_create_app(db, user)
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
    # Re-query with ``selectinload(App.categories)`` before Pydantic
    # walks the instance. ``AppRead.categories`` is a list of
    # CategoryRead; without the eager load the sync attribute access
    # triggers SQLAlchemy's async lazy-loader, which raises
    # ``MissingGreenlet`` from the FastAPI response thread. The two
    # ``create_app_with_*`` siblings already do this — this single-
    # APK-free create path was the outlier.
    # ``populate_existing=True`` forces SQLAlchemy to overwrite the
    # identity-map cache for this row. Without it the re-query returns
    # the SAME ORM instance we just inserted — still without
    # ``categories`` / ``apks`` eagerly loaded — and Pydantic walks
    # straight into the lazy load.
    #
    # ``apks`` matters because ``App.is_nsfw`` (rendered as
    # ``AppRead.is_nsfw``) is a ``@property`` that iterates over
    # ``self.apks``. Without the eager load the @property triggers a
    # lazy load in the Pydantic sync walker — the visible attribute
    # is scalar but the path to it is async I/O.
    result = (
        await db.execute(
            select(App)
            .execution_options(populate_existing=True)
            .options(
                selectinload(App.categories),
                selectinload(App.apks),
            )
            .where(App.id == app.id)
        )
    ).scalar_one()
    payload = AppRead.model_validate(result)
    _attach_media_token(payload, result, user)
    return payload


async def _load_app_or_404(db, app_id_or_pkg: str) -> App:
    stmt = select(App).options(
        selectinload(App.categories),
        selectinload(App.apks),
        selectinload(App.owner),
        selectinload(App.screenshots),
        selectinload(App.localizations),
        # github_source is a 1:1 backref — pulling it eagerly costs one
        # extra round-trip and lets the YAML export endpoint render the
        # ``Repo:`` field without re-querying.
        selectinload(App.github_source),
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
    raw: bool = Query(
        default=False,
        description="Skip preferred-locale overlay and return the canonical "
        "en-US fields. Used by the owner edit form so saving doesn't write "
        "the localized strings back into the default columns.",
    ),
) -> AppDetail:
    app = await _load_app_or_404(db, app_ref)
    if not _app_visible_to(app, user):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App not found")
    download_count = int(
        (
            await db.execute(
                select(func.count(DownloadEvent.id)).where(DownloadEvent.app_id == app.id)
            )
        ).scalar_one()
    )
    payload = AppDetail.model_validate(app)
    payload.owner_username = app.owner.username if app.owner else None
    payload.download_count = download_count
    _attach_media_token(payload, app, user)
    # Resolved retention cap — computed server-side so the manage
    # page banner doesn't need to fetch admin-only RepoConfig. We
    # also surface the raw repo default so the admin override input
    # can render "Repo default: N" as guidance.
    from app.models.repo_config import RepoConfig
    from app.services.apk_eviction import effective_max_versions
    _cfg = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
    payload.effective_max_versions = effective_max_versions(app, _cfg)
    payload.repo_default_max_versions = _cfg.default_max_versions_per_app if _cfg else None
    if not raw:
        _apply_locale(payload, app, user.preferred_locale if user else None)
    return payload


@router.patch("/{app_id}", response_model=AppRead)
async def update_app(
    app_id: uuid.UUID,
    payload: AppUpdate,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> AppRead:
    from app.services.app_permissions import assert_can_manage_app, is_owner_or_admin

    app = await _load_app_or_404(db, str(app_id))
    await assert_can_manage_app(db, user, app)
    # Visibility flips are owner-only — co-maintainers shouldn't be able to
    # unpublish a public app or expose a private one.
    if payload.visibility is not None and not is_owner_or_admin(user, app):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the owner can change visibility",
        )

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
    # ``model_fields_set`` lets us distinguish "field omitted" from
    # "explicitly null" — the latter clears the manual pin and reverts to
    # auto-tracking.
    if "suggested_version_code" in payload.model_fields_set:
        await _apply_suggested_version_override(app, payload.suggested_version_code)

    await db.flush()
    await enqueue_reindex()
    payload = AppRead.model_validate(app)
    _attach_media_token(payload, app, user)
    return payload


async def _apply_suggested_version_override(
    app: App, version_code: int | None,
) -> None:
    """Set or clear the manually-pinned suggested version.

    Pinning to a concrete ``version_code`` is only allowed when a published
    APK on the same app actually carries it — otherwise the F-Droid client
    would advertise a version that nobody can install. Passing ``None``
    clears the pin and re-runs the auto-bump against whatever's published
    today so the recommended version snaps to the highest published code.
    """
    if version_code is None:
        app.suggested_version_is_manual = False
        published = [a for a in app.apks if a.status == ApkStatus.PUBLISHED]
        if published:
            top = max(published, key=lambda a: a.version_code)
            app.suggested_version_code = top.version_code
            app.suggested_version_name = top.version_name
        else:
            app.suggested_version_code = None
            app.suggested_version_name = None
        return

    target = next(
        (a for a in app.apks if a.version_code == version_code and a.status == ApkStatus.PUBLISHED),
        None,
    )
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "suggested_version_code must match a published APK on this app."
            ),
        )
    app.suggested_version_is_manual = True
    app.suggested_version_code = target.version_code
    app.suggested_version_name = target.version_name


@router.delete("/{app_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None, response_class=Response)
async def delete_app(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> None:
    from app.services.app_permissions import assert_owner_or_admin

    app = await _load_app_or_404(db, str(app_id))
    # Delete is owner-only — co-maintainers must never be able to wipe an
    # app they don't own. Admins still bypass.
    assert_owner_or_admin(user, app)
    await db.delete(app)
    await db.flush()


# --------------------------------------------------------------------------
# Localizations — per-locale overrides on top of the app-level defaults.
# --------------------------------------------------------------------------

# BCP47 locale tag: a primary subtag (2-3 letters or 4-letter script-like),
# optionally followed by a region subtag. Kept tight enough to reject obvious
# garbage in the URL while still accepting anything F-Droid clients honour
# (e.g. ``en``, ``en-US``, ``pt-BR``, ``zh-Hans``).
_LOCALE_RE = re.compile(r"^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,4})?$")


@router.get("/{app_id}/metadata.yml", response_class=Response)
async def export_metadata_yaml(
    app_id: uuid.UUID,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> Response:
    """Download the F-Droid ``metadata.yml`` for an app.

    Permission mirrors the rest of the per-app mutation endpoints — the
    owner, any collaborator, and any admin can fetch the file. We don't
    expose this publicly because the export includes the canonical
    description / category set as the owner curated them, which can
    differ from the localised public listing and may name a contact
    email the owner doesn't want scraped from an open endpoint.

    Returns ``text/yaml`` with a ``Content-Disposition: attachment``
    header so the browser saves it as ``<package>.yml`` rather than
    rendering it inline. The content is generated by
    :func:`services.fdroid_metadata.serialize_metadata_yaml`, which
    handles the canonical field order, literal-block ``Description``
    and the binary-only ``Builds[]`` shape pointing at this repo's
    APK URLs.
    """
    from app.services.app_permissions import assert_can_manage_app
    from app.services.fdroid_metadata import serialize_metadata_yaml
    from app.models.repo_config import RepoConfig

    app = await _load_app_or_404(db, str(app_id))
    await assert_can_manage_app(db, user, app)
    repo_config = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
    body = serialize_metadata_yaml(app, repo_config=repo_config)
    # ``filename*=utf-8''…`` is the RFC 6266 form — supports non-ASCII
    # package names. Standard package ids are ASCII-only in practice
    # but the encoding is cheap and future-proof.
    safe_name = app.package_name.replace('"', "")
    return Response(
        content=body,
        media_type="text/yaml; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{safe_name}.yml"',
            # Caches must not collapse this across users — the file is
            # gated on owner / collab membership.
            "Cache-Control": "private, no-store",
        },
    )


async def _require_owner_or_admin(db, app_id: uuid.UUID, user: User) -> App:
    """Despite the historical name, this now accepts co-maintainers too —
    the helper is used by listing-edit endpoints (localizations,
    screenshots, banners) where collaborators have full rights.
    """
    from app.services.app_permissions import assert_can_manage_app

    app = await _load_app_or_404(db, str(app_id))
    await assert_can_manage_app(db, user, app)
    return app


@router.put("/{app_id}/localizations/{locale}", response_model=LocalizationRead)
async def upsert_localization(
    app_id: uuid.UUID,
    locale: str,
    payload: LocalizationUpsert,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> LocalizationRead:
    """Create or replace a per-locale override row.

    ``locale`` is a BCP47 tag like ``fr-FR``. At least one of the payload
    fields must be non-null — an empty PUT means "delete me", so we ask the
    caller to use DELETE instead.
    """
    if not _LOCALE_RE.match(locale):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Locale must look like 'en' or 'en-US' (BCP47).",
        )
    if not any(
        getattr(payload, f) is not None and getattr(payload, f) != ""
        for f in ("name", "summary", "description", "video")
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one of name / summary / description / video must be set.",
        )
    app = await _require_owner_or_admin(db, app_id, user)
    existing = next((loc for loc in app.localizations if loc.locale == locale), None)
    if existing is None:
        row = Localization(
            app_id=app.id,
            locale=locale,
            name=payload.name,
            summary=payload.summary,
            description=payload.description,
            video=payload.video,
        )
        db.add(row)
    else:
        existing.name = payload.name
        existing.summary = payload.summary
        existing.description = payload.description
        existing.video = payload.video
        row = existing
    await db.flush()
    await enqueue_reindex()
    return LocalizationRead.model_validate(row)


@router.delete(
    "/{app_id}/localizations/{locale}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_localization(
    app_id: uuid.UUID,
    locale: str,
    db: DbSession,
    user: Annotated[User, Depends(get_current_uploader)],
) -> None:
    if not _LOCALE_RE.match(locale):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Bad locale")
    app = await _require_owner_or_admin(db, app_id, user)
    target = next((loc for loc in app.localizations if loc.locale == locale), None)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    await db.delete(target)
    await db.flush()
    await enqueue_reindex()
