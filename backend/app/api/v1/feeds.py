"""RSS / Atom subscription feeds.

Two streams:
  * ``/feed/new``     — newest PUBLISHED + PUBLIC apps
  * ``/feed/updates`` — apps that just got a new published APK

Both accept the same filter query params:
  * ``category=Games`` — narrow to a category (exact match on the
    canonical category name)
  * ``author=…``      — exact ``author_name`` match
  * ``nsfw=on|off``   — show or hide NSFW entries (default: hidden)
  * ``limit=20``      — items per feed, 1–50 (default 20)

Format is selected by query param ``?format=atom|rss`` (default ``atom``).
Both serialisations are produced by hand: a single feed has at most 50
entries and the spec surface is small enough that pulling in feedgen would
be more dependency than it's worth.

In public mode the feeds are anonymous — feed readers don't carry session
cookies, and the underlying data is already the public catalogue. Private
apps never appear. In private mode they need what the rest of the API
needs: a JWT, or an API key over HTTP Basic (which feed readers can send).
"""
from __future__ import annotations

import html
import re
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import case, func, select, true
from sqlalchemy.orm import selectinload

from app.api.deps import (
    DbSession,
    get_api_key_from_basic_auth,
    get_current_user_optional,
    require_repo_access,
)
from app.core.config import settings
from app.models.apk import Apk, ApkStatus
from app.models.app import App, AppStatus, AppVisibility, Category
from app.models.api_key import ApiKey
from app.models.user import User, UserRole

router = APIRouter()

_BASIC_CHALLENGE = {"WWW-Authenticate": 'Basic realm="fdroid-store"'}


async def require_feed_access(
    db: DbSession,
    viewer: Annotated[User | None, Depends(get_current_user_optional)],
    api_key: Annotated[ApiKey | None, Depends(get_api_key_from_basic_auth)],
) -> None:
    """``require_browse_access`` for feeds: in private mode a JWT or an API
    key is required. A feed reader can only send the latter, so the 401
    carries ``require_repo_access``'s Basic challenge (the reader prompts
    for the key) instead of the bare one of the browse API."""
    if viewer is None:
        await require_repo_access(db, api_key)


def _wants_inline_xml(request: Request) -> bool:
    """Did this request come from a browser address bar?

    Browsers send ``Accept: text/html,application/xhtml+xml,...`` while
    feed readers send ``application/rss+xml`` or ``application/atom+xml``
    (often without ``text/html`` at all). When the client clearly prefers
    HTML we hand back ``application/xml`` instead of the RSS/Atom MIME so
    the browser renders the document inline with its built-in XML viewer
    instead of triggering a download.

    Feed readers don't care about the exact content-type — they parse
    whatever they're handed.
    """
    accept = (request.headers.get("accept") or "").lower()
    if not accept or accept == "*/*":
        return False
    # A genuine feed reader always names the format it wants. If neither
    # ``rss+xml`` nor ``atom+xml`` shows up in Accept, treat the caller as
    # a browser.
    feedy = "rss+xml" in accept or "atom+xml" in accept
    return "text/html" in accept and not feedy


# XML 1.0 forbids most C0 control characters (everything 0x00-0x1F except
# tab, LF, CR). ``html.escape`` doesn't strip them, so an uploader who
# slips a NUL byte into ``whats_new`` would break every strict feed reader
# subscribed to their app. Drop them before escaping.
_XML_INVALID_CHARS = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F]")


def _xml_escape(text: str | None) -> str:
    return html.escape(_XML_INVALID_CHARS.sub("", text or ""), quote=True)


def _app_link(package_name: str) -> str:
    """The app's page in the web UI — the URL index-v2 also gives F-Droid's
    "Share" action (``webBaseUrl``). The repo address (``…/fdroid/repo``)
    serves no ``/apps/<pkg>`` page."""
    return f"{settings.public_app_url.rstrip('/')}/apps/{package_name}"


def _self_link(path: str) -> str:
    """Absolute URL of a feed (``path`` is relative to ``/api/v1``)."""
    return f"{settings.public_api_url.rstrip('/')}/api/v1{path}"


def _atom_entry(
    app: App,
    published: datetime,
    title_prefix: str,
) -> str:
    title = f"{title_prefix}{app.name}"
    summary = app.summary or ""
    link = _app_link(app.package_name)
    return (
        "  <entry>\n"
        f"    <title>{_xml_escape(title)}</title>\n"
        f"    <id>urn:fdroid-store:app:{_xml_escape(str(app.id))}:{int(published.timestamp())}</id>\n"
        f"    <updated>{published.strftime('%Y-%m-%dT%H:%M:%SZ')}</updated>\n"
        f"    <link rel=\"alternate\" href=\"{_xml_escape(link)}\"/>\n"
        f"    <summary>{_xml_escape(summary)}</summary>\n"
        "  </entry>\n"
    )


def _rss_item(
    app: App,
    published: datetime,
    title_prefix: str,
) -> str:
    title = f"{title_prefix}{app.name}"
    summary = app.summary or ""
    link = _app_link(app.package_name)
    pub = published.strftime("%a, %d %b %Y %H:%M:%S +0000")
    return (
        "    <item>\n"
        f"      <title>{_xml_escape(title)}</title>\n"
        f"      <link>{_xml_escape(link)}</link>\n"
        f"      <guid isPermaLink=\"false\">urn:fdroid-store:app:{_xml_escape(str(app.id))}:{int(published.timestamp())}</guid>\n"
        f"      <pubDate>{pub}</pubDate>\n"
        f"      <description>{_xml_escape(summary)}</description>\n"
        "    </item>\n"
    )


def _wrap_atom(title: str, self_url: str, entries: str) -> str:
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    return (
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
        "<feed xmlns=\"http://www.w3.org/2005/Atom\">\n"
        f"  <title>{_xml_escape(title)}</title>\n"
        f"  <id>{_xml_escape(self_url)}</id>\n"
        f"  <updated>{now}</updated>\n"
        f"  <link rel=\"self\" href=\"{_xml_escape(self_url)}\"/>\n"
        f"{entries}"
        "</feed>\n"
    )


def _wrap_rss(title: str, self_url: str, items: str) -> str:
    return (
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
        "<rss version=\"2.0\">\n"
        "  <channel>\n"
        f"    <title>{_xml_escape(title)}</title>\n"
        f"    <link>{_xml_escape(self_url)}</link>\n"
        f"    <description>{_xml_escape(title)}</description>\n"
        f"{items}"
        "  </channel>\n"
        "</rss>\n"
    )


def _has_nsfw_apk():
    """SQL twin of ``App.is_nsfw`` (correlated on ``App``): some APK of the
    app carries the NSFW anti-feature. Labels are free-form, so they are
    matched trimmed and case-insensitively, as the property does."""
    flags = (
        func.json_array_elements_text(
            case(
                (func.json_typeof(Apk.anti_features) == "array", Apk.anti_features),
                else_=func.json_build_array(),
            )
        )
        .table_valued("value")
        .render_derived(name="nsfw_flag")
    )
    return (
        select(Apk.id)
        .join(flags, true())
        .where(Apk.app_id == App.id, func.lower(func.btrim(flags.c.value)) == "nsfw")
        .exists()
    )


async def _load_apps_for_feed(
    db,
    *,
    order_by,
    category: str | None,
    author: str | None,
    nsfw_visible: bool,
    limit: int,
) -> list[App]:
    """Common loader. ``order_by`` is the expression we sort by descending.

    Every filter runs in SQL, before the ``LIMIT``: filtering a fetched page
    afterwards returned short (or empty) feeds whenever the newest rows were
    NSFW or in other categories.
    """
    stmt = (
        select(App)
        .where(
            App.status == AppStatus.PUBLISHED,
            App.visibility == AppVisibility.PUBLIC,
        )
        .order_by(order_by.desc())
        .limit(limit)
    )
    if author:
        stmt = stmt.where(App.author_name == author)
    if category:
        stmt = stmt.where(App.categories.any(Category.name == category))
    if not nsfw_visible:
        stmt = stmt.where(~_has_nsfw_apk())
    return list((await db.execute(stmt)).scalars().all())


def _first_published(a: App) -> datetime:
    return a.first_published_at or a.created_at


def _last_published(a: App) -> datetime:
    return a.last_published_at or a.created_at


@router.get("/new", dependencies=[Depends(require_feed_access)])
async def feed_new(
    db: DbSession,
    request: Request,
    format: Literal["atom", "rss"] = Query(default="atom"),
    category: str | None = Query(default=None, max_length=64),
    author: str | None = Query(default=None, max_length=255),
    nsfw: Literal["on", "off"] = Query(default="off"),
    limit: int = Query(default=20, ge=1, le=50),
) -> Response:
    # "New" = newest to go live, not newest draft: an app created long ago
    # and published today is new (``first_published_at``, NULL for legacy
    # rows → ``created_at``; same rule as the index ``added`` field).
    apps = await _load_apps_for_feed(
        db,
        order_by=func.coalesce(App.first_published_at, App.created_at),
        category=category,
        author=author,
        nsfw_visible=(nsfw == "on"),
        limit=limit,
    )
    self_url = _self_link("/feed/new")

    if format == "rss":
        items = "".join(_rss_item(a, _first_published(a), "") for a in apps)
        body = _wrap_rss("New apps", self_url, items)
        feed_media = "application/rss+xml; charset=utf-8"
    else:
        entries = "".join(_atom_entry(a, _first_published(a), "") for a in apps)
        body = _wrap_atom("New apps", self_url, entries)
        feed_media = "application/atom+xml; charset=utf-8"
    media = "application/xml; charset=utf-8" if _wants_inline_xml(request) else feed_media
    return Response(content=body, media_type=media)


@router.get("/updates", dependencies=[Depends(require_feed_access)])
async def feed_updates(
    db: DbSession,
    request: Request,
    format: Literal["atom", "rss"] = Query(default="atom"),
    category: str | None = Query(default=None, max_length=64),
    author: str | None = Query(default=None, max_length=255),
    nsfw: Literal["on", "off"] = Query(default="off"),
    limit: int = Query(default=20, ge=1, le=50),
) -> Response:
    # Sorted by the timestamp each entry shows (a NULL ``last_published_at``
    # would otherwise sort first under DESC).
    apps = await _load_apps_for_feed(
        db,
        order_by=func.coalesce(App.last_published_at, App.created_at),
        category=category,
        author=author,
        nsfw_visible=(nsfw == "on"),
        limit=limit,
    )
    self_url = _self_link("/feed/updates")

    if format == "rss":
        items = "".join(_rss_item(a, _last_published(a), "Updated: ") for a in apps)
        body = _wrap_rss("App updates", self_url, items)
        feed_media = "application/rss+xml; charset=utf-8"
    else:
        entries = "".join(_atom_entry(a, _last_published(a), "Updated: ") for a in apps)
        body = _wrap_atom("App updates", self_url, entries)
        feed_media = "application/atom+xml; charset=utf-8"
    media = "application/xml; charset=utf-8" if _wants_inline_xml(request) else feed_media
    return Response(content=body, media_type=media)


# --------------------------------------------------------------------------
# Per-app release feed
# --------------------------------------------------------------------------
# Subscribes a feed reader to one specific app's release stream. Unlike the
# catalogue-wide ``/feed/new`` and ``/feed/updates`` which list APPS, this
# endpoint emits one entry per PUBLISHED APK of a given package — the user
# gets a notification whenever the owner pushes a new version, with the
# changelog body included if one was set.
#
# Private apps are reachable too, but only by a credential that legitimately
# sees the underlying app:
#   * API key in HTTP Basic — the same Basic-auth path the F-Droid client uses
#     for private repos. Lets the user paste a URL like
#     ``https://user:apikey@host/api/v1/feed/apps/com.foo`` into their reader.
#   * JWT bearer — the SPA session token, for the case where the SPA
#     surfaces a clickable "Subscribe" link from the edit page.
# Anonymous calls to a private-app feed get the same 401 as the index path,
# with ``WWW-Authenticate: Basic`` so the reader prompts for credentials —
# and so does an unknown package, or the 401 would confirm the private one.


def _apk_atom_entry(app: App, apk: Apk) -> str:
    """One ``<entry>`` per published APK. Title = ``<app> v<name> (<code>)``,
    body = the en-US changelog if any, link = the public app detail page."""
    title = f"{app.name} v{apk.version_name} ({apk.version_code})"
    note = ""
    if isinstance(apk.whats_new, dict):
        # ``whats_new`` is the per-locale dict; pick en-US first, then any
        # locale that happens to have content.
        for loc in ("en-US", "en", *apk.whats_new.keys()):
            v = apk.whats_new.get(loc)
            if isinstance(v, str) and v.strip():
                note = v.strip()
                break
    when = apk.created_at
    link = _app_link(app.package_name)
    return (
        "  <entry>\n"
        f"    <title>{_xml_escape(title)}</title>\n"
        f"    <id>urn:fdroid-store:apk:{_xml_escape(str(apk.id))}</id>\n"
        f"    <updated>{when.strftime('%Y-%m-%dT%H:%M:%SZ')}</updated>\n"
        f"    <link rel=\"alternate\" href=\"{_xml_escape(link)}\"/>\n"
        f"    <summary>{_xml_escape(note)}</summary>\n"
        "  </entry>\n"
    )


def _apk_rss_item(app: App, apk: Apk) -> str:
    title = f"{app.name} v{apk.version_name} ({apk.version_code})"
    note = ""
    if isinstance(apk.whats_new, dict):
        for loc in ("en-US", "en", *apk.whats_new.keys()):
            v = apk.whats_new.get(loc)
            if isinstance(v, str) and v.strip():
                note = v.strip()
                break
    when = apk.created_at
    link = _app_link(app.package_name)
    pub = when.strftime("%a, %d %b %Y %H:%M:%S +0000")
    return (
        "    <item>\n"
        f"      <title>{_xml_escape(title)}</title>\n"
        f"      <link>{_xml_escape(link)}</link>\n"
        f"      <guid isPermaLink=\"false\">urn:fdroid-store:apk:{_xml_escape(str(apk.id))}</guid>\n"
        f"      <pubDate>{pub}</pubDate>\n"
        f"      <description>{_xml_escape(note)}</description>\n"
        "    </item>\n"
    )


async def _can_see_private_app(
    db,
    app: App,
    viewer: User | None,
    api_key: ApiKey | None,
) -> bool:
    """The same gate as ``/fdroid/repo/*`` for private assets: admin OR
    owner OR collaborator OR matching API key. An API key needs the
    ``can_download_private`` scope (as on the repo path) and an enabled
    owner. There's no eager ``App.collaborators`` relationship in the
    model, so we issue a dedicated ``SELECT 1 FROM app_collaborators``
    when needed."""
    candidate_user_id = None
    if viewer is not None:
        if viewer.role == UserRole.ADMIN:
            return True
        candidate_user_id = viewer.id
    elif api_key is not None and api_key.can_download_private and api_key.user_id is not None:
        # ``api_key.user`` may be lazy and we're in async land — load the
        # user explicitly via a scalar query rather than the attribute access.
        api_user = (
            await db.execute(select(User).where(User.id == api_key.user_id))
        ).scalar_one_or_none()
        if api_user is None or not api_user.is_active:
            return False
        if api_user.role == UserRole.ADMIN:
            return True
        candidate_user_id = api_user.id
    if candidate_user_id is None:
        return False
    if app.owner_id is not None and app.owner_id == candidate_user_id:
        return True
    from app.models.app_collaborator import AppCollaborator
    row = (
        await db.execute(
            select(AppCollaborator.id).where(
                AppCollaborator.app_id == app.id,
                AppCollaborator.user_id == candidate_user_id,
            )
        )
    ).scalar_one_or_none()
    return row is not None


@router.get("/apps/{package_name}", dependencies=[Depends(require_feed_access)])
async def feed_app_releases(
    package_name: str,
    db: DbSession,
    request: Request,
    viewer: Annotated[User | None, Depends(get_current_user_optional)],
    api_key: Annotated[ApiKey | None, Depends(get_api_key_from_basic_auth)],
    format: Literal["atom", "rss"] = Query(default="atom"),
    limit: int = Query(default=20, ge=1, le=50),
) -> Response:
    """Release feed for one app — one entry per published APK, desc by
    version_code. An unknown package answers exactly like a private one
    the caller can't see, so the endpoint can't enumerate private package
    names."""
    app = (
        await db.execute(
            select(App)
            .options(selectinload(App.apks))
            .where(App.package_name == package_name)
        )
    ).scalar_one_or_none()
    visible = (
        app is not None
        and app.status == AppStatus.PUBLISHED
        and (
            app.visibility == AppVisibility.PUBLIC
            or await _can_see_private_app(db, app, viewer, api_key)
        )
    )
    if not visible:
        # Unknown, unpublished and not-entitled look the same: anonymous →
        # 401 + Basic challenge (a reader can then prompt for an API key),
        # authenticated → 404. Never 401-for-private / 404-for-unknown.
        if viewer is None and api_key is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication required",
                headers=_BASIC_CHALLENGE,
            )
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="App not found")

    published = sorted(
        (a for a in (app.apks or []) if a.status == ApkStatus.PUBLISHED),
        key=lambda a: a.version_code,
        reverse=True,
    )[:limit]

    self_url = _self_link(f"/feed/apps/{app.package_name}")
    feed_title = f"{app.name} — releases"

    if format == "rss":
        items = "".join(_apk_rss_item(app, a) for a in published)
        body = _wrap_rss(feed_title, self_url, items)
        feed_media = "application/rss+xml; charset=utf-8"
    else:
        entries = "".join(_apk_atom_entry(app, a) for a in published)
        body = _wrap_atom(feed_title, self_url, entries)
        feed_media = "application/atom+xml; charset=utf-8"
    media = "application/xml; charset=utf-8" if _wants_inline_xml(request) else feed_media
    return Response(content=body, media_type=media)
