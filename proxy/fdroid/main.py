"""Reference F-Droid source proxy.

Implements the v1 protocol (``docs/proxy-protocol.md``) over any
F-Droid-compatible repo (the official f-droid.org, IzzyOnDroid, the
Guardian Project, a self-hosted fdroid-store instance, …). One
provider only — ``fdroid`` — declared via ``auth_kind: none``.

URL format expected from the user (in ``POST /resolve`` body's ``url``):
either ``<repo>#<package>`` or ``<repo>?package=<package>``. The first
form is preferred because the fragment never reaches the index URL we
fetch, the second is a fallback for tools that strip fragments.

The proxy is intentionally stateless and tiny (~300 lines). The whole
thing fits in one FastAPI app + a single ``httpx`` call per resolve.
"""
from __future__ import annotations

import asyncio
import hmac
import io
import ipaddress
import json
import logging
import os
import re
import socket
import zipfile
import zlib
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qs, urljoin, urlsplit, urlunsplit

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.responses import JSONResponse, Response


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------


def _env_int(name: str, default: int) -> int:
    """Positive integer from the environment; a bad value stops the
    process at import so the misconfiguration is visible right away."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise SystemExit(f"{name} must be an integer, got {raw!r}") from None
    if value < 1:
        raise SystemExit(f"{name} must be >= 1, got {value}")
    return value


# Shared secret matching what the fdroid-store admin configured on the
# proxy row. Empty / unset = open mode (still parses the Authorization
# header so the API surface stays uniform per the spec).
SHARED_SECRET = os.environ.get("PROXY_SHARED_SECRET", "").strip()

# How aggressively to clamp index fetches. F-Droid indexes are ~20 MB max
# (official one is ~12 MB as of 2026), 32 MB gives us headroom.
_MAX_INDEX_BYTES = 32 * 1024 * 1024
# Cap on the DECOMPRESSED index-v1.json. The cap above only bounds the
# compressed jar, so a ~32 MB zip bomb could otherwise inflate to GBs in
# memory. A parsed index costs ~4-5x its JSON size in RAM.
_MAX_INDEX_JSON_BYTES = _env_int("PROXY_MAX_INDEX_JSON_MB", 256) * 1024 * 1024
# httpx timeouts are per network operation: an upstream trickling a byte
# every 59 s (or chaining slow redirects) would hold a fetch forever. This
# is the wall-clock budget for one whole index download, redirects included.
_FETCH_DEADLINE_S = _env_int("PROXY_FETCH_DEADLINE_SECONDS", 120)
# Index fetch + parse is the memory-heavy part (a few hundred MB for a big
# repo); bound how many run at once. Extra /resolve calls wait their turn.
_FETCH_SLOTS = asyncio.Semaphore(_env_int("PROXY_MAX_CONCURRENT_FETCHES", 2))
_INDEX_TIMEOUT = httpx.Timeout(60.0, connect=10.0)
_RESOLVE_TIMEOUT = httpx.Timeout(60.0, connect=10.0)

# Anchor for the matchers — every Android package id must start with a
# letter and use [a-zA-Z0-9_] segments separated by dots.
_PACKAGE_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$")


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("proxy.fdroid")

if not SHARED_SECRET:
    log.warning(
        "PROXY_SHARED_SECRET is empty: running in OPEN mode, anyone who can "
        "reach this port can call /sources and /resolve. Set a shared secret "
        "(PROXY_FDROID_SECRET in the fdroid-store compose .env) and enter the "
        "same value when registering the proxy in /admin/proxies."
    )

app = FastAPI(
    title="fdroid-source-proxy (reference F-Droid)",
    version="1.0",
    docs_url=None,
    redoc_url=None,
)


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------


def require_auth(authorization: str | None = Header(default=None)) -> None:
    """Validate the bearer secret from the calling backend.

    Empty ``SHARED_SECRET`` env = open mode (still parses the header so
    the API surface stays uniform — useful for compose-network sidecar
    deployments where mTLS / network policy is the actual access control).
    """
    if not SHARED_SECRET:
        return
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    token = authorization[len("Bearer "):].strip()
    if not hmac.compare_digest(token.encode(), SHARED_SECRET.encode()):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="bad token")


# --------------------------------------------------------------------------
# Endpoints — /healthz + /sources
# --------------------------------------------------------------------------


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    """Liveness probe. No auth per the spec — admins curl this from
    anywhere to confirm the proxy is alive."""
    return {"ok": True, "version": 1}


@app.get("/sources", dependencies=[Depends(require_auth)])
async def sources() -> dict[str, Any]:
    """Catalogue. One provider only.

    ``url_hint`` shows the operator the canonical f-droid.org URL but
    the proxy accepts ANY F-Droid-compatible repo — IzzyOnDroid, the
    Guardian Project, another fdroid-store instance, …. ``url_pattern``
    is loose so the frontend doesn't red-line valid third-party repo
    URLs.
    """
    return {
        "version": 1,
        "name": "Reference F-Droid Proxy",
        "providers": [
            {
                "id": "fdroid",
                "name": "F-Droid-compatible repo",
                "description": (
                    "Any repo serving index-v1.jar (f-droid.org, IzzyOnDroid, "
                    "Guardian Project, another fdroid-store instance, …). "
                    "Encode the package after the URL as ``#<package>`` or "
                    "``?package=<package>``."
                ),
                "url_hint": "https://f-droid.org/repo#org.fdroid.fdroid",
                "url_pattern": r"^https?://[^\s]+#?\??[a-zA-Z][a-zA-Z0-9_.]*$",
                "auth_kind": "none",
                "secret_fields": [],
            },
        ],
    }


# --------------------------------------------------------------------------
# Endpoint — /resolve
# --------------------------------------------------------------------------


def _err(code: str, message: str, *, http: int = 400, retry_after: int | None = None) -> JSONResponse:
    body: dict[str, Any] = {"error": code, "message": message}
    if retry_after is not None:
        body["retry_after"] = retry_after
    return JSONResponse(status_code=http, content=body)


# Only public unicast addresses may be fetched: anything ``is_global`` says
# isn't globally reachable (RFC 1918, loopback, link-local incl. the cloud
# metadata 169.254.169.254, CGNAT, 0.0.0.0/8, ULA incl. fd00:ec2::254,
# documentation / benchmarking ranges, Teredo, …) plus multicast / reserved
# / unspecified. Same intent as the backend's
# ``app.core.ssrf.is_blocked_public_ip``, copied here because the proxy is
# a standalone single-file service.
_NAT64_WKP = ipaddress.ip_network("64:ff9b::/96")
_IpAddr = ipaddress.IPv4Address | ipaddress.IPv6Address


class BlockedAddressError(httpx.ConnectError):
    """A host resolved (wholly or partly) to a blocked address. An
    ``httpx.ConnectError`` so the fetch's ``except httpx.HTTPError`` turns
    a refusal at connect time (DNS rebinding) into a clean error."""


def _addr_blocked(ip: _IpAddr) -> bool:
    if isinstance(ip, ipaddress.IPv6Address):
        # IPv4-mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::/96) and 6to4
        # (2002::/16) addresses deliver to the embedded IPv4 host, so that
        # host is what gets judged: ``::ffff:127.0.0.1`` / ``64:ff9b::7f00:1``
        # are loopback, while a DNS64-synthesised address of a public repo
        # (IPv6-only networks) stays reachable.
        if ip.ipv4_mapped is not None:
            return _addr_blocked(ip.ipv4_mapped)
        if ip in _NAT64_WKP:
            return _addr_blocked(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
        if ip.sixtofour is not None:
            return _addr_blocked(ip.sixtofour)
        if ip.is_site_local:  # deprecated fec0::/10, not covered by is_private
            return True
    if ip.is_loopback or ip.is_private or ip.is_link_local:
        return True
    if ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        return True
    return not ip.is_global


def _ip_blocked(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True
    return _addr_blocked(ip)


async def _resolve_checked(host: str, port: int | None = None) -> list[str]:
    """Resolve ``host`` once and return its addresses, refusing
    (``BlockedAddressError``) if ANY answer is blocked: filtering out only
    the bad records would let a rebinding host slip one past a later lookup.

    ``loop.getaddrinfo`` runs in the default thread pool so a slow DNS
    resolver can't freeze the whole uvicorn worker.
    """
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError) as exc:
        raise BlockedAddressError(f"cannot resolve {host!r}") from exc
    addrs: list[str] = []
    for info in infos:
        addr = info[4][0]
        if not isinstance(addr, str) or _ip_blocked(addr):
            raise BlockedAddressError(f"{host!r} resolves to a blocked address")
        addrs.append(addr)
    if not addrs:
        raise BlockedAddressError(f"{host!r} did not resolve to any address")
    return addrs


async def _hostname_resolves_to_blocked(host: str) -> bool:
    """Early, user-facing check (clean 400 / 502 messages). The binding
    check happens again at connect time in :class:`_PinnedTransport`."""
    try:
        await _resolve_checked(host)
    except BlockedAddressError:
        return True
    return False


class _PinnedTransport(httpx.AsyncBaseTransport):
    """Resolve + validate the host once per request and connect to that
    exact IP. Without this, httpx resolves the hostname AGAIN when it opens
    the socket, so a DNS server answering the check with a public IP and
    the connect with 169.254.169.254 (rebinding) would defeat the guard.
    The hostname stays in the ``Host`` header and in TLS SNI / certificate
    verification; only the connection target becomes the checked IP. The
    caller's request is left untouched, so relative redirects still join
    against the hostname."""

    def __init__(self, **transport_kwargs: Any) -> None:
        self._inner = httpx.AsyncHTTPTransport(**transport_kwargs)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        host = request.url.host
        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            literal = None
        if literal is not None:
            if _addr_blocked(literal):
                raise BlockedAddressError(f"blocked address {host}", request=request)
            return await self._inner.handle_async_request(request)
        port = request.url.port or (443 if request.url.scheme == "https" else 80)
        ip = (await _resolve_checked(host, port))[0]
        pinned = httpx.Request(
            request.method,
            request.url.copy_with(host=ip),
            headers=request.headers,  # carries Host: <hostname>
            stream=request.stream,
            extensions={**request.extensions, "sni_hostname": host},
        )
        return await self._inner.handle_async_request(pinned)

    async def aclose(self) -> None:
        await self._inner.aclose()


async def _parse_url(url: str) -> tuple[str, str] | str:
    """Pull the F-Droid repo URL and the package name out of the
    user-supplied string.

    Returns ``(repo_url, package)`` on success, or an explanatory
    ``str`` on validation failure (caller maps the string to a 400).
    The string-error channel keeps every user-facing message in a
    typed return — there's no ``str(exc)`` path that could leak
    library-raised exception detail.

    Accepts two formats:
      * ``<repo>#<package>`` — preferred, the fragment never leaks.
      * ``<repo>?package=<package>`` — fallback for tools that strip
        fragments (common with copy-paste in mobile browsers).
    """
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"}:
        return "url must be http(s)"
    if not parsed.hostname:
        return "url is missing a hostname"
    if parsed.username or parsed.password:
        return "userinfo not allowed in url"
    host = parsed.hostname
    if await _hostname_resolves_to_blocked(host):
        return "url resolves to a blocked network range"
    # Fragment form first — it's the cleanest.
    if parsed.fragment:
        pkg = parsed.fragment.strip()
        if not _PACKAGE_RE.match(pkg):
            return "invalid package id in fragment"
        repo = urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))
        return repo, pkg
    # Query-string fallback.
    if parsed.query:
        params = parse_qs(parsed.query)
        candidates = params.get("package") or params.get("packageName")
        if candidates:
            pkg = candidates[0].strip()
            if not _PACKAGE_RE.match(pkg):
                return "invalid package id in query"
            repo = urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))
            return repo, pkg
    return "url must encode a package via `#<package>` or `?package=<package>`"


async def _safe_get_following_redirects(
    client: httpx.AsyncClient, url: str, *, max_hops: int = 5
) -> httpx.Response:
    """Issue a streaming GET, walking up to ``max_hops`` redirects with
    the SSRF guard re-applied to every ``Location`` target. Returns the
    final response with its body NOT yet consumed — caller iterates
    ``aiter_bytes()`` and is responsible for closing via ``aclose()``.

    Combining the walk with the body fetch means the no-redirect happy
    path costs exactly one round trip (vs. HEAD-then-GET, which doubles
    it and breaks on mirrors that return 405 to HEAD).
    """
    request = client.build_request("GET", url)
    for _ in range(max_hops + 1):
        response = await client.send(request, stream=True)
        if response.status_code not in (301, 302, 303, 307, 308):
            return response
        # Drain + close so the connection is reusable for the next hop.
        await response.aclose()
        loc = response.headers.get("location")
        if not loc:
            raise FetchError(
                "redirect with no Location header",
                http=502, code="bad_response",
            )
        nxt_url = urljoin(str(request.url), loc)
        nxt = urlsplit(nxt_url)
        if nxt.scheme not in {"http", "https"}:
            raise FetchError(
                "redirect to non-http(s) scheme",
                http=502, code="bad_response",
            )
        if not nxt.hostname or await _hostname_resolves_to_blocked(nxt.hostname):
            raise FetchError(
                "redirect resolves to a blocked network range",
                http=502, code="bad_response",
            )
        request = client.build_request("GET", nxt_url)
    raise FetchError("too many redirects", http=502, code="bad_response")


async def _fetch_index_v1(repo_url: str) -> dict[str, Any]:
    """Fetch ``<repo>/index-v1.jar``, open it as a ZIP, return the parsed
    ``index-v1.json`` payload.

    The JAR signature is verified by the F-Droid client on the device,
    and the APK signer cert is re-pinned by fdroid-store at ingest time —
    so we don't re-verify here.

    Failures are logged with full detail (``exc_info=True``); only a
    generic message reaches the HTTP response (see
    :data:`_FETCH_ERR_MESSAGES`) so we don't help an attacker fingerprint
    the index format or library versions.

    At most ``PROXY_MAX_CONCURRENT_FETCHES`` fetch + parse run at once; the
    download is bounded by ``PROXY_FETCH_DEADLINE_SECONDS`` overall, the
    parse by the decompressed-size cap.
    """
    url = f"{repo_url.rstrip('/')}/index-v1.jar"
    async with _FETCH_SLOTS:
        try:
            async with asyncio.timeout(_FETCH_DEADLINE_S):
                buf = await _download_index_jar(url)
        except TimeoutError as exc:
            log.warning(
                "index fetch exceeded the %ss deadline: upstream=%s",
                _FETCH_DEADLINE_S,
                url,
            )
            raise FetchError(
                "index fetch exceeded the deadline",
                http=502,
                code="upstream",
            ) from exc
        # json parsing of a large index is CPU-bound: keep it off the event
        # loop so /healthz and the other requests stay responsive.
        return await asyncio.to_thread(_parse_index_jar, buf, url)


async def _download_index_jar(url: str) -> bytearray:
    """Download the jar (≤ ``_MAX_INDEX_BYTES``) through the DNS-pinned
    transport. Keep-alive is off so a redirect to another hostname that
    resolves to the same IP never reuses a TLS session negotiated for the
    first one."""
    try:
        async with httpx.AsyncClient(
            timeout=_INDEX_TIMEOUT,
            follow_redirects=False,
            transport=_PinnedTransport(
                limits=httpx.Limits(max_keepalive_connections=0),
            ),
        ) as client:
            # IzzyOnDroid + others 301 to a CDN. The helper walks redirects
            # manually so the SSRF guard re-runs against every Location
            # header — ``follow_redirects=True`` would happily chase a 302
            # to an RFC1918 IP or the cloud-metadata service.
            res = await _safe_get_following_redirects(client, url)
            try:
                if res.status_code != 200:
                    log.warning(
                        "index fetch failed: upstream=%s status=%s",
                        res.request.url,
                        res.status_code,
                    )
                    raise FetchError(
                        f"index fetch returned {res.status_code}",
                        http=502 if res.status_code >= 500 else 404,
                        code="not_found" if res.status_code == 404 else "upstream",
                    )
                buf = bytearray()
                async for chunk in res.aiter_bytes(1024 * 1024):
                    buf.extend(chunk)
                    if len(buf) > _MAX_INDEX_BYTES:
                        raise FetchError(
                            f"index file exceeds {_MAX_INDEX_BYTES} bytes",
                            http=502,
                            code="too_large",
                        )
            finally:
                await res.aclose()
    except (httpx.HTTPError, httpx.InvalidURL) as exc:
        log.warning(
            "index transport error: upstream=%s exc_type=%s",
            url,
            type(exc).__name__,
            exc_info=True,
        )
        raise FetchError(
            "upstream index could not be reached",
            http=502,
            code="upstream",
        ) from exc
    return buf


def _parse_index_jar(buf: bytearray, url: str) -> dict[str, Any]:
    """Extract + parse ``index-v1.json`` from the jar, refusing to inflate
    more than ``_MAX_INDEX_JSON_BYTES`` (zip-bomb guard). The declared size
    is checked first; the read itself is bounded too, and zipfile stops at
    the declared size (a lying header then fails the CRC check)."""
    try:
        with zipfile.ZipFile(io.BytesIO(buf)) as zf:
            info = zf.getinfo("index-v1.json")
            if info.file_size > _MAX_INDEX_JSON_BYTES:
                raise FetchError(
                    f"index-v1.json declares {info.file_size} bytes",
                    http=502,
                    code="too_large",
                )
            with zf.open(info) as fp:
                data = fp.read(_MAX_INDEX_JSON_BYTES + 1)
        if len(data) > _MAX_INDEX_JSON_BYTES:
            raise FetchError(
                f"index-v1.json exceeds {_MAX_INDEX_JSON_BYTES} bytes",
                http=502,
                code="too_large",
            )
        return json.loads(data)
    except FetchError:
        log.warning("index too large after decompression: upstream=%s", url)
        raise
    except (
        zipfile.BadZipFile,
        KeyError,
        ValueError,  # incl. json.JSONDecodeError, UnicodeDecodeError
        # incl. RecursionError (deeply nested JSON), NotImplementedError
        # (unsupported compression method), encrypted entries
        RuntimeError,
        EOFError,
        OSError,
        zlib.error,
    ) as exc:
        log.warning(
            "could not parse index-v1.jar: upstream=%s exc_type=%s",
            url,
            type(exc).__name__,
            exc_info=True,
        )
        raise FetchError(
            "upstream index could not be parsed",
            http=502,
            code="bad_response",
        ) from exc


def _pick_latest_apk(
    index: dict[str, Any],
    package: str,
) -> dict[str, Any] | None:
    """Find the highest-versionCode APK entry for ``package``.

    F-Droid's index-v1.json shape:
      * ``apps[]`` — one entry per app, has ``packageName`` + ``name`` +
        ``suggestedVersionCode`` (string).
      * ``packages`` — dict ``packageName -> [apk_entry...]``.

    Each apk_entry has: ``apkName``, ``versionCode``, ``versionName``,
    ``size``, ``hash`` (sha256), ``added`` (epoch ms).

    Returns the picked entry or None when the package is absent from
    the index.
    """
    packages = index.get("packages") if isinstance(index, dict) else None
    if not isinstance(packages, dict):
        return None
    entries = packages.get(package)
    if not isinstance(entries, list) or not entries:
        return None
    # Sort by versionCode desc — F-Droid's index already orders newest
    # first, but we don't rely on that.
    def _vc(e: Any) -> int:
        try:
            return int(e.get("versionCode", 0))
        except (TypeError, ValueError):
            return 0
    return max(entries, key=_vc)


def _app_entry_for(
    index: dict[str, Any],
    package: str,
) -> dict[str, Any]:
    """Return the ``apps[]`` entry for ``package``, or an empty dict
    if the index doesn't have one (some repos serve packages without
    a top-level app record)."""
    apps = index.get("apps") if isinstance(index, dict) else None
    if not isinstance(apps, list):
        return {}
    for app in apps:
        if isinstance(app, dict) and app.get("packageName") == package:
            return app
    return {}


class FetchError(Exception):
    """Wraps upstream / parse failures with the HTTP status + protocol
    error code we'll send back to the caller.

    The ``message`` is for server-side logs only. The user-facing
    message is looked up from :data:`_FETCH_ERR_MESSAGES` by ``code`` so
    no exception-derived string ever flows into an HTTP response.
    """

    def __init__(self, message: str, *, http: int, code: str) -> None:
        super().__init__(message)
        self.http = http
        self.code = code


# User-facing error messages keyed by FetchError.code. Static strings —
# the user-visible message never carries exception-derived text.
_FETCH_ERR_MESSAGES: dict[str, str] = {
    "not_found": "upstream index not found",
    "upstream": "upstream index could not be reached",
    "too_large": "upstream index exceeds the configured size limit",
    "bad_response": "upstream index could not be parsed",
}


@app.post("/resolve", dependencies=[Depends(require_auth)])
async def resolve(body: dict[str, Any]) -> Any:
    """``POST /resolve`` — protocol entry point. See ``docs/proxy-protocol.md``."""
    # Validate body shape minimally. We don't pull pydantic in to keep
    # the dependency surface tiny — the proxy is a single file.
    if not isinstance(body, dict):
        return _err("bad_request", "body must be a JSON object")
    provider = body.get("provider")
    url = body.get("url")
    last = body.get("last_release_id")
    if provider != "fdroid":
        return _err("bad_request", f"unknown provider: {provider!r}")
    if not isinstance(url, str) or not url:
        return _err("bad_request", "missing url")

    parsed = await _parse_url(url)
    if isinstance(parsed, str):
        return _err("bad_request", parsed)
    repo_url, package = parsed

    try:
        index = await _fetch_index_v1(repo_url)
    except FetchError as exc:
        # Look up the user-visible message by code — the dict value is
        # constant data, so ``str(exc)`` never reaches the response.
        return _err(
            exc.code,
            _FETCH_ERR_MESSAGES.get(exc.code, "upstream error"),
            http=exc.http,
        )

    apk = _pick_latest_apk(index, package)
    if apk is None:
        return _err(
            "no_apk",
            f"package {package!r} not found in index at {repo_url}",
            http=404,
        )

    try:
        version_code = int(apk["versionCode"])
    except (TypeError, ValueError, KeyError):
        return _err("bad_response", "index entry has no usable versionCode", http=502)
    version_name = str(apk.get("versionName", "")) or "0"
    apk_name = apk.get("apkName")
    if not isinstance(apk_name, str) or not apk_name:
        return _err("bad_response", "index entry has no apkName", http=502)

    release_id = f"{package}@{version_code}"
    if isinstance(last, str) and last == release_id:
        # The caller has already imported this release — short-circuit.
        # A bare Response: a 304 must not carry a body (JSONResponse would
        # serialise ``null`` and uvicorn rejects the response).
        return Response(status_code=304)

    # Build the final response. The APK is served by the repo directly
    # — we don't proxy the bytes (the repo CDN does that better than
    # us). The fdroid-store SSRF guard still fires on this URL before
    # download.
    repo_clean = repo_url.rstrip("/")
    apk_url = f"{repo_clean}/{apk_name}"

    # Convert ``added`` (epoch ms) to ISO-8601 for the caller.
    added_ms = apk.get("added")
    published_at: str | None = None
    if isinstance(added_ms, (int, float)) and added_ms > 0:
        published_at = (
            datetime.fromtimestamp(int(added_ms) / 1000, tz=UTC)
            .isoformat()
            .replace("+00:00", "Z")
        )

    # Take the SHA-256 hash from the index for the optional verifier.
    # The hex-only regex catches garbage / accidentally-padded strings —
    # without it, a malformed hash would propagate to the backend and stamp
    # every future scan of this source as ERROR (sha mismatch).
    hash_kind = apk.get("hashType")
    hash_hex = apk.get("hash")
    sha256_hint: str | None = None
    if (
        hash_kind == "sha256"
        and isinstance(hash_hex, str)
        and re.fullmatch(r"[0-9a-fA-F]{64}", hash_hex)
    ):
        sha256_hint = hash_hex.lower()

    size_bytes: int | None = None
    if "size" in apk:
        try:
            n = int(apk["size"])
            if n > 0:
                size_bytes = n
        except (TypeError, ValueError):
            pass

    out: dict[str, Any] = {
        "release_id": release_id,
        "package_name": package,
        "version_name": version_name,
        "version_code": version_code,
        "apk_url": apk_url,
    }
    if published_at:
        out["published_at"] = published_at
    if sha256_hint:
        out["apk_sha256_hint"] = sha256_hint
    if size_bytes:
        out["apk_size_bytes"] = size_bytes
    return out
