"""Parser for upstream ``fdroiddata`` metadata.yml files.

We only consume the YAML files (not the deprecated ``.txt`` metadata
format) and return a flat dict the New App form can prefill itself with.

Security: deserialisation goes through ``yaml.safe_load`` (no arbitrary
Python type instantiation, no ``!Loader`` tags). On top of that we reject
YAML *aliases* first, because ``safe_load`` still *expands* them — a
250-byte "billion laughs" anchor/alias chain explodes into tens of
millions of nodes (verified: ~250 B → 54 M nodes → 8 s CPU), a trivial
DoS the 32 KiB size cap does nothing to stop. The rejection is a cheap
token SCAN (``yaml.scan``), which does not expand anything — expansion
only happens at construct time, which we reach only after the scan
passes. Anchors without an alias are harmless, and ``&``/``*`` inside
ordinary string values aren't tokenised as anchors/aliases, so normal
text parses fine. Unknown keys are silently dropped.
"""
from __future__ import annotations

from typing import Any

import yaml
from fastapi import HTTPException, status

_MAX_BYTES = 32 * 1024


def _reject_yaml_aliases(raw: str) -> None:
    """Raise ``HTTPException(400)`` if ``raw`` uses a YAML alias (``*ref``).

    Scanning the token stream neither resolves aliases nor builds nodes, so
    feeding it the billion-laughs bomb is O(input) — the expansion that makes
    that input dangerous would only occur later in ``safe_load``, which we
    never reach when an alias is present.
    """
    try:
        for token in yaml.scan(raw, Loader=yaml.SafeLoader):
            if isinstance(token, yaml.tokens.AliasToken):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="metadata.yml must not use YAML aliases",
                )
    except yaml.YAMLError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid YAML: {exc}",
        ) from exc


def parse_metadata_yaml(raw: str) -> dict[str, Any]:
    """Parse a pasted metadata.yml string.

    Returns a dict shaped to match the New App form fields. Raises
    ``HTTPException(400)`` on malformed input or oversized payload.
    """
    if not raw or not raw.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty metadata",
        )
    if len(raw) > _MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="metadata.yml too large (32 KiB max)",
        )
    _reject_yaml_aliases(raw)
    try:
        data = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid YAML: {exc}",
        ) from exc
    if not isinstance(data, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="metadata.yml must be a YAML mapping",
        )

    def _s(key: str, max_len: int = 4000) -> str | None:
        v = data.get(key)
        if v is None:
            return None
        if not isinstance(v, str):
            return None
        v = v.strip()
        return v[:max_len] if v else None

    def _l(key: str) -> list[str]:
        v = data.get(key)
        if isinstance(v, list):
            return [str(item).strip() for item in v if str(item).strip()]
        if isinstance(v, str):
            # F-Droid sometimes uses comma-separated strings; accept both.
            return [s.strip() for s in v.split(",") if s.strip()]
        return []

    # Description is sometimes a multi-line block scalar; preserve newlines
    # but trim trailing whitespace.
    description = data.get("Description")
    if isinstance(description, str):
        description = description.rstrip()[:20_000]
    else:
        description = None

    return {
        "name": _s("Name") or _s("AutoName"),
        "summary": _s("Summary", max_len=255),
        "description": description,
        "license": _s("License", max_len=128),
        "author_name": _s("AuthorName"),
        "author_email": _s("AuthorEmail"),
        "website": _s("WebSite") or _s("Website"),
        "source_code": _s("SourceCode"),
        "issue_tracker": _s("IssueTracker"),
        "translation": _s("Translation"),
        "donate": _s("Donate"),
        "liberapay": _s("Liberapay") or _s("LiberapayID"),
        "open_collective": _s("OpenCollective"),
        "bitcoin": _s("Bitcoin"),
        # Categories + AntiFeatures are returned as lists; the UI matches
        # them against the configured taxonomy / known anti-feature set.
        "categories": _l("Categories"),
        "anti_features": _l("AntiFeatures"),
    }
