"""DNS-rebinding-safe outbound HTTP.

Every outbound fetch on behalf of a user (forge release polling, APK source
proxy calls, asset downloads) targets a hostname the user / a registered
proxy influenced. The string-level guards in ``github_releases`` /
``apk_proxy_client`` resolve the host and check the answers — but ``httpx``
then resolves the SAME hostname AGAIN when it opens the socket. An attacker
who controls authoritative DNS can answer the validation lookup with a
public IP and the connect lookup with ``169.254.169.254`` (DNS rebinding),
defeating a check that isn't bound to the connection.

:class:`PinnedSSRFTransport` closes that window: it resolves the host once,
refuses if ANY answer is in a blocked range, then connects to the validated
IP it picked — the exact address that passed the check. The original
hostname is preserved for the ``Host`` header and the TLS ``sni_hostname``
extension, so virtual hosting and certificate verification still work.

Two block predicates are provided because the trust models differ:

  * :func:`is_blocked_public_ip` — for forge fetches. Blocks every
    non-public-unicast address (RFC1918, loopback, link-local, CGNAT, …).
  * :func:`is_blocked_proxy_ip` — for APK-proxy sidecars, which legitimately
    live on the RFC1918 compose network. Allows private space but still
    blocks loopback, link-local, and the cloud-metadata IPs.
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Callable

import httpx

_BaseIp = ipaddress.IPv4Address | ipaddress.IPv6Address

# Cloud-metadata endpoints (AWS/GCP/Azure/OpenStack/Alibaba converge on the
# IPv4 link-local IMDS IP; the IPv6 form is the AWS one).
_METADATA_IPS = frozenset({
    ipaddress.ip_address("169.254.169.254"),
    ipaddress.ip_address("fd00:ec2::254"),
})


class BlockedAddressError(Exception):
    """A hostname resolved (wholly or partly) to a blocked address."""


def _normalise(ip: _BaseIp) -> _BaseIp:
    """Collapse IPv4-mapped IPv6 (``::ffff:a.b.c.d``) to its v4 form so the
    range tests below can't be sidestepped by the v6 spelling."""
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    return ip


def is_blocked_public_ip(ip: _BaseIp) -> bool:
    """Strict predicate for forge fetches: anything that isn't public
    unicast is refused. ``not is_global`` already covers private, loopback,
    link-local, CGNAT (100.64/10), benchmarking and documentation ranges."""
    ip = _normalise(ip)
    if ip.is_loopback or ip.is_private or ip.is_link_local:
        return True
    if ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        return True
    return not ip.is_global


def is_blocked_proxy_ip(ip: _BaseIp) -> bool:
    """Lenient predicate for APK-proxy sidecars: RFC1918 / ULA private space
    is allowed (the typical sidecar is on the compose network), but loopback,
    link-local and the metadata IPs are still refused."""
    ip = _normalise(ip)
    if ip in _METADATA_IPS:
        return True
    if ip.is_loopback or ip.is_link_local or ip.is_unspecified:
        return True
    return bool(ip.is_multicast or ip.is_reserved)


async def _resolve_safe_ip(host: str, port: int, is_blocked: Callable[[_BaseIp], bool]) -> str:
    """Resolve ``host`` and return a single validated IP to connect to.

    Refuses (``BlockedAddressError``) if ANY answer is blocked — partial
    filtering would let a rebinding host slip a bad record past us on a
    later lookup. Uses the async resolver so the event loop isn't pinned.
    """
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise BlockedAddressError(f"cannot resolve {host!r}: {exc}") from exc
    chosen: str | None = None
    for info in infos:
        sockaddr = info[4]
        raw = sockaddr[0] if isinstance(sockaddr, tuple) else None
        if not isinstance(raw, str):
            continue
        try:
            parsed = ipaddress.ip_address(raw)
        except ValueError:
            continue
        if is_blocked(parsed):
            raise BlockedAddressError(f"{host!r} resolves to blocked address {raw}")
        if chosen is None:
            chosen = raw
    if chosen is None:
        raise BlockedAddressError(f"{host!r} did not resolve to any usable address")
    return chosen


class PinnedSSRFTransport(httpx.AsyncBaseTransport):
    """httpx transport that resolves + validates the host once and connects
    to the pinned IP, eliminating the validate/connect DNS-rebind window."""

    def __init__(self, is_blocked: Callable[[_BaseIp], bool], **transport_kwargs: object) -> None:
        self._is_blocked = is_blocked
        self._inner = httpx.AsyncHTTPTransport(**transport_kwargs)  # type: ignore[arg-type]

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        host = request.url.host
        # IP literal: validate directly, no rebind risk, no rewrite needed.
        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            literal = None
        if literal is not None:
            if self._is_blocked(literal):
                raise BlockedAddressError(f"blocked address {host}")
            return await self._inner.handle_async_request(request)

        port = request.url.port or (443 if request.url.scheme == "https" else 80)
        safe_ip = await _resolve_safe_ip(host, port, self._is_blocked)
        # Preserve the hostname for the Host header (already set on the
        # request by the client) and TLS SNI / cert verification; only the
        # connection target becomes the pinned IP.
        extensions = dict(request.extensions or {})
        extensions["sni_hostname"] = host
        request.extensions = extensions
        request.url = request.url.copy_with(host=safe_ip)
        return await self._inner.handle_async_request(request)

    async def aclose(self) -> None:
        await self._inner.aclose()


def make_ssrf_client(
    is_blocked: Callable[[_BaseIp], bool],
    **client_kwargs: object,
) -> httpx.AsyncClient:
    """Build an :class:`httpx.AsyncClient` whose connections are pinned to a
    validated IP. Drop-in for ``httpx.AsyncClient(...)`` — pass the same
    ``timeout`` / ``headers`` / ``follow_redirects`` kwargs. Redirects, when
    enabled, re-enter the transport and are re-validated."""
    return httpx.AsyncClient(transport=PinnedSSRFTransport(is_blocked), **client_kwargs)  # type: ignore[arg-type]
