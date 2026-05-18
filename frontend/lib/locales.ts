/* Curated BCP47 locale catalogue used by the Translations editor. The list
 * mirrors the top of the F-Droid Android client's supported-locale set —
 * not every locale ever shipped, but enough to cover the long tail of apps
 * a self-hosted instance is likely to publish. Anything outside the list
 * can still be entered via the "Other" free-text field; the backend only
 * validates the BCP47 shape, not the catalogue. */

export type LocaleEntry = {
  /** BCP47 tag — what gets sent to the API and stored in the DB. */
  code: string;
  /** English label, what we render in the picker. */
  label: string;
  /** Native-script label rendered next to the English one to help
   *  contributors recognise their own language at a glance. */
  native: string;
};

export const COMMON_LOCALES: LocaleEntry[] = [
  { code: "en-US",  label: "English (US)",       native: "English (US)" },
  { code: "en-GB",  label: "English (UK)",       native: "English (UK)" },
  { code: "fr-FR",  label: "French",             native: "Français" },
  { code: "de-DE",  label: "German",             native: "Deutsch" },
  { code: "es-ES",  label: "Spanish",            native: "Español" },
  { code: "es-MX",  label: "Spanish (Mexico)",   native: "Español (México)" },
  { code: "pt-PT",  label: "Portuguese",         native: "Português" },
  { code: "pt-BR",  label: "Portuguese (Brazil)",native: "Português (Brasil)" },
  { code: "it-IT",  label: "Italian",            native: "Italiano" },
  { code: "nl-NL",  label: "Dutch",              native: "Nederlands" },
  { code: "ru-RU",  label: "Russian",            native: "Русский" },
  { code: "uk-UA",  label: "Ukrainian",          native: "Українська" },
  { code: "pl-PL",  label: "Polish",             native: "Polski" },
  { code: "cs-CZ",  label: "Czech",              native: "Čeština" },
  { code: "sv-SE",  label: "Swedish",            native: "Svenska" },
  { code: "no-NO",  label: "Norwegian",          native: "Norsk" },
  { code: "da-DK",  label: "Danish",             native: "Dansk" },
  { code: "fi-FI",  label: "Finnish",            native: "Suomi" },
  { code: "tr-TR",  label: "Turkish",            native: "Türkçe" },
  { code: "el-GR",  label: "Greek",              native: "Ελληνικά" },
  { code: "ar-SA",  label: "Arabic",             native: "العربية" },
  { code: "he-IL",  label: "Hebrew",             native: "עברית" },
  { code: "ja-JP",  label: "Japanese",           native: "日本語" },
  { code: "zh-CN",  label: "Chinese (Simplified)", native: "简体中文" },
  { code: "zh-TW",  label: "Chinese (Traditional)", native: "繁體中文" },
  { code: "ko-KR",  label: "Korean",             native: "한국어" },
  { code: "vi-VN",  label: "Vietnamese",         native: "Tiếng Việt" },
  { code: "th-TH",  label: "Thai",               native: "ไทย" },
  { code: "id-ID",  label: "Indonesian",         native: "Bahasa Indonesia" },
  { code: "hi-IN",  label: "Hindi",              native: "हिन्दी" },
];

const _BY_CODE = new Map(COMMON_LOCALES.map((l) => [l.code, l] as const));

/** Look up a locale's display info; falls back to a synthetic entry whose
 *  label === code so unknown locales still render in the UI. */
export function localeLabel(code: string): LocaleEntry {
  return _BY_CODE.get(code) ?? { code, label: code, native: code };
}
