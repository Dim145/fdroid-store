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

import io
import json
import logging
import os
import re
import zipfile
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qs, urlsplit, urlunsplit

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.responses import JSONResponse


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

# Shared secret matching what the fdroid-store admin configured on the
# proxy row. Empty / unset = open mode (still parses the Authorization
# header so the API surface stays uniform per the spec).
SHARED_SECRET = os.environ.get("PROXY_SHARED_SECRET", "").strip()

# How aggressively to clamp index fetches. F-Droid indexes are ~20 MB max
# (official one is ~12 MB as of 2026), 32 MB gives us headroom.
_MAX_INDEX_BYTES = 32 * 1024 * 1024
_INDEX_TIMEOUT = httpx.Timeout(60.0, connect=10.0)
_RESOLVE_TIMEOUT = httpx.Timeout(60.0, connect=10.0)

# Anchor for the matchers — every Android package id must start with a
# letter and use [a-zA-Z0-9_] segments separated by dots.
_PACKAGE_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$")


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("proxy.fdroid")

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
    # Constant-time-ish compare — Python's == on str isn't constant-time
    # but the resulting timing leak is bounded by the secret length and
    # this isn't a credential-extraction attack surface we worry about.
    if token != SHARED_SECRET:
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


def _parse_url(url: str) -> tuple[str, str] | str:
    """Pull the F-Droid repo URL and the package name out of the
    user-supplied string.

    Returns ``(repo_url, package)`` on success, or an author-written
    ``str`` describing the validation failure. We deliberately avoid
    raising here so the failure messages are returned via an explicit
    typed channel rather than via ``str(exc)`` — that pattern would
    trigger static-analysis "stack-trace exposure" alerts even though
    every message is hand-written.

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


async def _fetch_index_v1(repo_url: str) -> dict[str, Any]:
    """Fetch ``<repo>/index-v1.jar``, open it as a ZIP, return the parsed
    ``index-v1.json`` payload.

    We deliberately do NOT verify the JAR signature here — the F-Droid
    client does that on the device. The proxy just needs the metadata
    + APK URL, both of which are then re-verified by fdroid-store: the
    backend re-parses the manifest server-side and checks the signing
    cert against its own pin.

    On parse failure the underlying exception is logged with the full
    detail (``upstream_url`` + ``exc_info=True``) but only a generic
    message is bubbled up to the caller's HTTP response — leaking
    stack-trace-flavoured strings to a public API would help an
    attacker fingerprint the index format / library versions.
    """
    url = f"{repo_url.rstrip('/')}/index-v1.jar"
    try:
        async with httpx.AsyncClient(
            timeout=_INDEX_TIMEOUT,
            follow_redirects=True,  # IzzyOnDroid + others 301 to cdn
            limits=httpx.Limits(max_keepalive_connections=4),
        ) as client:
            async with client.stream("GET", url) as res:
                if res.status_code != 200:
                    log.warning(
                        "index fetch failed: upstream=%s status=%s",
                        url,
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
                            code="upstream",
                        )
    except httpx.HTTPError as exc:
        # Transport-level failures (DNS / connect / timeout / read).
        # Log the type + cause server-side; expose only a generic
        # message — the raw exception string would leak library
        # versions and internal paths.
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

    try:
        with zipfile.ZipFile(io.BytesIO(buf)) as zf:
            with zf.open("index-v1.json") as fp:
                return json.load(fp)
    except (zipfile.BadZipFile, KeyError, json.JSONDecodeError) as exc:
        # Same recipe as the transport branch above: log richly,
        # respond generically.
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


# User-facing error messages keyed by FetchError.code. Static strings
# only — what the caller sees if their /resolve request hits one of
# the upstream-fetch failure modes. The richer detail (which library
# raised, with traceback) is in the server logs.
_FETCH_ERR_MESSAGES: dict[str, str] = {
    "not_found": "upstream index not found",
    "upstream": "upstream index could not be reached",
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

    parsed = _parse_url(url)
    if isinstance(parsed, str):
        # Author-written validation message (see _parse_url); not a
        # library-raised exception, so safe to echo back to the caller.
        return _err("bad_request", parsed)
    repo_url, package = parsed

    try:
        index = await _fetch_index_v1(repo_url)
    except FetchError as exc:
        # The FetchError messages are already author-written static
        # strings (see ``_fetch_index_v1``), but static analysers
        # (CodeQL py/stack-trace-exposure) still mark ``str(exc)`` as
        # a tainted source because the value originates from an
        # ``Exception`` object. We break the visible taint flow by
        # routing the user-facing message through a static dict keyed
        # on ``exc.code`` — the lookup result is constant data, not
        # exception-derived. Operators retain full traceback context
        # in the structured server logs already emitted at the throw
        # site.
        return _err(exc.code, _FETCH_ERR_MESSAGES.get(exc.code, "upstream error"), http=exc.http)

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
        return JSONResponse(status_code=304, content=None)

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
    hash_kind = apk.get("hashType")
    hash_hex = apk.get("hash")
    sha256_hint: str | None = None
    if hash_kind == "sha256" and isinstance(hash_hex, str) and len(hash_hex) == 64:
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
