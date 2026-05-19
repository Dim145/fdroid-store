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

The endpoint is unauthenticated by design — feed readers don't carry
session cookies, and the underlying data is already the public catalogue.
Private apps never appear.
"""
from __future__ import annotations

import html
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Query, Response
from sqlalchemy import desc, select
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession
from app.models.app import App, AppStatus, AppVisibility, Category
from app.models.repo_config import RepoConfig

router = APIRouter()


def _xml_escape(text: str | None) -> str:
    return html.escape(text or "", quote=True)


async def _repo_base(db) -> str:
    config = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
    return (config.address.rstrip("/") if config and config.address else "")


def _atom_entry(
    app: App,
    base: str,
    published: datetime,
    title_prefix: str,
) -> str:
    pkg = app.package_name
    title = f"{title_prefix}{app.name}"
    summary = app.summary or ""
    link = f"{base}/apps/{pkg}" if base else f"/apps/{pkg}"
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
    base: str,
    published: datetime,
    title_prefix: str,
) -> str:
    pkg = app.package_name
    title = f"{title_prefix}{app.name}"
    summary = app.summary or ""
    link = f"{base}/apps/{pkg}" if base else f"/apps/{pkg}"
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


async def _load_apps_for_feed(
    db,
    *,
    order_col,
    category: str | None,
    author: str | None,
    nsfw_visible: bool,
    limit: int,
) -> list[App]:
    """Common loader. ``order_col`` is the column we sort by descending —
    ``last_published_at`` for the updates feed, ``created_at`` for new.

    ``is_nsfw`` is a Python property that walks ``app.apks.anti_features``,
    not a column, so it can't be pushed into the SQL ``WHERE``. We
    over-fetch (``limit * 2``) then filter in Python — the catalogue is
    small enough that the cost is negligible and it keeps the loader
    symmetrical with the repo-builder behaviour.
    """
    fetch_limit = limit * 2 if not nsfw_visible else limit
    stmt = (
        select(App)
        .options(selectinload(App.categories), selectinload(App.apks))
        .where(
            App.status == AppStatus.PUBLISHED,
            App.visibility == AppVisibility.PUBLIC,
        )
        .order_by(desc(order_col))
        .limit(fetch_limit)
    )
    if author:
        stmt = stmt.where(App.author_name == author)
    rows = list((await db.execute(stmt)).scalars().unique().all())

    if not nsfw_visible:
        rows = [a for a in rows if not a.is_nsfw]
    if category:
        cat_ids = {
            c for c, in (
                await db.execute(select(Category.id).where(Category.name == category))
            ).all()
        }
        rows = [a for a in rows if any(c.id in cat_ids for c in a.categories)]
    return rows[:limit]


@router.get("/new")
async def feed_new(
    db: DbSession,
    response: Response,
    format: Literal["atom", "rss"] = Query(default="atom"),
    category: str | None = Query(default=None, max_length=64),
    author: str | None = Query(default=None, max_length=255),
    nsfw: Literal["on", "off"] = Query(default="off"),
    limit: int = Query(default=20, ge=1, le=50),
) -> Response:
    apps = await _load_apps_for_feed(
        db,
        order_col=App.created_at,
        category=category,
        author=author,
        nsfw_visible=(nsfw == "on"),
        limit=limit,
    )
    base = await _repo_base(db)
    self_url = f"{base}/api/v1/feed/new" if base else "/api/v1/feed/new"

    if format == "rss":
        items = "".join(_rss_item(a, base, a.created_at, "") for a in apps)
        body = _wrap_rss("New apps", self_url, items)
        media = "application/rss+xml; charset=utf-8"
    else:
        entries = "".join(_atom_entry(a, base, a.created_at, "") for a in apps)
        body = _wrap_atom("New apps", self_url, entries)
        media = "application/atom+xml; charset=utf-8"
    return Response(content=body, media_type=media)


@router.get("/updates")
async def feed_updates(
    db: DbSession,
    response: Response,
    format: Literal["atom", "rss"] = Query(default="atom"),
    category: str | None = Query(default=None, max_length=64),
    author: str | None = Query(default=None, max_length=255),
    nsfw: Literal["on", "off"] = Query(default="off"),
    limit: int = Query(default=20, ge=1, le=50),
) -> Response:
    apps = await _load_apps_for_feed(
        db,
        order_col=App.last_published_at,
        category=category,
        author=author,
        nsfw_visible=(nsfw == "on"),
        limit=limit,
    )
    base = await _repo_base(db)
    self_url = f"{base}/api/v1/feed/updates" if base else "/api/v1/feed/updates"

    def _ts(a: App) -> datetime:
        return a.last_published_at or a.created_at

    if format == "rss":
        items = "".join(_rss_item(a, base, _ts(a), "Updated: ") for a in apps)
        body = _wrap_rss("App updates", self_url, items)
        media = "application/rss+xml; charset=utf-8"
    else:
        entries = "".join(_atom_entry(a, base, _ts(a), "Updated: ") for a in apps)
        body = _wrap_atom("App updates", self_url, entries)
        media = "application/atom+xml; charset=utf-8"
    return Response(content=body, media_type=media)
