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
import ipaddress
import re
import socket
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

import httpx

from app.core.config import settings
from app.core.logging import get_logger
from app.core.ssrf import is_blocked_public_ip, make_ssrf_client

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
# Individual segments are rejected if they are ``.`` or ``..`` to prevent
# path traversal in the constructed API URL when a self-hosted base_url
# sits behind a permissive reverse proxy that normalises ``..`` instead
# of rejecting it.
_REPO_RE = re.compile(r"^[A-Za-z0-9][\w.-]{0,38}(/[A-Za-z0-9._-]+){1,4}$")
_REPO_BAD_SEGMENT = frozenset({".", ".."})

# Hostnames we refuse to fetch from. Resolving the user-supplied
# ``base_url`` to one of these IPs would let an authenticated user pivot
# through the backend into the host's metadata service / private
# network. Loopback is rejected too in production; the localhost dev
# escape hatch is honoured only when the request really resolves to
# 127.0.0.0/8 AND the environment is ``development``.
_BLOCKED_HOSTNAMES = frozenset({
    "metadata.google.internal",
    "metadata",
    "metadata.aws",
    "metadata.azure.com",
})


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

    Path traversal: ``..`` or ``.`` segments are rejected so a malicious
    repo string can't escape its parent path on a self-hosted instance
    whose reverse proxy normalises rather than rejects ``..``.
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
    for seg in s.split("/"):
        if seg in _REPO_BAD_SEGMENT:
            raise ValueError(f"Invalid path segment {seg!r} in repo")
    return s


def _is_private_ip(ip_str: str) -> bool:
    """True when the address belongs to a range we never want the
    server to fetch from on behalf of a user (loopback, link-local,
    multicast, RFC1918, ULA, the IPv4-mapped variants of all of those).
    Both v4 and v6 are handled."""
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    # Normalise IPv4-mapped IPv6 (``::ffff:10.0.0.1``) back to v4 so the
    # range checks below can't be sidestepped by spelling a blocked v4
    # address as a v6 literal.
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if ip.is_loopback or ip.is_private or ip.is_link_local:
        return True
    if ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        return True
    # ``is_private`` does NOT cover the 100.64.0.0/10 carrier-grade-NAT /
    # shared-address space (RFC 6598), which routes to internal infra in
    # many cloud / k8s / Tailscale setups, nor a handful of special-use
    # ranges. ``not is_global`` is the catch-all: anything not part of the
    # public unicast internet has no business being a fetch target.
    if not ip.is_global:
        return True
    # AWS / GCP / Azure metadata endpoints all live at 169.254.169.254
    # which is covered by ``is_link_local``. Keep this explicit anyway
    # so the intent is unmistakable when reading the code.
    if isinstance(ip, ipaddress.IPv4Address) and str(ip) == "169.254.169.254":
        return True
    return False


def _resolves_to_blocked(host: str) -> bool:
    """Resolve ``host`` and return True if ANY answer maps to a blocked
    range. We refuse the request rather than only filtering the bad
    answers because DNS rebinding could otherwise let an attacker shift
    the resolution mid-flight."""
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror:
        # Unresolvable host — let httpx surface a clean error rather
        # than us second-guessing here.
        return False
    for info in infos:
        sockaddr = info[4]
        ip = sockaddr[0] if isinstance(sockaddr, tuple) else None
        if isinstance(ip, str) and _is_private_ip(ip):
            return True
    return False


def validate_base_url(value: str | None) -> str | None:
    """Self-hosted instance URL must be https on a publicly-resolvable
    hostname. Performs DNS resolution + blocks RFC1918 / loopback /
    link-local / metadata addresses so an authenticated user can't
    pivot through the backend into the host's private network (SSRF).
    """
    if not value:
        return None
    stripped = value.strip().rstrip("/")
    if not stripped:
        return None
    try:
        parsed = urlsplit(stripped)
    except ValueError as exc:
        raise ValueError(f"base_url is not a valid URL: {exc}") from exc
    scheme = (parsed.scheme or "").lower()
    if scheme not in {"http", "https"}:
        raise ValueError("base_url must be http(s)://")
    # ``hostname`` returns the bare host (lower-cased, strips userinfo /
    # port). Using ``netloc`` would let ``http://127.0.0.1@evil.com/``
    # pass startswith checks.
    host = (parsed.hostname or "").strip()
    if not host:
        raise ValueError("base_url is missing a hostname")
    # Block well-known cloud metadata hostnames before we even resolve
    # them — DNS for these is sometimes static and pointing them at the
    # blocked IPs only catches the obvious case.
    if host.lower() in _BLOCKED_HOSTNAMES:
        raise ValueError(f"base_url host {host!r} is blocked")
    # Allow plain HTTP only for localhost dev loops, NEVER for any
    # other host. The hostname-level check below picks up any address
    # that resolves to loopback even when spelled as a public name.
    if scheme == "http" and host.lower() not in {"localhost"}:
        try:
            ipaddress.ip_address(host)
            is_ip = True
        except ValueError:
            is_ip = False
        if not (is_ip and ipaddress.ip_address(host).is_loopback):
            raise ValueError("base_url must be https:// (http:// only for localhost dev)")
    # IP literal: skip DNS, check directly. Hostname: resolve + check
    # every answer. We refuse on the FIRST blocked address rather than
    # filtering — DNS rebinding could otherwise win the race.
    try:
        as_ip = ipaddress.ip_address(host)
        if _is_private_ip(str(as_ip)):
            raise ValueError(f"base_url IP {as_ip!s} is in a blocked range")
    except ValueError:
        # Not an IP literal — try DNS.
        if _resolves_to_blocked(host):
            raise ValueError(f"base_url host {host!r} resolves to a blocked range")
    return stripped


def assert_fetch_url_safe(url: str) -> str:
    """Validate a user-supplied URL is safe for the backend to fetch and
    return a canonicalised copy rebuilt from the validated components.

    Checks: http(s) scheme, present hostname, no metadata hostname, no
    private/loopback/link-local/metadata IPs (both IP-literal and any
    DNS answer). Raises :class:`ValueError` on any failure so callers
    can map to their own error type (HTTPException, GithubReleaseError…).

    Returning a freshly-built URL — rather than the input string — makes
    the sanitised value flow-distinct from the tainted input for static
    analysers, and discards any userinfo / fragment that could otherwise
    confuse downstream URL handling.
    """
    try:
        parsed = urlsplit(url)
    except ValueError as exc:
        raise ValueError(f"Invalid URL: {exc}") from exc
    scheme = (parsed.scheme or "").lower()
    if scheme not in {"http", "https"}:
        raise ValueError("URL must be http(s)://")
    host = (parsed.hostname or "").strip()
    if not host:
        raise ValueError("URL is missing a hostname")
    if host.lower() in _BLOCKED_HOSTNAMES:
        raise ValueError(f"Host {host!r} is blocked")
    try:
        as_ip = ipaddress.ip_address(host)
    except ValueError:
        as_ip = None
    if as_ip is not None:
        if _is_private_ip(str(as_ip)):
            raise ValueError(f"IP {as_ip!s} is in a blocked range")
    elif _resolves_to_blocked(host):
        raise ValueError(f"Host {host!r} resolves to a blocked range")
    port = f":{parsed.port}" if parsed.port is not None else ""
    netloc = f"{host}{port}"
    return urlunsplit((scheme, netloc, parsed.path, parsed.query, ""))


def _assert_download_url_public(url: str) -> None:
    """Defence-in-depth check applied to ``browser_download_url`` /
    asset link URLs returned by the upstream API. The upstream payload
    is partly attacker-controlled (a malicious GitHub Enterprise mirror
    could embed an internal-IP link); we refuse the download rather
    than blindly streaming it."""
    try:
        assert_fetch_url_safe(url)
    except ValueError as exc:
        raise GithubReleaseError(f"Asset URL rejected: {exc}") from exc


def _guard_forge_url(url: str) -> str:
    """Re-validate a forge API URL against the SSRF guard AT FETCH TIME.

    ``base_url`` is only checked by the Pydantic validator when the source
    row is saved. Between then and this request a hostname can rebind (DNS)
    or its record can change to point at an internal address — so we
    re-resolve and re-check here. Returns a canonical URL with userinfo
    stripped. Raises :class:`GithubReleaseError` on a blocked target.
    """
    try:
        return assert_fetch_url_safe(url)
    except ValueError as exc:
        raise GithubReleaseError(f"Forge URL rejected: {exc}") from exc


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
    Each provider's CDN handles auth slightly differently. We manually
    walk redirects so we can re-validate every hop's host against the
    SSRF blocklist (httpx's ``follow_redirects=True`` would happily
    follow a 302 to ``http://169.254.169.254/`` returned by a
    compromised upstream).
    """
    HARD_CAP = 256 * 1024 * 1024
    MAX_REDIRECTS = 5

    # Validate the initial URL before we make any request — saves
    # one round-trip on the common case.
    _assert_download_url_public(asset.asset_download_url)

    timeout = httpx.Timeout(connect=15.0, read=120.0, write=30.0, pool=15.0)
    base_headers: dict[str, str] = {
        "User-Agent": _USER_AGENT,
        "Accept": "application/octet-stream",
    }
    # GitHub asset endpoints redirect cross-host to S3 which does NOT
    # accept Authorization — and we want to drop it anyway on a
    # cross-origin hop. We track ``origin_host`` so the credential
    # only travels to the host the caller meant to authenticate with.
    initial_host = urlsplit(asset.asset_download_url).hostname or ""
    req_headers = dict(base_headers)
    tok = asset.auth_token
    if tok:
        if asset.provider == "github":
            req_headers["Authorization"] = f"Bearer {tok}"
        elif asset.provider == "gitlab":
            req_headers["PRIVATE-TOKEN"] = tok
        elif asset.provider == "gitea":
            req_headers["Authorization"] = f"token {tok}"

    async with make_ssrf_client(
        is_blocked_public_ip,
        timeout=timeout,
        follow_redirects=False,
        headers=base_headers,
    ) as client:
        url = asset.asset_download_url
        current_host = initial_host
        try:
            for hop in range(MAX_REDIRECTS + 1):
                # Strip auth on every cross-host hop. urlsplit returns
                # the bare hostname; we lower-case for the compare.
                hop_host = urlsplit(url).hostname or ""
                hop_headers = dict(req_headers)
                if hop_host.lower() != current_host.lower():
                    hop_headers.pop("Authorization", None)
                    hop_headers.pop("PRIVATE-TOKEN", None)
                async with client.stream("GET", url, headers=hop_headers) as resp:
                    if 300 <= resp.status_code < 400 and resp.headers.get("location"):
                        next_url = str(resp.headers["location"])
                        # Re-validate the redirect target before we
                        # follow it. This is the actual SSRF guard —
                        # a compromised upstream returning a 302 to
                        # an internal IP gets blocked here.
                        _assert_download_url_public(next_url)
                        current_host = hop_host
                        url = next_url
                        continue
                    if resp.status_code >= 400:
                        raise GithubReleaseError(
                            f"Asset download failed: {resp.status_code}"
                        )
                    # 2xx — stream straight into the tmpfile. We MUST
                    # do this inside the ``async with`` block because
                    # ``resp`` closes its body the moment the context
                    # manager exits.
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
            raise GithubReleaseError(
                f"Asset download exceeded {MAX_REDIRECTS} redirects"
            )
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
    url = _guard_forge_url(f"{api}/repos/{repo}/releases")
    timeout = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)
    async with make_ssrf_client(
        is_blocked_public_ip,
        timeout=timeout, headers=_auth_headers_for("github", token), follow_redirects=False
    ) as client:
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
    try:
        url = assert_fetch_url_safe(f"{api}/repos/{repo}")
    except ValueError:
        return None
    timeout = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)
    async with make_ssrf_client(
        is_blocked_public_ip,
        timeout=timeout, headers=_auth_headers_for("github", token), follow_redirects=False
    ) as client:
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
    url = _guard_forge_url(f"{host}/api/v4/projects/{project}/releases")
    timeout = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)
    async with make_ssrf_client(
        is_blocked_public_ip,
        timeout=timeout, headers=_auth_headers_for("gitlab", token), follow_redirects=False
    ) as client:
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
    try:
        url = assert_fetch_url_safe(f"{host}/api/v4/projects/{project}?license=true")
    except ValueError:
        return None
    timeout = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)
    async with make_ssrf_client(
        is_blocked_public_ip,
        timeout=timeout, headers=_auth_headers_for("gitlab", token), follow_redirects=False
    ) as client:
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
    url = _guard_forge_url(f"{host}/api/v1/repos/{repo}/releases")
    timeout = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)
    async with make_ssrf_client(
        is_blocked_public_ip,
        timeout=timeout, headers=_auth_headers_for("gitea", token), follow_redirects=False
    ) as client:
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
    try:
        url = assert_fetch_url_safe(f"{host}/api/v1/repos/{repo}")
    except ValueError:
        return None
    timeout = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)
    async with make_ssrf_client(
        is_blocked_public_ip,
        timeout=timeout, headers=_auth_headers_for("gitea", token), follow_redirects=False
    ) as client:
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
