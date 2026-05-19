"use client";

import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import en from "@/locales/en.json";
import fr from "@/locales/fr.json";

/* Single global i18next instance.
 *
 * Locale resolution order at first paint:
 *   1. ``localStorage["i18nextLng"]`` — what the user picked last time
 *   2. ``navigator.language`` — the browser's preference
 *   3. ``en`` — the fallback
 *
 * Once the auth store hydrates, ``I18nProvider`` may override the locale to
 * ``user.preferred_locale`` (the same field that drives F-Droid catalogue
 * localisation), so logged-in users get a single language for both UI and
 * content. The localStorage entry is updated automatically by the detector
 * whenever ``changeLanguage`` runs.
 *
 * ``nonExplicitSupportedLngs`` lets BCP47 region tags like ``fr-FR`` resolve
 * to the base ``fr`` resource without an extra config entry. */
if (!i18n.isInitialized) {
  i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources: {
        en: { translation: en },
        fr: { translation: fr },
      },
      fallbackLng: "en",
      supportedLngs: ["en", "fr"],
      nonExplicitSupportedLngs: true,
      load: "languageOnly",
      detection: {
        order: ["localStorage", "navigator"],
        lookupLocalStorage: "i18nextLng",
        caches: ["localStorage"],
      },
      interpolation: { escapeValue: false },
      // Quiet logs in production; keep them in dev so missing keys surface.
      debug: false,
      returnEmptyString: false,
    });
}

export default i18n;
