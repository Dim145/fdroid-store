"use client";

import { useEffect } from "react";
import { I18nextProvider } from "react-i18next";

import i18n from "@/lib/i18n";
import { useAuth } from "@/lib/auth-store";

/* Glue between the auth store's ``preferred_locale`` and i18next.
 *
 * When the user logs in (or changes their language in /account), this hook
 * pushes the new locale into i18next so the next React tick re-renders the
 * UI in that language. Anonymous visitors keep whatever the detector
 * picked at first paint.
 *
 * We rely on i18next's ``nonExplicitSupportedLngs`` to map BCP47 region
 * tags (``fr-FR``, ``fr-CA``, ``en-GB``) to a supported base resource. */
function LocaleSync({ children }: { children: React.ReactNode }) {
  const preferred = useAuth((s) => s.user?.preferred_locale ?? null);
  useEffect(() => {
    if (!preferred) return;
    // ``changeLanguage`` is idempotent — calling it with the current value
    // is a cheap no-op. Skip when the user clears the preference; we don't
    // want to forcibly reset everyone to en-US on sign-out.
    if (preferred !== i18n.language) {
      i18n.changeLanguage(preferred);
    }
  }, [preferred]);
  return <>{children}</>;
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <LocaleSync>{children}</LocaleSync>
    </I18nextProvider>
  );
}
