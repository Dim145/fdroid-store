"use client";

import { Globe2, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type Localization } from "@/lib/api";
import { COMMON_LOCALES, localeLabel } from "@/lib/locales";
import { toast } from "@/lib/toast-store";
import { cn } from "@/lib/utils";

type Draft = {
  locale: string;
  name: string;
  summary: string;
  description: string;
  video: string;
  /** True until the row has been persisted at least once. Drafts live only
   *  in this component's state — deleting one is a no-op for the server. */
  isDraft: boolean;
  saving: boolean;
};

const BCP47 = /^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,4})?$/;

type Props = {
  appId: string;
  localizations: Localization[];
  /** Called after a successful save or delete so the parent can refetch
   *  ``app.localizations`` and re-hydrate this editor in its next render. */
  onSaved: () => void | Promise<void>;
};

/* Per-locale override editor.
 *
 * The app's top-level Title / Summary / Description fields are the en-US
 * "defaults". This section only manages OVERRIDES for other locales (or an
 * explicit en-US override if you really want one). The F-Droid client picks
 * the closest match for the device's UI locale and falls back to the default
 * when no override exists.
 *
 * State model: every locale row carries an ``isDraft`` flag. Drafts live
 * client-side until you click Save (which PUTs to the server and clears
 * the flag); deleting a draft is just removing it from state, with no API
 * call. Saved rows go through DELETE on the server when removed. */
export function LocalizationsEditor({ appId, localizations, onSaved }: Props) {
  const [rows, setRows] = useState<Draft[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [customLocale, setCustomLocale] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);

  // Hydrate from the parent on every fresh AppDetail load. Existing drafts
  // (rows with ``isDraft=true``) are preserved across re-hydrations so a
  // user mid-typing a new translation doesn't lose their work when the
  // parent refetches.
  useEffect(() => {
    setRows((prev) => {
      const drafts = prev.filter((r) => r.isDraft);
      const hydrated: Draft[] = localizations.map((l) => ({
        locale: l.locale,
        name: l.name ?? "",
        summary: l.summary ?? "",
        description: l.description ?? "",
        video: l.video ?? "",
        isDraft: false,
        saving: false,
      }));
      // Drop drafts whose locale just landed from the server (would dup).
      const knownLocales = new Set(hydrated.map((r) => r.locale));
      const survivingDrafts = drafts.filter((r) => !knownLocales.has(r.locale));
      return [...hydrated, ...survivingDrafts];
    });
  }, [localizations]);

  // Click-outside to close the picker.
  useEffect(() => {
    if (!pickerOpen) return;
    function onClick(e: MouseEvent) {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [pickerOpen]);

  const usedLocales = useMemo(() => new Set(rows.map((r) => r.locale)), [rows]);
  const availableCommon = useMemo(
    () => COMMON_LOCALES.filter((l) => !usedLocales.has(l.code)),
    [usedLocales],
  );

  function addLocale(code: string) {
    if (usedLocales.has(code)) {
      toast.error("Already added", `A ${code} translation already exists.`);
      return;
    }
    if (!BCP47.test(code)) {
      toast.error("Bad locale tag", "Use a BCP47 tag like 'fr-FR' or 'pt-BR'.");
      return;
    }
    setRows((prev) => [
      ...prev,
      {
        locale: code,
        name: "",
        summary: "",
        description: "",
        video: "",
        isDraft: true,
        saving: false,
      },
    ]);
    setPickerOpen(false);
    setCustomLocale("");
    // Scroll the new card into view on the next paint.
    requestAnimationFrame(() => {
      const el = document.getElementById(`loc-card-${code}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  function updateRow(locale: string, patch: Partial<Draft>) {
    setRows((prev) => prev.map((r) => (r.locale === locale ? { ...r, ...patch } : r)));
  }

  async function saveRow(row: Draft) {
    if (
      !row.name.trim() &&
      !row.summary.trim() &&
      !row.description.trim() &&
      !row.video.trim()
    ) {
      toast.error(
        "Nothing to save",
        "Fill in at least one of Title, Summary, Description or Video URL.",
      );
      return;
    }
    updateRow(row.locale, { saving: true });
    try {
      await api.apps.upsertLocalization(appId, row.locale, {
        name: row.name.trim() || null,
        summary: row.summary.trim() || null,
        description: row.description.trim() || null,
        video: row.video.trim() || null,
      });
      toast.success(`Saved ${localeLabel(row.locale).label}.`);
      await onSaved();
    } catch (e) {
      toast.error("Save failed", e instanceof Error ? e.message : undefined);
    } finally {
      updateRow(row.locale, { saving: false });
    }
  }

  async function removeRow(row: Draft) {
    if (row.isDraft) {
      setRows((prev) => prev.filter((r) => r.locale !== row.locale));
      return;
    }
    if (!confirm(`Remove the ${localeLabel(row.locale).label} translation?`)) return;
    updateRow(row.locale, { saving: true });
    try {
      await api.apps.deleteLocalization(appId, row.locale);
      toast.success(`Removed ${localeLabel(row.locale).label}.`);
      await onSaved();
    } catch (e) {
      toast.error("Delete failed", e instanceof Error ? e.message : undefined);
      updateRow(row.locale, { saving: false });
    }
  }

  // Sort: saved rows first, then drafts, both alphabetised by locale code.
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        if (a.isDraft !== b.isDraft) return a.isDraft ? 1 : -1;
        return a.locale.localeCompare(b.locale);
      }),
    [rows],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-ink-soft">
          Override the listing for a specific language. The fields at the
          top of the page (Title, Summary, Description) ship as your{" "}
          <span className="font-mono">en-US</span> defaults. F-Droid clients
          show whichever locale matches the device, falling back to the
          defaults when no override exists.
        </p>

        <div ref={pickerRef} className="relative shrink-0">
          <Button
            type="button"
            variant="filled"
            size="md"
            onClick={() => setPickerOpen((o) => !o)}
            disabled={availableCommon.length === 0 && rows.length >= COMMON_LOCALES.length}
          >
            <Plus className="h-4 w-4" /> Add translation
          </Button>
          {pickerOpen && (
            <div className="absolute right-0 top-12 z-20 w-80 rounded-2xl border border-outline-soft bg-surface p-3 shadow-e3">
              <div className="mb-2 px-1 text-[10px] uppercase tracking-wider text-ink-mute">
                Pick a locale
              </div>
              <div className="max-h-72 space-y-0.5 overflow-y-auto">
                {availableCommon.length === 0 ? (
                  <p className="px-2 py-2 text-xs italic text-ink-mute">
                    Every common locale is already on the app.
                  </p>
                ) : (
                  availableCommon.map((l) => (
                    <button
                      key={l.code}
                      type="button"
                      onClick={() => addLocale(l.code)}
                      className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-ink">
                          {l.label}
                        </span>
                        {l.native !== l.label && (
                          <span className="block truncate text-xs text-ink-mute">
                            {l.native}
                          </span>
                        )}
                      </span>
                      <span className="font-mono text-[10px] text-ink-mute">
                        {l.code}
                      </span>
                    </button>
                  ))
                )}
              </div>
              <div className="mt-2 border-t border-outline-soft pt-2">
                <div className="mb-1 px-1 text-[10px] uppercase tracking-wider text-ink-mute">
                  Other (BCP47)
                </div>
                <div className="flex gap-1.5 px-1">
                  <Input
                    placeholder="e.g. zh-Hant"
                    value={customLocale}
                    onChange={(e) => setCustomLocale(e.target.value)}
                    className="h-9"
                  />
                  <Button
                    type="button"
                    variant="outlined"
                    size="sm"
                    onClick={() => addLocale(customLocale.trim())}
                    disabled={!customLocale.trim()}
                  >
                    Add
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-outline-soft bg-surface-2/40 px-6 py-10 text-center">
          <Globe2 className="h-6 w-6 text-ink-mute" />
          <p className="text-sm text-ink-soft">
            No translations yet — only your default fields will be served.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {sorted.map((row) => {
            const lbl = localeLabel(row.locale);
            const dirty =
              row.name.trim() ||
              row.summary.trim() ||
              row.description.trim() ||
              row.video.trim();
            return (
              <li
                key={row.locale}
                id={`loc-card-${row.locale}`}
                className={cn(
                  "rounded-2xl border bg-surface-2/40 p-4 transition-colors",
                  row.isDraft
                    ? "border-primary/50 ring-1 ring-primary/20"
                    : "border-outline-soft",
                )}
              >
                <header className="mb-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                        {row.locale}
                      </span>
                      {row.isDraft && (
                        <span className="rounded-pill bg-primary-container px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary-on-container">
                          Draft
                        </span>
                      )}
                    </div>
                    <h4 className="truncate text-base font-semibold text-ink">
                      {lbl.native !== lbl.label ? (
                        <>
                          {lbl.label} · <span className="text-ink-soft">{lbl.native}</span>
                        </>
                      ) : (
                        lbl.label
                      )}
                    </h4>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeRow(row)}
                    disabled={row.saving}
                    className="text-danger hover:bg-danger-container hover:text-danger-on-container"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Remove
                  </Button>
                </header>

                <div className="grid gap-3 md:grid-cols-2">
                  <FormField label="Title" htmlFor={`loc-name-${row.locale}`}>
                    <Input
                      id={`loc-name-${row.locale}`}
                      value={row.name}
                      maxLength={255}
                      onChange={(e) => updateRow(row.locale, { name: e.target.value })}
                      placeholder="(falls back to the default Title)"
                    />
                  </FormField>
                  <FormField label="Video URL" htmlFor={`loc-video-${row.locale}`}>
                    <Input
                      id={`loc-video-${row.locale}`}
                      type="url"
                      value={row.video}
                      maxLength={512}
                      onChange={(e) => updateRow(row.locale, { video: e.target.value })}
                      placeholder="https://…"
                    />
                  </FormField>
                  <FormField label="Summary" htmlFor={`loc-summary-${row.locale}`} className="md:col-span-2">
                    <Input
                      id={`loc-summary-${row.locale}`}
                      value={row.summary}
                      maxLength={255}
                      onChange={(e) => updateRow(row.locale, { summary: e.target.value })}
                      placeholder="(falls back to the default Summary)"
                    />
                  </FormField>
                  <FormField label="Description" htmlFor={`loc-desc-${row.locale}`} className="md:col-span-2">
                    <textarea
                      id={`loc-desc-${row.locale}`}
                      value={row.description}
                      maxLength={20000}
                      onChange={(e) => updateRow(row.locale, { description: e.target.value })}
                      rows={5}
                      placeholder="(falls back to the default Description)"
                      className="w-full rounded-xl border border-outline bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
                    />
                  </FormField>
                </div>

                <div className="mt-3 flex justify-end">
                  <Button
                    type="button"
                    variant="filled"
                    size="sm"
                    onClick={() => saveRow(row)}
                    disabled={row.saving || !dirty}
                  >
                    {row.saving ? "Saving…" : row.isDraft ? "Save translation" : "Update"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FormField({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-sm font-medium text-ink-soft">
        {label}
      </Label>
      {children}
    </div>
  );
}
