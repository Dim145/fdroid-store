"""Release polling — fetches the latest matching APK from a git forge.

Dispatches on a ``provider`` arg so the same call sites can target
GitHub, GitLab or Gitea/Forgejo (including self-hosted instances via
``base_url``). Each provider adapter knows its own release-list shape,
asset URL shape and auth header.

Token wiring is per-provider via env: ``GITHUB_TOKEN``, ``GITLAB_TOKEN``,
``GITEA_TOKEN``. Without a token we fall back to the anonymous quota
(60 req/h on GitHub, varies on the others).
"""
from __future__ import annotations

import fnmatch
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import httpx

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)


_USER_AGENT = "fdroid-store/release-polling"
# Public canonical hosts for each provider. Used when ``base_url`` is
# not set on a source (the common public-instance case).
_DEFAULTS = {
    "github": "https://api.github.com",
    "gitlab": "https://gitlab.com",
    "gitea": "https://codeberg.org",
}
# GitHub release API max per_page = 100; we scan the first page only.
_PER_PAGE = 30

# ``owner/name`` validated leniently. GitLab supports nested groups
# (foo/bar/baz) — we tolerate one extra slash level for that case.
_REPO_RE = re.compile(r"^[A-Za-z0-9][\w.-]{0,38}(/[A-Za-z0-9._-]+){1,4}$")


class GithubReleaseError(RuntimeError):
    """Raised when the upstream forge returns a 4xx/5xx or is unreachable."""


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
    # Which provider this asset came from — needed by ``download_asset``
    # to forward the right auth header on the CDN redirect.
    provider: str = "github"
    # The PAT to authenticate the download with. Carried on the asset
    # so the caller doesn't have to re-pass it; falls back to the env
    # var when the source row has no per-source token configured.
    auth_token: str | None = None


@dataclass(frozen=True)
class RepoMetadata:
    """Subset of the repo-info payload used to prefill listing fields."""
    html_url: str
    description: str | None
    homepage: str | None
    license_spdx: str | None
    owner_login: str | None


# --------------------------------------------------------------------------
# Shared helpers
# --------------------------------------------------------------------------
def validate_repo(repo: str) -> str:
    """Normalise + reject anything that doesn't look like a repo path.

    Strips ``https://<host>/`` prefixes and ``.git`` suffixes so users
    can paste a clone URL. Raises ``ValueError`` on bad input.
    """
    s = repo.strip()
    # Match common clone-URL forms across all three providers.
    for prefix in (
        "https://github.com/", "http://github.com/", "git@github.com:",
        "https://gitlab.com/", "http://gitlab.com/", "git@gitlab.com:",
        "https://codeberg.org/", "http://codeberg.org/", "git@codeberg.org:",
    ):
        if s.lower().startswith(prefix):
            s = s[len(prefix):]
            break
    if s.endswith(".git"):
        s = s[:-4]
    s = s.strip("/")
    if not _REPO_RE.match(s):
        raise ValueError(f"Expected owner/name, got {repo!r}")
    return s


def validate_base_url(value: str | None) -> str | None:
    """Self-hosted instance URL must be https (or localhost for dev)."""
    if not value:
        return None
    stripped = value.strip().rstrip("/")
    if not stripped:
        return None
    lowered = stripped.lower()
    if not (
        lowered.startswith("https://")
        or lowered.startswith("http://localhost")
        or lowered.startswith("http://127.0.0.1")
    ):
        raise ValueError("base_url must be https://… (or localhost for dev)")
    return stripped


def _resolve_token(provider: str, explicit: str | None) -> str | None:
    """Use the per-source PAT when set, otherwise fall back to the
    server-level env token for the provider."""
    if explicit:
        return explicit
    if provider == "github":
        return settings.github_token
    if provider == "gitlab":
        return settings.gitlab_token
    if provider == "gitea":
        return settings.gitea_token
    return None


def _auth_headers_for(provider: str, token: str | None) -> dict[str, str]:
    """Per-provider Authorization header. Each forge uses a different
    scheme, so we can't normalize at the dispatcher level."""
    headers = {
        "User-Agent": _USER_AGENT,
        "Accept": "application/json",
    }
    if provider == "github":
        headers["Accept"] = "application/vnd.github+json"
        headers["X-GitHub-Api-Version"] = "2022-11-28"
        if token:
            headers["Authorization"] = f"Bearer {token}"
    elif provider == "gitlab":
        if token:
            headers["PRIVATE-TOKEN"] = token
    elif provider == "gitea":
        if token:
            headers["Authorization"] = f"token {token}"
    return headers


def _pick_apk(assets: list[dict], pattern: str) -> dict | None:
    """First asset whose ``name`` matches the glob and ends in .apk."""
    for a in assets:
        name = str(a.get("name", ""))
        if not name.lower().endswith(".apk"):
            continue
        if fnmatch.fnmatchcase(name.lower(), pattern.lower()):
            return a
    return None


# --------------------------------------------------------------------------
# Public dispatch entry points
# --------------------------------------------------------------------------
async def find_latest_asset(
    repo: str,
    *,
    asset_pattern: str | None,
    include_prereleases: bool,
    provider: str = "github",
    base_url: str | None = None,
    token: str | None = None,
) -> ReleaseAsset | None:
    pattern = (asset_pattern or "").strip() or "*.apk"
    effective_token = _resolve_token(provider, token)
    if provider == "github":
        return await _github_find(repo, pattern, include_prereleases, base_url, effective_token)
    if provider == "gitlab":
        return await _gitlab_find(repo, pattern, include_prereleases, base_url, effective_token)
    if provider == "gitea":
        return await _gitea_find(repo, pattern, include_prereleases, base_url, effective_token)
    raise GithubReleaseError(f"Unsupported provider: {provider!r}")


async def fetch_repo_metadata(
    repo: str,
    *,
    provider: str = "github",
    base_url: str | None = None,
    token: str | None = None,
) -> RepoMetadata | None:
    """Best-effort — returns ``None`` on 4xx/5xx so the caller falls
    back to manual entry instead of failing the create flow."""
    effective_token = _resolve_token(provider, token)
    if provider == "github":
        return await _github_meta(repo, base_url, effective_token)
    if provider == "gitlab":
        return await _gitlab_meta(repo, base_url, effective_token)
    if provider == "gitea":
        return await _gitea_meta(repo, base_url, effective_token)
    return None


async def download_asset(asset: ReleaseAsset) -> Path:
    """Stream the asset to a NamedTemporaryFile and return its path.

    The caller MUST unlink the returned path in a ``finally`` block.
    Each provider's CDN handles auth slightly differently; we keep the
    request small + follow redirects to whichever S3-equivalent URL the
    forge presents.
    """
    HARD_CAP = 256 * 1024 * 1024

    timeout = httpx.Timeout(connect=15.0, read=120.0, write=30.0, pool=15.0)
    base_headers: dict[str, str] = {
        "User-Agent": _USER_AGENT,
        "Accept": "application/octet-stream",
    }
    # GitHub asset endpoints redirect cross-host to S3 which does NOT
    # accept Authorization — httpx drops it on follow-redirect anyway
    # when the host changes. For GitLab and Gitea the URL is the actual
    # download endpoint so the header is needed throughout. The asset
    # carries its own ``auth_token`` (per-source PAT if configured, env
    # fallback otherwise) so we don't reach back into ``settings`` here.
    req_headers = dict(base_headers)
    tok = asset.auth_token
    if tok:
        if asset.provider == "github":
            req_headers["Authorization"] = f"Bearer {tok}"
        elif asset.provider == "gitlab":
            req_headers["PRIVATE-TOKEN"] = tok
        elif asset.provider == "gitea":
            req_headers["Authorization"] = f"token {tok}"

    async with httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=True,
        headers=base_headers,
    ) as client:
        try:
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


# --------------------------------------------------------------------------
# GitHub adapter
# --------------------------------------------------------------------------
async def _github_find(
    repo: str, pattern: str, include_prereleases: bool, base_url: str | None, token: str | None,
) -> ReleaseAsset | None:
    # GitHub's hosted API lives at api.github.com regardless of HTTPS
    # repo URLs. Self-hosted GitHub Enterprise uses ``/api/v3`` on the
    # configured base — handled by ``base_url`` overriding the host.
    api = (base_url.rstrip("/") + "/api/v3") if base_url else _DEFAULTS["github"]
    url = f"{api}/repos/{repo}/releases"
    timeout = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout, headers=_auth_headers_for("github", token)) as client:
        try:
            resp = await client.get(url, params={"per_page": str(_PER_PAGE)})
        except httpx.RequestError as exc:
            raise GithubReleaseError(f"GitHub unreachable: {exc}") from exc

        if resp.status_code == 404:
            raise GithubReleaseError(f"Repository {repo!r} not found")
        if resp.status_code == 403:
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
        match = _pick_apk(assets, pattern)
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
            provider="github",
            auth_token=token,
        )
    return None


async def _github_meta(repo: str, base_url: str | None, token: str | None) -> RepoMetadata | None:
    api = (base_url.rstrip("/") + "/api/v3") if base_url else _DEFAULTS["github"]
    timeout = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout, headers=_auth_headers_for("github", token)) as client:
        try:
            resp = await client.get(f"{api}/repos/{repo}")
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
    homepage = _nz(data.get("homepage"))
    if homepage and "://" not in homepage:
        homepage = f"https://{homepage}"
    return RepoMetadata(
        html_url=str(data.get("html_url") or f"https://github.com/{repo}"),
        description=_nz(data.get("description")),
        homepage=homepage,
        license_spdx=_nz(license_info.get("spdx_id")) if license_info else None,
        owner_login=_nz(owner.get("login")) if owner else None,
    )


# --------------------------------------------------------------------------
# GitLab adapter
# --------------------------------------------------------------------------
async def _gitlab_find(
    repo: str, pattern: str, include_prereleases: bool, base_url: str | None, token: str | None,
) -> ReleaseAsset | None:
    host = (base_url.rstrip("/") if base_url else _DEFAULTS["gitlab"])
    # GitLab's release endpoint expects the project path URL-encoded
    # (``%2F`` instead of ``/``). The ``safe=""`` forces every slash
    # through the percent-encoder.
    project = quote(repo, safe="")
    url = f"{host}/api/v4/projects/{project}/releases"
    timeout = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout, headers=_auth_headers_for("gitlab", token)) as client:
        try:
            resp = await client.get(url, params={"per_page": str(_PER_PAGE)})
        except httpx.RequestError as exc:
            raise GithubReleaseError(f"GitLab unreachable: {exc}") from exc
        if resp.status_code == 404:
            raise GithubReleaseError(f"Project {repo!r} not found on GitLab")
        if resp.status_code >= 400:
            raise GithubReleaseError(
                f"GitLab returned {resp.status_code}: {resp.text[:200]}"
            )
        releases = resp.json()

    if not isinstance(releases, list):
        raise GithubReleaseError("Unexpected GitLab response shape")

    for rel in releases:
        if not isinstance(rel, dict):
            continue
        # GitLab marks ``upcoming_release=true`` on releases scheduled
        # for the future. There's no formal pre-release flag, but the
        # community convention is to suffix tags with ``-rc``/``-beta``.
        if rel.get("upcoming_release"):
            continue
        if not include_prereleases:
            tag = str(rel.get("tag_name", "")).lower()
            if any(s in tag for s in ("-rc", "-beta", "-alpha", "-pre")):
                continue
        # GitLab nests assets under ``assets.links`` (manually attached
        # files). We don't look at ``assets.sources`` (auto-generated
        # source tarballs; never APKs).
        links = (
            rel.get("assets", {}).get("links")
            if isinstance(rel.get("assets"), dict)
            else None
        )
        if not isinstance(links, list):
            continue
        # Adapt GitLab's link shape ({name, url, link_type}) into the
        # asset dict shape ``_pick_apk`` expects.
        candidates = [
            {"name": l.get("name", ""), "url": l.get("url", "")}
            for l in links
            if isinstance(l, dict)
        ]
        match = _pick_apk(
            [{"name": c["name"], "browser_download_url": c["url"]} for c in candidates],
            pattern,
        )
        if match is None:
            continue
        try:
            published_at = datetime.fromisoformat(
                str(rel.get("released_at", "")).replace("Z", "+00:00")
            )
        except ValueError:
            continue
        tag = str(rel.get("tag_name", ""))
        is_pre = any(s in tag.lower() for s in ("-rc", "-beta", "-alpha", "-pre"))
        return ReleaseAsset(
            release_tag=tag,
            release_name=rel.get("name") or None,
            release_published_at=published_at,
            is_prerelease=is_pre,
            asset_id=0,  # GitLab links have no stable numeric id
            asset_name=str(match["name"]),
            asset_size=0,  # not exposed by the links endpoint
            asset_download_url=str(match["browser_download_url"]),
            provider="gitlab",
            auth_token=token,
        )
    return None


async def _gitlab_meta(repo: str, base_url: str | None, token: str | None) -> RepoMetadata | None:
    host = (base_url.rstrip("/") if base_url else _DEFAULTS["gitlab"])
    project = quote(repo, safe="")
    url = f"{host}/api/v4/projects/{project}?license=true"
    timeout = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout, headers=_auth_headers_for("gitlab", token)) as client:
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
    # GitLab's project endpoint nests author under ``namespace``.
    namespace = data.get("namespace") if isinstance(data.get("namespace"), dict) else None
    license_info = data.get("license") if isinstance(data.get("license"), dict) else None
    return RepoMetadata(
        html_url=str(data.get("web_url") or f"{host}/{repo}"),
        description=_nz(data.get("description")),
        # GitLab doesn't have a standardised "homepage" field on the
        # project. We omit rather than guess.
        homepage=None,
        # ``key`` matches the SPDX id loosely (``mit``, ``gpl-3.0``).
        # Upper-case to match GitHub's SPDX output.
        license_spdx=(
            license_info.get("key", "").upper() if license_info and license_info.get("key") else None
        ),
        owner_login=_nz(namespace.get("path")) if namespace else None,
    )


# --------------------------------------------------------------------------
# Gitea / Forgejo adapter (GitHub-compatible release shape)
# --------------------------------------------------------------------------
async def _gitea_find(
    repo: str, pattern: str, include_prereleases: bool, base_url: str | None, token: str | None,
) -> ReleaseAsset | None:
    host = (base_url.rstrip("/") if base_url else _DEFAULTS["gitea"])
    url = f"{host}/api/v1/repos/{repo}/releases"
    timeout = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout, headers=_auth_headers_for("gitea", token)) as client:
        try:
            resp = await client.get(url, params={"limit": str(_PER_PAGE)})
        except httpx.RequestError as exc:
            raise GithubReleaseError(f"Gitea unreachable: {exc}") from exc
        if resp.status_code == 404:
            raise GithubReleaseError(f"Repository {repo!r} not found on Gitea")
        if resp.status_code >= 400:
            raise GithubReleaseError(
                f"Gitea returned {resp.status_code}: {resp.text[:200]}"
            )
        releases = resp.json()

    if not isinstance(releases, list):
        raise GithubReleaseError("Unexpected Gitea response shape")

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
        match = _pick_apk(assets, pattern)
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
            asset_id=int(match.get("id") or 0),
            asset_name=str(match["name"]),
            asset_size=int(match.get("size") or 0),
            asset_download_url=str(match["browser_download_url"]),
            provider="gitea",
            auth_token=token,
        )
    return None


async def _gitea_meta(repo: str, base_url: str | None, token: str | None) -> RepoMetadata | None:
    host = (base_url.rstrip("/") if base_url else _DEFAULTS["gitea"])
    url = f"{host}/api/v1/repos/{repo}"
    timeout = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout, headers=_auth_headers_for("gitea", token)) as client:
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
    owner = data.get("owner") if isinstance(data.get("owner"), dict) else None
    homepage = _nz(data.get("website"))
    if homepage and "://" not in homepage:
        homepage = f"https://{homepage}"
    return RepoMetadata(
        html_url=str(data.get("html_url") or f"{host}/{repo}"),
        description=_nz(data.get("description")),
        homepage=homepage,
        # Gitea returns license as a free-form string in some versions;
        # we normalise to uppercase to align with GitHub's SPDX output.
        license_spdx=_nz(data.get("license") or data.get("default_branch")),
        owner_login=_nz(owner.get("login")) if owner else None,
    )


def _nz(value: object) -> str | None:
    """Empty/whitespace-only strings → None so callers can use truthiness."""
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None
