"""HTTP client for the APK source proxy protocol (``docs/proxy-protocol.md``).

Wraps the four backend-driven endpoints (``GET /healthz``, ``GET /sources``,
``POST /resolve``, and the ``GET <apk_url>`` download) behind a small
service surface so the rest of the codebase doesn't have to think about
httpx, headers, SSRF guards or the protocol error shape.

The proxy is treated as untrusted: every URL it hands back is run
through the existing SSRF guard before any further request leaves
the worker, and JSON responses are validated against the Pydantic
schemas in ``app.schemas.apk_proxy``.
"""
from __future__ import annotations

import ipaddress
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

import httpx
from pydantic import ValidationError

from app.core.logging import get_logger
from app.models.apk_proxy import ApkProxy
from app.schemas.apk_proxy import ProxySourcesCatalogue, ResolveResponse
from app.services.crypto import decrypt as fernet_decrypt

log = get_logger(__name__)


# Protocol version this backend can talk to. The handshake fails fast
# if the proxy advertises a higher version — we'd rather refuse than
# misinterpret an unknown field.
SUPPORTED_PROTOCOL_VERSION = 1

# Timeouts. The handshake is cheap; ``/resolve`` may chase upstreams
# (e.g. Patreon SDK calls behind the proxy) so we give it more headroom.
_HEALTH_TIMEOUT = httpx.Timeout(5.0, connect=3.0)
_HANDSHAKE_TIMEOUT = httpx.Timeout(15.0, connect=5.0)
_RESOLVE_TIMEOUT = httpx.Timeout(60.0, connect=10.0)


class ApkProxyError(RuntimeError):
    """Raised when the proxy returns a non-2xx response, an unparseable
    body, or fails the SSRF guard. The ``status_code`` attribute carries
    the HTTP status so the caller can decide whether to retry. ``code``
    is the proxy-supplied error code (``auth_failed``, ``rate_limited``,
    …) when available."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        code: str | None = None,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.retry_after = retry_after


# Cloud-metadata endpoints. AWS / GCP / Azure / OpenStack / Alibaba all
# converge on 169.254.169.254 (and the IPv6 fd00:ec2::254). Blocked
# explicitly even though we still allow other RFC1918 addresses (sidecar
# deployments typically resolve to 172.16-31.x.x on the compose network).
_BLOCKED_METADATA_HOSTNAMES = frozenset({
    "metadata.google.internal",
})
_BLOCKED_METADATA_IPS = frozenset({
    ipaddress.ip_address("169.254.169.254"),
    ipaddress.ip_address("fd00:ec2::254"),
})


def _is_blocked_metadata_host(hostname: str) -> bool:
    """Return True if ``hostname`` is on the cloud-metadata blocklist.

    Accepts hostnames, dotted IPv4, IPv6, AND IPv4 in its weird-but-legal
    forms (decimal ``2852039166``, hex ``0xa9fea9fe``, trailing dot).
    ``ipaddress.ip_address`` is the only stdlib parser that normalises
    all of them to the same numeric value; we feed it whatever shape the
    URL produced.
    """
    lower = hostname.lower().rstrip(".")
    if lower in _BLOCKED_METADATA_HOSTNAMES:
        return True
    try:
        ip = ipaddress.ip_address(int(lower, 0) if lower.startswith(("0x", "0o")) else lower)
    except (ValueError, TypeError):
        try:
            # Plain integer forms like ``2852039166``.
            ip = ipaddress.ip_address(int(lower))
        except (ValueError, TypeError):
            return False
    if ip in _BLOCKED_METADATA_IPS:
        return True
    # Anything in the IPv4 link-local 169.254/16 gets the same treatment —
    # even outside the literal IMDS IP, link-local has no business being a
    # proxy base. ``isinstance`` is used instead of ``ip.version == 4`` so
    # type checkers can narrow ``ip`` before the cross-version comparison
    # (``IPv4Address <= IPv6Address`` raises ``TypeError`` at runtime).
    if isinstance(ip, ipaddress.IPv4Address):
        return (
            ipaddress.IPv4Address("169.254.0.0")
            <= ip
            <= ipaddress.IPv4Address("169.254.255.255")
        )
    return False


def _assert_proxy_url_safe(base_url: str) -> str:
    """Validate the admin-supplied ``base_url`` before any HTTP I/O.

    RFC1918 is allowed (the typical deployment is a sidecar on the same
    compose network — see ``proxy-fdroid``). What we DO refuse:
      * non-http(s) schemes
      * URLs missing a hostname
      * ``user:pass@host`` userinfo (proxy auth runs through a separate
        ``Authorization`` header; userinfo in URLs has been a confused-
        deputy footgun in the past)
      * the cloud-metadata addresses themselves (see
        :data:`_BLOCKED_METADATA_HOSTS`) — no legitimate proxy is hosted
        on the IMDS endpoint, and forbidding it stops an admin (or anyone
        who escalates) from using the proxy registration form to leak
        cloud-instance credentials via ``last_health_error``.
    """
    parsed = urlsplit(base_url)
    if parsed.scheme not in {"http", "https"}:
        raise ApkProxyError(f"Proxy base_url must be http(s): {base_url!r}")
    if not parsed.hostname:
        raise ApkProxyError(f"Proxy base_url is missing a hostname: {base_url!r}")
    if parsed.username or parsed.password:
        raise ApkProxyError("Proxy base_url must not embed userinfo")
    if _is_blocked_metadata_host(parsed.hostname):
        raise ApkProxyError(
            "Proxy base_url is on the cloud-metadata blocklist",
        )
    return base_url.rstrip("/")


def _auth_headers(proxy: ApkProxy) -> dict[str, str]:
    """Build the ``Authorization`` header from the proxy's encrypted
    bearer secret. Missing / undecryptable token → header omitted (the
    proxy will 401, which we surface as ``auth_failed``)."""
    headers = {"User-Agent": "fdroid-store/1.3", "Accept": "application/json"}
    if proxy.auth_token_encrypted:
        try:
            token = fernet_decrypt(proxy.auth_token_encrypted)
        except Exception as exc:  # noqa: BLE001
            log.warning("could not decrypt proxy auth token", proxy_id=str(proxy.id), error=str(exc))
            return headers
        if token:
            headers["Authorization"] = f"Bearer {token}"
    return headers


async def health_check(proxy: ApkProxy) -> dict[str, Any]:
    """Hit ``GET /healthz``. No auth required by the spec.

    Returns the decoded JSON body on success; raises :class:`ApkProxyError`
    on transport / HTTP / shape failure. The caller maps the outcome
    onto ``ApkProxy.last_health_*`` columns.
    """
    base = _assert_proxy_url_safe(proxy.base_url)
    async with httpx.AsyncClient(timeout=_HEALTH_TIMEOUT, follow_redirects=False) as client:
        try:
            res = await client.get(f"{base}/healthz")
        except httpx.HTTPError as exc:
            raise ApkProxyError(f"healthz unreachable: {exc}") from exc
    if res.status_code != 200:
        raise ApkProxyError(
            f"healthz returned {res.status_code}",
            status_code=res.status_code,
        )
    try:
        data = res.json()
    except ValueError as exc:
        raise ApkProxyError(f"healthz body is not JSON: {exc}") from exc
    if not isinstance(data, dict) or not data.get("ok"):
        raise ApkProxyError(f"healthz returned a non-ok body: {data!r}")
    return data


async def fetch_sources(proxy: ApkProxy) -> ProxySourcesCatalogue:
    """Hit ``GET /sources``. The result is what the per-app wizard
    renders and what we cache on ``ApkProxy.cached_sources_json``.

    Refuses to return a catalogue whose ``version`` is higher than
    :data:`SUPPORTED_PROTOCOL_VERSION` — better to fail loudly than
    drop unknown fields silently.
    """
    base = _assert_proxy_url_safe(proxy.base_url)
    headers = _auth_headers(proxy)
    async with httpx.AsyncClient(timeout=_HANDSHAKE_TIMEOUT, follow_redirects=False) as client:
        try:
            res = await client.get(f"{base}/sources", headers=headers)
        except httpx.HTTPError as exc:
            raise ApkProxyError(f"sources unreachable: {exc}") from exc
    if res.status_code == 401:
        raise ApkProxyError("sources: auth failed (check shared secret)",
                            status_code=401, code="auth_failed")
    if res.status_code != 200:
        raise ApkProxyError(f"sources returned {res.status_code}",
                            status_code=res.status_code)
    try:
        body = res.json()
    except ValueError as exc:
        raise ApkProxyError(f"sources body is not JSON: {exc}") from exc
    try:
        catalogue = ProxySourcesCatalogue.model_validate(body)
    except ValidationError as exc:
        raise ApkProxyError(f"sources body fails schema: {exc}") from exc
    if catalogue.version > SUPPORTED_PROTOCOL_VERSION:
        raise ApkProxyError(
            f"proxy advertises protocol v{catalogue.version}, "
            f"this backend only supports v{SUPPORTED_PROTOCOL_VERSION}",
            code="version_too_new",
        )
    return catalogue


async def resolve(
    proxy: ApkProxy,
    *,
    provider: str,
    url: str,
    last_release_id: str | None,
    secrets: dict[str, str] | None,
) -> ResolveResponse | None:
    """Hit ``POST /resolve``.

    Returns the parsed :class:`ResolveResponse` on 200, ``None`` on 304
    (``last_release_id`` is still current). Maps protocol error codes
    onto :class:`ApkProxyError` so the caller can branch on
    ``auth_failed`` / ``rate_limited`` / ``no_apk`` without re-parsing
    the body.
    """
    base = _assert_proxy_url_safe(proxy.base_url)
    headers = _auth_headers(proxy)
    headers["Content-Type"] = "application/json"
    body: dict[str, Any] = {"provider": provider, "url": url}
    if last_release_id:
        body["last_release_id"] = last_release_id
    if secrets:
        body["secrets"] = secrets
    async with httpx.AsyncClient(timeout=_RESOLVE_TIMEOUT, follow_redirects=False) as client:
        try:
            res = await client.post(f"{base}/resolve", headers=headers, json=body)
        except httpx.HTTPError as exc:
            raise ApkProxyError(f"resolve unreachable: {exc}", code="upstream") from exc
    if res.status_code == 304:
        return None
    if res.status_code == 200:
        try:
            parsed = res.json()
        except ValueError as exc:
            raise ApkProxyError(f"resolve body is not JSON: {exc}", code="bad_response") from exc
        try:
            return ResolveResponse.model_validate(parsed)
        except ValidationError as exc:
            raise ApkProxyError(f"resolve body fails schema: {exc}", code="bad_response") from exc
    # Error path — extract the proxy-supplied code + retry hint.
    code: str | None = None
    retry_after: int | None = None
    message: str | None = None
    try:
        err = res.json()
    except ValueError:
        err = {}
    if isinstance(err, dict):
        code = err.get("error") if isinstance(err.get("error"), str) else None
        message = err.get("message") if isinstance(err.get("message"), str) else None
        retry_after = err.get("retry_after") if isinstance(err.get("retry_after"), int) else None
    raise ApkProxyError(
        message or f"resolve returned {res.status_code}",
        status_code=res.status_code,
        code=code,
        retry_after=retry_after,
    )


def catalogue_to_jsonable(catalogue: ProxySourcesCatalogue) -> dict[str, Any]:
    """Turn the validated catalogue back into a JSON-safe dict for
    storage on ``ApkProxy.cached_sources_json``. ``model_dump(mode='json')``
    handles the HttpUrl / datetime / regex conversions the JSON column
    can't take natively."""
    return catalogue.model_dump(mode="json", exclude_none=True)


def utcnow() -> datetime:
    """Tz-aware UTC ``now()``. Tiny helper so callers don't import
    datetime + timezone every time."""
    from datetime import UTC
    return datetime.now(UTC)
