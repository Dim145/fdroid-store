"""Heuristic detection of common anti-feature signatures in an APK.

This is a starter catalogue, not an exhaustive one — it catches the most
visible offenders (Firebase, AdMob, Crashlytics, Facebook SDK, Sentry,
…) so the New Version upload page can pre-suggest the right chips.

Strategy: list every class file inside the APK's classes*.dex and run a
fast substring match against a small table. Class names alone are noisy
(some libraries vendor shaded copies), so a single hit on a tracker SDK
is enough to *suggest* the flag — the human reviewer still has to
confirm by toggling the chip.

The scan reads the APK's zip directory in-process; it doesn't fully
disassemble the DEX (which would be expensive and reproduce androguard
work that's already done in apk_parser.py).
"""
from __future__ import annotations

import re
import zipfile
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Signature:
    """One needle to look for inside the APK."""

    # The anti-feature this signature implies. Must match one of the slugs
    # the F-Droid client recognises (see ``KNOWN_ANTI_FEATURES`` in the
    # frontend).
    flag: str
    # Short, human-readable name of what was detected — shown next to the
    # chip in the UI ("Detected: Firebase Analytics").
    label: str
    # Class-path or string substring to look for. Matched case-sensitively
    # against the entries of classes*.dex.
    needle: str


# Curated list. Keep it tight; one false positive on a famous app would
# hurt the feature's credibility.
_SIGNATURES: tuple[Signature, ...] = (
    # — Tracking / telemetry ----------------------------------------------
    Signature("Tracking", "Firebase Analytics", "com/google/firebase/analytics"),
    Signature("Tracking", "Google Mobile Ads", "com/google/android/gms/ads"),
    Signature("Tracking", "Facebook SDK", "com/facebook/appevents"),
    Signature("Tracking", "Amplitude", "com/amplitude/api"),
    Signature("Tracking", "Mixpanel", "com/mixpanel/android"),
    Signature("Tracking", "Flurry", "com/flurry/android"),
    Signature("Tracking", "Adjust", "com/adjust/sdk"),
    Signature("Tracking", "Segment", "com/segment/analytics"),
    Signature("Tracking", "Branch", "io/branch/referral"),
    Signature("Tracking", "OneSignal", "com/onesignal"),
    Signature("Tracking", "AppsFlyer", "com/appsflyer"),
    Signature("Tracking", "Crashlytics", "com/google/firebase/crashlytics"),
    Signature("Tracking", "Sentry", "io/sentry"),
    Signature("Tracking", "Bugsnag", "com/bugsnag/android"),
    Signature("Tracking", "Matomo", "org/matomo/sdk"),
    # — Non-free network dependencies ------------------------------------
    Signature("NonFreeNet", "Google Play Services Core", "com/google/android/gms/common/GoogleApiAvailability"),
    Signature("NonFreeNet", "Firebase Messaging", "com/google/firebase/messaging"),
    Signature("NonFreeNet", "Huawei Push", "com/huawei/hms/push"),
    # — Non-free dependencies (bundled proprietary libs) -----------------
    Signature("NonFreeDep", "Google Play Billing", "com/android/billingclient/api"),
    Signature("NonFreeDep", "Google Maps SDK", "com/google/android/gms/maps"),
    Signature("NonFreeDep", "ReCAPTCHA", "com/google/android/gms/recaptcha"),
)


# Regex used to walk DEX strings. Mostly noise-tolerant — we just want
# the path tokens.
_CLASS_TOKEN = re.compile(rb"[A-Za-z0-9_/$]+")


@dataclass
class Detection:
    flag: str
    label: str
    # Where the signature was found ("classes2.dex" or "manifest"). Useful
    # in the UI tooltip so the user can sanity-check before applying.
    location: str


def scan_apk(path: str | Path) -> list[Detection]:
    """Return one ``Detection`` per (flag, label) pair that matched. The
    same flag may surface multiple times (e.g. both Firebase Analytics
    and Crashlytics fire ``Tracking``) — the UI dedupes by flag when
    rendering the chip set.
    """
    p = Path(path)
    if not p.exists():
        return []

    detections: list[Detection] = []
    try:
        with zipfile.ZipFile(p) as zf:
            dex_names = [n for n in zf.namelist() if n.startswith("classes") and n.endswith(".dex")]
            # Pre-encode needles once.
            encoded = [(sig, sig.needle.encode("ascii")) for sig in _SIGNATURES]
            for dex in dex_names:
                try:
                    blob = zf.read(dex)
                except Exception:
                    continue
                # ``blob.find`` over the raw DEX bytes catches the class
                # paths regardless of how the string table is laid out —
                # they appear verbatim in the type/method descriptors.
                for sig, needle in encoded:
                    if needle in blob:
                        detections.append(
                            Detection(flag=sig.flag, label=sig.label, location=dex)
                        )
    except zipfile.BadZipFile:
        return []
    return detections


def summarise(detections: list[Detection]) -> dict[str, list[str]]:
    """Group detections by anti-feature flag, returning the human labels
    for each. The shape ``{flag: [label, …]}`` is what the API returns
    to the frontend; the UI uses the labels for the chip tooltip and the
    keys as the chip flags to toggle."""
    grouped: dict[str, list[str]] = {}
    for d in detections:
        grouped.setdefault(d.flag, []).append(d.label)
    # Stable order; dedupe labels.
    return {k: sorted(set(v)) for k, v in grouped.items()}
