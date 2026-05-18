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
