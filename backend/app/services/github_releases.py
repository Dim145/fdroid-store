"""GitHub releases polling — fetch the latest APK from a repo's releases.

The service is intentionally narrow: given a ``owner/name`` repo and a
glob pattern, it returns at most one ``ReleaseAsset`` describing the
matching APK in the most recent eligible release, or ``None`` when
nothing matches. Downloads are streamed to a tmpfile so a huge APK
doesn't fault the worker's heap.

Auth is optional via ``settings.github_token`` — without it we get the
60 req/hour anonymous bucket, which is fine for a handful of sources
but starts to bite at scale.
"""
from __future__ import annotations

import fnmatch
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import httpx

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)


_GH_API = "https://api.github.com"
_USER_AGENT = "fdroid-store/github-releases"
# GitHub release API max per_page = 100. We scan the first page only —
# if a maintainer publishes 100+ releases between two scans the older
# ones won't be backfilled. Acceptable trade-off for v1.
_PER_PAGE = 30

# ``owner/name`` validated leniently — GitHub allows letters/digits/dashes
# in names and additionally dots/underscores in repos. Keep the regex
# strict enough to reject obvious garbage early (URLs, paths, etc.).
_REPO_RE = re.compile(r"^[A-Za-z0-9][\w.-]{0,38}/[A-Za-z0-9._-]+$")


class GithubReleaseError(RuntimeError):
    """Raised when GitHub returns a 4xx/5xx or the repo is unreachable."""


@dataclass(frozen=True)
class ReleaseAsset:
    """The single APK selected from a release."""
    release_tag: str
    release_name: str | None
    release_published_at: datetime
    is_prerelease: bool
    asset_id: int
    asset_name: str
    asset_size: int
    asset_download_url: str


@dataclass(frozen=True)
class RepoMetadata:
    """Subset of the ``GET /repos/{owner}/{repo}`` payload that we use to
    prefill an App's listing fields. All fields are optional except the
    repo URL itself."""
    html_url: str
    description: str | None
    homepage: str | None
    license_spdx: str | None
    owner_login: str | None


def validate_repo(repo: str) -> str:
    """Normalise + reject anything that doesn't match ``owner/name``.

    Strips leading ``https://github.com/`` and trailing ``.git`` so users
    can paste a clone URL. Raises ``ValueError`` on bad input.
    """
    s = repo.strip()
    for prefix in ("https://github.com/", "http://github.com/", "git@github.com:"):
        if s.lower().startswith(prefix):
            s = s[len(prefix):]
            break
    if s.endswith(".git"):
        s = s[:-4]
    s = s.strip("/")
    if not _REPO_RE.match(s):
        raise ValueError(f"Expected owner/name, got {repo!r}")
    return s


def _auth_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": _USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if settings.github_token:
        headers["Authorization"] = f"Bearer {settings.github_token}"
    return headers


async def fetch_repo_metadata(repo: str) -> RepoMetadata | None:
    """Pull description / homepage / license / owner from GitHub.

    Used to prefill an App's listing when the user creates from GitHub
    or connects a source to an existing app. Best-effort: a non-2xx
    response returns ``None`` so the caller falls back to manual entry
    instead of failing the whole create flow.
    """
    url = f"{_GH_API}/repos/{repo}"
    timeout = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout, headers=_auth_headers()) as client:
        try:
            resp = await client.get(url)
        except httpx.RequestError:
            return None
    if resp.status_code != 200:
        return None
    try:
        data = resp.json()
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None

    license_info = data.get("license") if isinstance(data.get("license"), dict) else None
    owner = data.get("owner") if isinstance(data.get("owner"), dict) else None

    # Empty strings come back from GitHub when a field is unset on the
    # repo settings — normalize to ``None`` so callers can use truthiness.
    def _nz(value: object) -> str | None:
        if not isinstance(value, str):
            return None
        stripped = value.strip()
        return stripped or None

    homepage = _nz(data.get("homepage"))
    # Homepage often lacks a scheme ("example.com") because GitHub does
    # not enforce one. Prepend https:// so our HttpUrl validator accepts
    # it downstream. Anything that already looks like a URL is kept as-is.
    if homepage and "://" not in homepage:
        homepage = f"https://{homepage}"

    return RepoMetadata(
        html_url=str(data.get("html_url") or f"https://github.com/{repo}"),
        description=_nz(data.get("description")),
        homepage=homepage,
        license_spdx=_nz(license_info.get("spdx_id")) if license_info else None,
        owner_login=_nz(owner.get("login")) if owner else None,
    )


async def find_latest_asset(
    repo: str,
    *,
    asset_pattern: str | None,
    include_prereleases: bool,
) -> ReleaseAsset | None:
    """Return the most recent eligible release's matching APK, or None.

    Releases are walked in GitHub's default order (most recent first).
    The first release that satisfies prerelease/draft constraints AND
    contains an asset matching ``asset_pattern`` (defaulting to ``*.apk``)
    wins. If a release has a matching asset but is a draft, we skip it.
    """
    pattern = (asset_pattern or "").strip() or "*.apk"
    url = f"{_GH_API}/repos/{repo}/releases"
    params = {"per_page": str(_PER_PAGE)}

    timeout = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout, headers=_auth_headers()) as client:
        try:
            resp = await client.get(url, params=params)
        except httpx.RequestError as exc:
            raise GithubReleaseError(f"GitHub unreachable: {exc}") from exc

        if resp.status_code == 404:
            raise GithubReleaseError(f"Repository {repo!r} not found")
        if resp.status_code == 403:
            # Most often: rate limit. Surface the reset window so the
            # error message is actionable.
            remaining = resp.headers.get("X-RateLimit-Remaining")
            reset = resp.headers.get("X-RateLimit-Reset")
            raise GithubReleaseError(
                f"GitHub returned 403 (remaining={remaining}, reset_epoch={reset})"
            )
        if resp.status_code >= 400:
            raise GithubReleaseError(
                f"GitHub returned {resp.status_code}: {resp.text[:200]}"
            )

        releases = resp.json()

    if not isinstance(releases, list):
        raise GithubReleaseError("Unexpected GitHub response shape")

    for rel in releases:
        if not isinstance(rel, dict):
            continue
        if rel.get("draft"):
            continue
        if rel.get("prerelease") and not include_prereleases:
            continue
        assets = rel.get("assets") or []
        if not isinstance(assets, list):
            continue

        match = _pick_asset(assets, pattern)
        if match is None:
            continue
        try:
            published_at = datetime.fromisoformat(
                str(rel.get("published_at", "")).replace("Z", "+00:00")
            )
        except ValueError:
            continue
        return ReleaseAsset(
            release_tag=str(rel.get("tag_name", "")),
            release_name=rel.get("name") or None,
            release_published_at=published_at,
            is_prerelease=bool(rel.get("prerelease")),
            asset_id=int(match["id"]),
            asset_name=str(match["name"]),
            asset_size=int(match.get("size") or 0),
            asset_download_url=str(match["browser_download_url"]),
        )
    return None


def _pick_asset(assets: list[dict], pattern: str) -> dict | None:
    """First asset whose ``name`` matches the glob. APKs only."""
    # First pass: pattern match (case-insensitive on the asset name to be
    # lenient with releases that mix App-Release.apk and app-release.apk).
    for a in assets:
        name = str(a.get("name", ""))
        if not name.lower().endswith(".apk"):
            continue
        if fnmatch.fnmatchcase(name.lower(), pattern.lower()):
            return a
    return None


async def download_asset(asset: ReleaseAsset) -> Path:
    """Stream the asset to a NamedTemporaryFile and return its path.

    The caller MUST unlink the returned path in a ``finally`` block.
    GitHub's CDN serves the asset directly — the auth header is forwarded
    only on the initial 302 to the API endpoint; without a token we use
    ``browser_download_url`` which redirects to a presigned CDN URL.
    """
    # 256 MB hard ceiling. The repo's own APK cap is admin-configurable
    # and is re-checked downstream; this just stops a misconfigured
    # source from filling the worker tmpdir before the cap check.
    HARD_CAP = 256 * 1024 * 1024

    timeout = httpx.Timeout(connect=15.0, read=120.0, write=30.0, pool=15.0)
    # GitHub sometimes redirects to S3 which does NOT accept the Authorization
    # header. Use a client that drops the auth header on cross-host redirects.
    async with httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=True,
        headers={"User-Agent": _USER_AGENT, "Accept": "application/octet-stream"},
    ) as client:
        try:
            req_headers = {}
            if settings.github_token:
                # Required for private-repo asset downloads. GitHub's API
                # endpoint accepts the bearer; the redirect target drops it.
                req_headers["Authorization"] = f"Bearer {settings.github_token}"
            async with client.stream("GET", asset.asset_download_url, headers=req_headers) as resp:
                if resp.status_code >= 400:
                    raise GithubReleaseError(
                        f"Asset download failed: {resp.status_code}"
                    )
                tmp = tempfile.NamedTemporaryFile(suffix=".apk", delete=False)
                path = Path(tmp.name)
                total = 0
                try:
                    async for chunk in resp.aiter_bytes(1024 * 1024):
                        total += len(chunk)
                        if total > HARD_CAP:
                            tmp.close()
                            path.unlink(missing_ok=True)
                            raise GithubReleaseError(
                                f"Asset exceeds {HARD_CAP} byte hard cap"
                            )
                        tmp.write(chunk)
                finally:
                    tmp.close()
                return path
        except httpx.RequestError as exc:
            raise GithubReleaseError(f"Download error: {exc}") from exc
