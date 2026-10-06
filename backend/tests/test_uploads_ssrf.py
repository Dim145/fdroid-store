"""SSRF predicates: transition-mechanism IPv6 spellings and the URL rebuild."""
from __future__ import annotations

import ipaddress

import httpx
import pytest

from app.core.ssrf import BlockedAddressError, is_blocked_proxy_ip, is_blocked_public_ip
from app.services.github_releases import _is_private_ip, assert_fetch_url_safe


def _ip(value: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    return ipaddress.ip_address(value)


@pytest.mark.parametrize(
    "address",
    [
        "fec0::1",              # deprecated site-local
        "2002:7f00:1::1",       # 6to4 → 127.0.0.1
        "2002:a9fe:a9fe::",     # 6to4 → 169.254.169.254
        "2002:a00:1::",         # 6to4 → 10.0.0.1
        "64:ff9b::7f00:1",      # NAT64 → 127.0.0.1
        "64:ff9b::a9fe:a9fe",   # NAT64 → 169.254.169.254
        "::ffff:10.0.0.1",      # IPv4-mapped
        "100.64.0.1",           # CGNAT
    ],
)
def test_public_predicate_blocks_internal_targets_in_any_spelling(address: str) -> None:
    assert is_blocked_public_ip(_ip(address))
    assert _is_private_ip(address)  # string-level pre-check agrees


@pytest.mark.parametrize("address", ["140.82.112.3", "2606:4700:4700::1111"])
def test_public_predicate_allows_public_unicast(address: str) -> None:
    assert not is_blocked_public_ip(_ip(address))
    assert not _is_private_ip(address)


@pytest.mark.parametrize(
    "address",
    ["2002:7f00:1::", "2002:a9fe:a9fe::", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "fd00:ec2::254"],
)
def test_proxy_predicate_blocks_loopback_and_metadata_through_tunnels(address: str) -> None:
    assert is_blocked_proxy_ip(_ip(address))


@pytest.mark.parametrize("address", ["10.0.0.5", "172.18.0.3", "fd12::5", "2002:a00:1::"])
def test_proxy_predicate_still_allows_private_space(address: str) -> None:
    # Sidecars live on the compose network; a 6to4 spelling of private v4
    # gets the same verdict as the v4 address itself.
    assert not is_blocked_proxy_ip(_ip(address))


def test_blocked_address_is_an_httpx_request_error() -> None:
    # Callers map httpx.RequestError / HTTPError to their own 4xx; a refusal
    # at connect time (DNS rebinding) must take the same path, not a 500.
    assert issubclass(BlockedAddressError, httpx.RequestError)


def test_ipv6_literal_url_is_rebuilt_with_brackets() -> None:
    url = assert_fetch_url_safe("https://[2606:4700:4700::1111]:8443/a/b?c=1#frag")
    assert url == "https://[2606:4700:4700::1111]:8443/a/b?c=1"
    assert httpx.URL(url).host == "2606:4700:4700::1111"


def test_ipv6_literal_internal_url_is_rejected() -> None:
    with pytest.raises(ValueError, match="blocked"):
        assert_fetch_url_safe("http://[fec0::1]/x")
