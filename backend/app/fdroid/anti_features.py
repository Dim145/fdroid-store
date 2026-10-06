"""Anti-feature definitions emitted in the index-v2 ``repo.antiFeatures`` block.

F-Droid 2.0 only renders an anti-feature when the app's repository *defines*
it (``ui/details/AppDetailsItem.kt``: ``repository.getAntiFeatures()[key]
?: return@mapNotNull null``); 1.x fell back to built-in strings. Its new
"filter by anti-feature" list is also built from those definitions. So every
flag we put on a version must have a matching entry here, or it silently
disappears from the client.

Standard IDs follow upstream (fdroiddata ``config/antiFeatures.yml``), as the
F-Droid maintainers ask third-party repos to do; texts are our own wording.
Any other free-form flag an admin types still gets a minimal definition
(its own ID as the name) so it stays visible.
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any

DEFAULT_LOCALE = "en-US"

# id → (name_en, name_fr, description_en, description_fr)
ANTI_FEATURES: dict[str, tuple[str, str, str, str]] = {
    "Ads": (
        "Advertising",
        "Publicité",
        "This app contains advertising.",
        "Cette application contient de la publicité.",
    ),
    "Tracking": (
        "Tracking",
        "Pistage",
        "This app tracks and reports your activity.",
        "Cette application suit et transmet votre activité.",
    ),
    "NonFreeNet": (
        "Non-free network services",
        "Services réseau non libres",
        "This app promotes or depends on non-free network services.",
        "Cette application promeut ou utilise des services réseau non libres.",
    ),
    "NonFreeAdd": (
        "Non-free add-ons",
        "Extensions non libres",
        "This app promotes non-free add-ons.",
        "Cette application promeut des extensions non libres.",
    ),
    "NonFreeDep": (
        "Non-free dependencies",
        "Dépendances non libres",
        "This app depends on other non-free software.",
        "Cette application dépend d'autres logiciels non libres.",
    ),
    "NonFreeAssets": (
        "Non-free assets",
        "Ressources non libres",
        "This app contains non-free assets (media, data…).",
        "Cette application contient des ressources non libres (médias, données…).",
    ),
    "KnownVuln": (
        "Known vulnerability",
        "Vulnérabilité connue",
        "This version contains a known security vulnerability.",
        "Cette version contient une faille de sécurité connue.",
    ),
    "NoSourceSince": (
        "Source code no longer available",
        "Code source plus disponible",
        "The source code of this version is no longer available.",
        "Le code source de cette version n'est plus disponible.",
    ),
    "UpstreamNonFree": (
        "Upstream not fully free",
        "Projet d'origine pas entièrement libre",
        "The upstream source code is not entirely free software.",
        "Le code source d'origine n'est pas entièrement libre.",
    ),
    "DisabledAlgorithm": (
        "Insecure signature",
        "Signature non sûre",
        "This version is signed with an insecure algorithm.",
        "Cette version est signée avec un algorithme non sûr.",
    ),
    "TetheredNet": (
        "Tethered network service",
        "Service réseau imposé",
        "This app relies on a network service run by its developer that can't easily be"
        " replaced.",
        "Cette application dépend d'un service réseau du développeur difficilement remplaçable.",
    ),
    "NSFW": (
        "Not safe for work",
        "Contenu sensible",
        "This app contains content that may be inappropriate in some settings.",
        "Cette application contient des contenus pouvant être inappropriés dans certains"
        " contextes.",
    ),
}


def definition(flag: str) -> dict[str, Any]:
    """Index-v2 ``AntiFeatureV2`` object for ``flag``."""
    entry = ANTI_FEATURES.get(flag)
    if entry is None:
        return {"name": {DEFAULT_LOCALE: flag}}
    name_en, name_fr, desc_en, desc_fr = entry
    return {
        "name": {DEFAULT_LOCALE: name_en, "fr": name_fr},
        "description": {DEFAULT_LOCALE: desc_en, "fr": desc_fr},
    }


def definitions_for(flags: Iterable[str]) -> dict[str, dict[str, Any]]:
    """``repo.antiFeatures`` block covering every flag in ``flags``."""
    return {flag: definition(flag) for flag in sorted(set(flags))}
