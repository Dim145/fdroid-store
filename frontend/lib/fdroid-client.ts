/* Behaviour of the F-Droid Android client (2.0+) that the UI needs to
 * anticipate. Mirrors the client source so owners see the consequence of
 * an upload before their users do. */

/** Device API level → minimum app ``targetSdkVersion`` for which F-Droid
 *  can install an update without user action (Android's
 *  ``setRequireUserAction`` rules, as encoded in the client's
 *  ``SessionInstallManager.isAutoUpdateSupported``). */
const UNATTENDED_UPDATE_MIN_TARGET: ReadonlyArray<[deviceSdk: number, minTarget: number]> = [
  [31, 29],
  [32, 29],
  [33, 30],
  [34, 31],
  [35, 33],
  [36, 34],
];

const ANDROID_RELEASE: Record<number, string> = {
  31: "12",
  32: "12L",
  33: "13",
  34: "14",
  35: "15",
  36: "16",
};

/** First Android release on which F-Droid can no longer update an app
 *  targeting ``targetSdk`` silently (it then asks the user every time and
 *  shows "auto-update not available"), or ``null`` when every current
 *  release still allows it. */
export function unattendedUpdatesBlockedFrom(targetSdk: number | null | undefined): string | null {
  if (targetSdk == null) return null;
  for (const [deviceSdk, minTarget] of UNATTENDED_UPDATE_MIN_TARGET) {
    if (targetSdk < minTarget) return ANDROID_RELEASE[deviceSdk];
  }
  return null;
}

/** Opens the app's page in an installed store. F-Droid 2.0 handles
 *  ``market://details`` and shows the app if one of its repos carries it. */
export function storeAppLink(packageName: string): string {
  return `market://details?id=${encodeURIComponent(packageName)}`;
}

/** Version is held back on the Beta channel (same rule as the index:
 *  everything above the suggested version). */
export function isBetaVersion(
  versionCode: number,
  suggestedVersionCode: number | null | undefined,
): boolean {
  return suggestedVersionCode != null && versionCode > suggestedVersionCode;
}

// ---------------------------------------------------------------------------
// Funding links — the F-Droid client builds them from bare IDs; the DB may
// hold either IDs (fdroiddata imports) or full URLs (older form entries).
// ---------------------------------------------------------------------------
const LIBERAPAY_URL = /^(?:https?:\/\/)?(?:www\.)?liberapay\.com\/([^/?#\s]+)/i;
const OPENCOLLECTIVE_URL = /^(?:https?:\/\/)?(?:www\.)?opencollective\.com\/([^/?#\s]+)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function platformLink(value: string, pattern: RegExp, build: (id: string) => string): string {
  const v = value.trim();
  const m = v.match(pattern);
  if (m) return build(m[1]);
  if (HAS_SCHEME.test(v) || v.includes("/")) return v;
  return build(encodeURIComponent(v));
}

export function liberapayLink(value: string): string {
  return platformLink(value, LIBERAPAY_URL, (id) => `https://liberapay.com/${id}/donate`);
}

export function openCollectiveLink(value: string): string {
  return platformLink(value, OPENCOLLECTIVE_URL, (id) => `https://opencollective.com/${id}/donate`);
}

export function bitcoinLink(value: string): string {
  const v = value.trim();
  return v.toLowerCase().startsWith("bitcoin:") ? v : `bitcoin:${v}`;
}
