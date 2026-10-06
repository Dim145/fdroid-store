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

# The DEX files are streamed, never inflated whole: a deflate bomb in a
# ~400 KiB APK would otherwise cost >1 GiB of RAM. One dex tops out around
# a few tens of MiB (64K-method limit); entries declaring more are skipped
# and the inflated total is capped — the scan only suggests chips anyway.
_DEX_MAX = 64 * 1024 * 1024
_DEX_TOTAL_MAX = 256 * 1024 * 1024
_CHUNK = 1024 * 1024


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
            dex_infos = [
                i for i in zf.infolist()
                if i.filename.startswith("classes") and i.filename.endswith(".dex")
            ]
            # Pre-encode needles once.
            encoded = [(sig, sig.needle.encode("ascii")) for sig in _SIGNATURES]
            budget = _DEX_TOTAL_MAX
            for info in dex_infos:
                if info.file_size > min(_DEX_MAX, budget):
                    continue
                # Charged up front: ``zipfile`` never inflates more than the
                # declared size, and a dex that fails half-way still counts.
                budget -= info.file_size
                try:
                    _scan_dex(zf, info, encoded, detections)
                except Exception:
                    continue
    except zipfile.BadZipFile:
        return []
    return detections


def _scan_dex(
    zf: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    encoded: list[tuple[Signature, bytes]],
    detections: list[Detection],
) -> None:
    """Search one DEX for the needles in bounded chunks. ``zipfile`` stops
    at the declared size (capped by the caller) and the loop stops at
    ``_DEX_MAX`` regardless. Matching over the raw bytes catches the class
    paths regardless of how the string table is laid out — they appear
    verbatim in the type/method descriptors."""
    overlap = max(len(needle) for _, needle in encoded) - 1
    pending = list(encoded)
    inflated = 0
    tail = b""
    with zf.open(info) as fh:
        while pending and inflated < _DEX_MAX:
            chunk = fh.read(_CHUNK)
            if not chunk:
                break
            inflated += len(chunk)
            window = tail + chunk
            still: list[tuple[Signature, bytes]] = []
            for sig, needle in pending:
                if needle in window:
                    detections.append(
                        Detection(flag=sig.flag, label=sig.label, location=info.filename)
                    )
                else:
                    still.append((sig, needle))
            pending = still
            tail = window[-overlap:]


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
