"use client";

import { Moon, MonitorSmartphone, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useTheme } from "@/components/theme-provider";

/* Single-button theme toggle. Cycles light → system → dark → light…
 *
 * Replaces the previous three-segment control, which ate ~110px of header
 * real estate for three buttons most users never touch. The cycling pill
 * keeps the same three preferences reachable in 1–2 clicks, surfaces the
 * current one via the icon, and meets the 40×40 touch-target floor that
 * the segmented version missed on mobile. */
type Pref = "light" | "system" | "dark";
const ORDER: readonly Pref[] = ["light", "system", "dark"];

export function ThemeToggle() {
  const { t } = useTranslation();
  const { preference, setPreference } = useTheme();

  const idx = ORDER.indexOf(preference as Pref);
  const next = ORDER[(idx + 1) % ORDER.length];

  // Localised name of the preference we'd land on if clicked — surfaced
  // as an aria label and tooltip so users (and screen readers) know
  // ahead of time what the click does.
  const nextLabel = t(`theme.${next}`);
  const currentLabel = t(`theme.${preference}`);

  const Icon =
    preference === "light" ? Sun
      : preference === "dark" ? Moon
        : MonitorSmartphone;

  return (
    <button
      type="button"
      onClick={() => setPreference(next)}
      aria-label={t("theme.cycleAria", {
        current: currentLabel,
        next: nextLabel,
        defaultValue: `Theme: ${currentLabel}. Click to switch to ${nextLabel}.`,
      })}
      title={t("theme.cycleTooltip", {
        next: nextLabel,
        defaultValue: `Switch to ${nextLabel} theme`,
      })}
      // The 40×40 hit area matches the user-menu pill next to it, so the
      // two read as one row of icon-buttons rather than a mismatched pair.
      className="inline-flex h-10 w-10 items-center justify-center rounded-pill border border-outline-soft bg-surface text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30"
    >
      <Icon className="h-4 w-4" strokeWidth={2.2} />
    </button>
  );
}
