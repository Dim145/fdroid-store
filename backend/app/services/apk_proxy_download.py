"""Reusable proxy-fetched APK helpers.

Originally these lived inside :mod:`app.workers.proxy_tasks`; lifting them
to a service module lets the inspect / with-proxy-source endpoints in
:mod:`app.api.v1` reuse the same SSRF guard, streamed download with the
admin-configured size cap, and SHA-256 verification.

Keeping all proxy-supplied URL handling behind a single chokepoint matters:
any bypass of these checks (a custom downloader path, a manual
``httpx.get`` somewhere) becomes a potential SSRF vector. Don't roll a
second copy.
"""
from __future__ import annotations

import hashlib
import ipaddress
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from app.core.logging import get_logger
from app.core.ssrf import is_blocked_proxy_ip, make_ssrf_client
from app.services.apk_proxy_client import ApkProxyError

log = get_logger(__name__)

# Proxy-supplied ``apk_headers`` are untrusted. Only forward the small set a
# real download legitimately needs, capped in count + value length. ``host``
# / ``user-agent`` / ``content-length`` are deliberately excluded — the
# client sets those itself and a proxy must not override them.
_ALLOWED_PROXY_HEADERS = frozenset({
    "authorization",   # signed-URL / bearer auth for the upstream asset
    "accept",
    "range",           # partial / resumable fetch
    "if-none-match",
    "if-modified-since",
})
_MAX_PROXY_HEADERS = 8
_MAX_PROXY_HEADER_VALUE_LEN = 4096


def assert_apk_url_safe(url: str) -> None:
    """SSRF guard on a proxy-supplied ``apk_url``.

    Refuses RFC 1918 / loopback / link-local / metadata-IP destinations
    regardless of which proxy supplied them — the trust boundary with
    any third-party proxy is the same as with any third-party forge.

    Raises :class:`ApkProxyError` on rejection so callers can map it to
    the ``bad_response`` source status the same way they do for any
    other malformed proxy answer.
    """
    # Local import avoids a circular: github_releases pulls config which
    # pulls services init.
    from app.services.github_releases import _is_private_ip, _resolves_to_blocked

    parsed = urlsplit(url)
    scheme = (parsed.scheme or "").lower()
    if scheme not in {"http", "https"}:
        raise ApkProxyError(f"apk_url must be http(s): {url!r}", code="bad_response")
    host = (parsed.hostname or "").strip()
    if not host:
        raise ApkProxyError(
            f"apk_url is missing a hostname: {url!r}", code="bad_response"
        )
    try:
        as_ip = ipaddress.ip_address(host)
        if _is_private_ip(str(as_ip)):
            raise ApkProxyError(
                f"apk_url resolves to a blocked range: {host}",
                code="bad_response",
            )
    except ValueError:
        if _resolves_to_blocked(host):
            raise ApkProxyError(
                f"apk_url resolves to a blocked range: {host}",
                code="bad_response",
            )


async def download_apk(
    *,
    apk_url: str,
    headers: dict[str, str] | None,
    max_bytes: int,
) -> Path:
    """Stream the APK from ``apk_url`` to a tempfile.

    ``max_bytes`` is the admin-configured upload cap — the download is
    aborted (and the partial tempfile unlinked) the moment we go over.
    A proxy that lies about ``apk_size_bytes`` can't exhaust disk.

    Returns the path; caller is responsible for ``unlink(missing_ok=True)``
    once they're done parsing / attaching the APK.
    """
    assert_apk_url_safe(apk_url)
    req_headers: dict[str, str] = {"User-Agent": "fdroid-store/1.3"}
    if headers:
        # The proxy is untrusted, so its ``apk_headers`` are tightly
        # constrained: only an allowlist of names a legitimate download
        # needs (signed-URL auth, range/conditional requests, content
        # negotiation), capped in count and value length. This stops a
        # hostile proxy from smuggling ``Cookie``/``Proxy-Authorization``,
        # overriding our ``User-Agent``/``Host``, or amplifying the request
        # with an unbounded header set. ``User-Agent`` is never overridable.
        for k, v in list(headers.items())[:_MAX_PROXY_HEADERS]:
            if not (isinstance(k, str) and isinstance(v, str)):
                continue
            if k.lower() not in _ALLOWED_PROXY_HEADERS:
                continue
            if len(v) > _MAX_PROXY_HEADER_VALUE_LEN:
                continue
            req_headers[k] = v
    timeout = httpx.Timeout(180.0, connect=15.0)
    path: Path | None = None
    total = 0
    try:
        with tempfile.NamedTemporaryFile(suffix=".apk", delete=False) as tmp:
            path = Path(tmp.name)
            async with make_ssrf_client(
                is_blocked_proxy_ip,
                timeout=timeout,
                follow_redirects=False,
            ) as client:
                async with client.stream("GET", apk_url, headers=req_headers) as res:
                    if res.status_code != 200:
                        raise ApkProxyError(
                            f"apk_url returned {res.status_code}",
                            status_code=res.status_code,
                            code="upstream",
                        )
                    async for chunk in res.aiter_bytes(1024 * 1024):
                        if not chunk:
                            continue
                        total += len(chunk)
                        if total > max_bytes:
                            raise ApkProxyError(
                                f"APK exceeds the configured {max_bytes} byte limit",
                                code="upstream",
                            )
                        tmp.write(chunk)
    except Exception:
        if path is not None:
            path.unlink(missing_ok=True)
        raise
    return path


def verify_sha256_hint(path: Path, hint: str) -> None:
    """Recompute SHA-256 over the downloaded file and raise on mismatch.

    The protocol's ``apk_sha256_hint`` is optional — callers should only
    invoke this when ``resolved.apk_sha256_hint`` is non-null. When it
    IS supplied, any mismatch is a strong signal that the proxy↔upstream
    link was compromised or the artefact was retransformed in transit,
    so the audit-log entry the worker writes on the failure is
    deliberately loud.
    """
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    got = h.hexdigest()
    if got.lower() != hint.lower():
        raise ApkProxyError(
            f"apk_sha256_hint mismatch: declared {hint}, downloaded {got}",
            code="bad_response",
        )
