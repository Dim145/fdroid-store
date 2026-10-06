import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { Category } from "@/lib/api";

type Labelled = Pick<Category, "name"> & {
  names?: Record<string, string>;
  descriptions?: Record<string, string>;
  description?: string | null;
};

/** Pick ``lang`` (or its base language) from a ``{locale: text}`` map. */
function pick(map: Record<string, string> | undefined, lang: string): string | undefined {
  if (!map) return undefined;
  return map[lang] ?? map[lang.split("-")[0]];
}

/** Display name of a category in the UI language. Official F-Droid IDs
 *  carry localized names (the same ones the index ships); custom ones fall
 *  back to their raw name, which is also the English label. */
export function categoryLabel(c: Labelled, lang: string): string {
  return pick(c.names, lang) ?? c.name;
}

export function categoryDescription(c: Labelled, lang: string): string | null {
  return pick(c.descriptions, lang) ?? c.description ?? null;
}

/** Hook flavour bound to the active i18next language. */
export function useCategoryLabel(): (c: Labelled) => string {
  const { i18n } = useTranslation();
  const lang = i18n.language || "en";
  return useCallback((c: Labelled) => categoryLabel(c, lang), [lang]);
}
