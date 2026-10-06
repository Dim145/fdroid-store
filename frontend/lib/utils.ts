import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "kB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

/** Where to send the user after sign-in (``?next=``, or the target carried
 *  across the SSO round-trip). Defence against open redirects: the cheap
 *  ``startsWith`` checks missed several browser-tolerated bypasses (single
 *  backslash, percent-encoded slash, tab/whitespace), so the value is
 *  parsed with ``URL`` against our own origin and anything resolving
 *  elsewhere falls back to ``/apps``. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || raw.length > 512) return "/apps";
  if (typeof window === "undefined") return "/apps";
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return "/apps";
    // ``/.//evil.com`` keeps our origin but normalises to the path
    // ``//evil.com`` — protocol-relative, i.e. off-site, once it reaches
    // the router.
    if (/^\/[/\\]/.test(url.pathname)) return "/apps";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/apps";
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Pick the best release-notes entry for the caller out of a
 *  ``{locale: text}`` dict. Tries the preferred locale first, then a
 *  language-only fallback, then en-US, then any first entry. Returns
 *  ``null`` when the dict is empty. */
export function pickLocalizedText(
  bag: Record<string, string> | null | undefined,
  preferredLocale?: string | null,
): { text: string; locale: string } | null {
  if (!bag) return null;
  const keys = Object.keys(bag).filter((k) => !!bag[k]);
  if (keys.length === 0) return null;
  if (preferredLocale) {
    if (bag[preferredLocale]) return { text: bag[preferredLocale], locale: preferredLocale };
    const primary = preferredLocale.split("-")[0].toLowerCase();
    const langMatch = keys.find((k) => k.split("-")[0].toLowerCase() === primary);
    if (langMatch) return { text: bag[langMatch], locale: langMatch };
  }
  if (bag["en-US"]) return { text: bag["en-US"], locale: "en-US" };
  return { text: bag[keys[0]], locale: keys[0] };
}

/** Compact integer formatter — ``1234 → "1.2k"`` ``12345 → "12k"``. Keeps a
 *  decimal only when it changes the reading (i.e. under 10× the unit). */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const abs = Math.abs(n);
  if (abs < 1000) return n.toString();
  const units = [
    { value: 1_000_000_000, suffix: "B" },
    { value: 1_000_000, suffix: "M" },
    { value: 1_000, suffix: "k" },
  ];
  for (const u of units) {
    if (abs >= u.value) {
      const v = n / u.value;
      return `${v.toFixed(v < 10 ? 1 : 0)}${u.suffix}`;
    }
  }
  return n.toString();
}
