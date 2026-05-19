"""Parser for upstream ``fdroiddata`` metadata.yml files.

We only consume the YAML files (not the deprecated ``.txt`` metadata
format) and return a flat dict the New App form can prefill itself with.

Security: we feed the bytes through ``yaml.safe_load`` — no arbitrary
Python type instantiation, no ``!Loader`` tags. Unknown keys are silently
dropped. The file size cap (32 KiB) keeps a malicious paste from chewing
through memory.
"""
from __future__ import annotations

from typing import Any

import yaml
from fastapi import HTTPException, status

_MAX_BYTES = 32 * 1024


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
