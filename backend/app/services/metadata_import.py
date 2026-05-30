"""Parser for upstream ``fdroiddata`` metadata.yml files.

We only consume the YAML files (not the deprecated ``.txt`` metadata
format) and return a flat dict the New App form can prefill itself with.

Security: we parse with a hardened ``SafeLoader`` subclass — no arbitrary
Python type instantiation, no ``!Loader`` tags (SafeLoader), AND no YAML
aliases. Aliases are refused because ``safe_load`` still *expands* them,
so a 250-byte "billion laughs" anchor/alias chain explodes into tens of
millions of nodes (verified: ~250 B → 54 M nodes → 8 s CPU) — a trivial
DoS that the 32 KiB size cap does nothing to stop. Anchors without an
alias are harmless and rare in metadata.yml; we reject only on the alias
event, so ``&``/``*`` inside ordinary string values parse fine. Unknown
keys are silently dropped.
"""
from __future__ import annotations

from typing import Any

import yaml
from fastapi import HTTPException, status

_MAX_BYTES = 32 * 1024


class _SafeLoaderNoAlias(yaml.SafeLoader):
    """``SafeLoader`` that additionally refuses YAML aliases (``*ref``),
    closing the alias-expansion ("billion laughs") DoS that plain
    ``safe_load`` is vulnerable to."""

    def compose_node(self, parent: Any, index: Any) -> Any:  # noqa: ANN401
        if self.check_event(yaml.events.AliasEvent):
            ev = self.get_event()
            raise yaml.composer.ComposerError(
                None, None, "YAML aliases are not permitted", ev.start_mark
            )
        return super().compose_node(parent, index)


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
        data = yaml.load(raw, Loader=_SafeLoaderNoAlias)  # noqa: S506 — hardened SafeLoader subclass, aliases refused
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
