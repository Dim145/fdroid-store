"""Shape the per-app funding fields the way F-Droid clients expect them.

F-Droid builds the donation links itself from bare identifiers (2.0:
``ui/details/AppDetailsItem.kt``)::

    liberapay       → https://liberapay.com/<id>/donate
    openCollective  → https://opencollective.com/<slug>/donate
    bitcoin         → bitcoin:<address>

while ``donate`` is a *list* of plain URLs in index-v2. Our form used to
ask for full URLs, and fdroiddata imports carry bare IDs, so the database
holds both shapes: normalise at index-build time instead of trusting either.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

_LIBERAPAY_URL = re.compile(r"^(?:https?://)?(?:www\.)?liberapay\.com/([^/?#\s]+)", re.IGNORECASE)
_OPENCOLLECTIVE_URL = re.compile(
    r"^(?:https?://)?(?:www\.)?opencollective\.com/([^/?#\s]+)", re.IGNORECASE
)
_LOOKS_LIKE_URL = re.compile(r"^[a-z][a-z0-9+.-]*:", re.IGNORECASE)


@dataclass
class Funding:
    donate: list[str] = field(default_factory=list)
    liberapay: str | None = None
    open_collective: str | None = None
    bitcoin: str | None = None


def _clean(value: str | None) -> str:
    return (value or "").strip()


def _platform_id(value: str, pattern: re.Pattern[str], funding: Funding) -> str | None:
    """Extract the account ID from a platform URL, or accept a bare ID.

    A URL pointing somewhere else can't become an ID — keep it as a generic
    donation link instead of emitting a link the client would mangle.
    """
    match = pattern.match(value)
    if match:
        return match.group(1)
    if _LOOKS_LIKE_URL.match(value) or "/" in value:
        if value not in funding.donate:
            funding.donate.append(value)
        return None
    return value


def funding_for(app: object) -> Funding:
    """Normalised funding fields for ``app`` (anything with the App columns)."""
    funding = Funding()
    donate = _clean(getattr(app, "donate", None))
    if donate:
        funding.donate.append(donate)

    liberapay = _clean(getattr(app, "liberapay", None))
    if liberapay:
        funding.liberapay = _platform_id(liberapay, _LIBERAPAY_URL, funding)

    open_collective = _clean(getattr(app, "open_collective", None))
    if open_collective:
        funding.open_collective = _platform_id(open_collective, _OPENCOLLECTIVE_URL, funding)

    bitcoin = _clean(getattr(app, "bitcoin", None))
    if bitcoin:
        if bitcoin.lower().startswith("bitcoin:"):
            bitcoin = bitcoin[len("bitcoin:"):]
        # BIP-21 parameters (?amount=…) aren't part of the address.
        bitcoin = bitcoin.split("?", 1)[0].strip()
        funding.bitcoin = bitcoin or None
    return funding
