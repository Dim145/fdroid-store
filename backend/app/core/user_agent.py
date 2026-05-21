"""Tiny User-Agent classifier.

Used by the download history endpoint to surface "web vs client" splits
in the UI. We deliberately avoid a heavy UA-parser dependency: we only
need a coarse family bucket, not the make-and-model, and the F-Droid
Android client emits a UA so simple (``F-Droid 1.23.2``) that a regex
beats every off-the-shelf library on it.

Buckets:
    fdroid   — the official F-Droid Android client (and its forks that
               preserve the ``F-Droid`` UA prefix: Foxy Droid, Neo
               Store, Droid-ify when configured so).
    web      — a desktop or mobile browser hitting the SPA. Detected
               by the Mozilla/Gecko/Webkit/etc. signatures common to
               all real browsers.
    cli      — curl, wget, HTTPie, aria2, etc. — typically devops or
               developer tooling (CI deploy hooks, manual ``curl`` of
               an APK URL).
    other    — anything we can't classify, including obvious bots and
               anything that strips its UA. Kept distinct from
               ``unknown`` so the UI can colour-code "stripped UA"
               differently if we ever need to.
    unknown  — no UA header at all.
"""
from __future__ import annotations

import re

# A leading ``F-Droid`` token (with optional version) is the canonical
# signature. Anchored to start to avoid matching a stray substring in a
# longer string an attacker could craft.
_FDROID_RE = re.compile(r"^F-Droid[/ ]", re.IGNORECASE)

# CLI tools. Anchored to start for the same reason.
_CLI_RE = re.compile(
    r"^(?:curl|Wget|HTTPie|aria2|axel|Go-http-client|python-requests|PostmanRuntime|libcurl)\b",
    re.IGNORECASE,
)

# Browser signatures — at least one of these tokens appears in every
# real desktop / mobile browser UA. Substring match (not anchored) is
# fine here since the strings themselves are unmistakable.
_WEB_RE = re.compile(
    r"\b(?:Mozilla|Gecko|AppleWebKit|Chrome|Safari|Edge|Firefox|Opera|Trident|Chromium)\b",
    re.IGNORECASE,
)


def classify_user_agent(ua: str | None) -> str:
    """Return one of ``fdroid`` / ``web`` / ``cli`` / ``other`` / ``unknown``.

    Order of checks matters: ``F-Droid`` first because forks sometimes
    append a Mozilla-style suffix; ``cli`` next because curl/wget UAs
    never look like browser ones; ``web`` last because the browser
    tokens are the most permissive.
    """
    if not ua:
        return "unknown"
    if _FDROID_RE.search(ua):
        return "fdroid"
    if _CLI_RE.search(ua):
        return "cli"
    if _WEB_RE.search(ua):
        return "web"
    return "other"
