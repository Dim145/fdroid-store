"use client";

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeft, Eye, GripVertical, ImagePlus, Plus, RotateCcw, ShieldAlert, Trash2, Upload, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useState } from "react";

import { AppIcon } from "@/components/app-icon";
import { AppPermissions } from "@/components/app-permissions";
import { AuthGuard } from "@/components/auth-guard";
import { LocalizationsEditor } from "@/components/localizations-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, mediaUrl, type Apk, type AppDetail, type Category, type Screenshot } from "@/lib/api";
import { COMMON_LOCALES, localeLabel } from "@/lib/locales";
import { toast } from "@/lib/toast-store";
import { cn, formatBytes, formatDate, pickLocalizedText } from "@/lib/utils";

function ManageAppInner() {
  // Static export bakes ``useParams`` to the placeholder used at build time
  // (``__dynamic``), so we read the real segment from the live URL instead.
  const pathname = usePathname();
  const id = useMemo(() => {
    const m = pathname?.match(/^\/my-apps\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }, [pathname]);
  const router = useRouter();

  const [app, setApp] = useState<AppDetail | null>(null);
  // The page-load error is the one case where we keep an inline state: a
  // failed initial fetch needs to replace the form with an error block, not
  // pop a toast that disappears.
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [license, setLicense] = useState("");
  const [website, setWebsite] = useState("");
  const [sourceCode, setSourceCode] = useState("");
  const [issueTracker, setIssueTracker] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [authorEmail, setAuthorEmail] = useState("");
  const [donate, setDonate] = useState("");
  const [liberapay, setLiberapay] = useState("");
  const [bitcoin, setBitcoin] = useState("");
  const [openCollective, setOpenCollective] = useState("");
  const [translation, setTranslation] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [availableCategories, setAvailableCategories] = useState<Category[]>([]);
  // Mirrors ``app.screenshots`` but holds the local drag-and-drop order. The
  // server is the source of truth; we sync from it on load and after each
  // successful reorder, but mutate it optimistically on drag end so the UI
  // doesn't flash through "old order → server → new order".
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [reorderingScreenshots, setReorderingScreenshots] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  // The changelog draft is a per-APK dict of locale → text. ``activeLocale``
  // is just the tab the user is editing right now; saving sends the whole
  // bag so removing a locale tab + saving deletes it server-side.
  const [editingChangelog, setEditingChangelog] = useState<{
    apkId: string;
    entries: Record<string, string>;
    activeLocale: string;
  } | null>(null);
  const [savingChangelog, setSavingChangelog] = useState(false);
  const [savingApkId, setSavingApkId] = useState<string | null>(null);

  async function load() {
    try {
      // raw=true returns canonical en-US fields, not the localized overlay —
      // otherwise editing the Title field would prefill the user's preferred-
      // locale translation and saving would write it back into the default.
      const detail = await api.apps.get(id, { raw: true });
      setApp(detail);
      setName(detail.name);
      setSummary(detail.summary || "");
      setDescription(detail.description || "");
      setLicense(detail.license || "");
      setWebsite(detail.website || "");
      setSourceCode(detail.source_code || "");
      setIssueTracker(detail.issue_tracker || "");
      setAuthorName(detail.author_name || "");
      setAuthorEmail(detail.author_email || "");
      setDonate(detail.donate || "");
      setLiberapay(detail.liberapay || "");
      setBitcoin(detail.bitcoin || "");
      setOpenCollective(detail.open_collective || "");
      setTranslation(detail.translation || "");
      setVisibility(detail.visibility);
      setSelectedCategoryIds(detail.categories.map((c) => c.id));
      setScreenshots(
        [...detail.screenshots].sort((a, b) => a.display_order - b.display_order),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load app");
    }
  }
  useEffect(() => { if (id) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);
  useEffect(() => {
    let cancelled = false;
    api.categories.list()
      .then((cs) => {
        if (cancelled) return;
        // Keep a stable alphabetical order so the chip layout doesn't reflow
        // every time we re-render.
        setAvailableCategories([...cs].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch(() => {/* non-fatal — the rest of the form still works */});
    return () => { cancelled = true; };
  }, []);

  function toggleCategory(catId: string) {
    setSelectedCategoryIds((prev) =>
      prev.includes(catId) ? prev.filter((id) => id !== catId) : [...prev, catId],
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!app) return;
    setSaving(true);
    try {
      await api.apps.update(app.id, {
        name,
        summary: summary || undefined,
        description: description || undefined,
        license: license || undefined,
        website: website || undefined,
        source_code: sourceCode || undefined,
        issue_tracker: issueTracker || undefined,
        author_name: authorName || undefined,
        author_email: authorEmail || undefined,
        donate: donate || undefined,
        liberapay: liberapay || undefined,
        bitcoin: bitcoin || undefined,
        open_collective: openCollective || undefined,
        translation: translation || undefined,
        visibility,
        category_ids: selectedCategoryIds,
      });
      toast.success("Listing saved.");
      await load();
    } catch (e) {
      toast.error("Save failed", e instanceof Error ? e.message : undefined);
    } finally { setSaving(false); }
  }
  async function uploadVersion(file: File) {
    if (!app) return;
    setUploading(true);
    try {
      await api.apps.uploadApk(app.id, file);
      toast.success("New version uploaded.");
      await load();
    } catch (e) {
      toast.error("Upload failed", e instanceof Error ? e.message : undefined);
    } finally { setUploading(false); }
  }
  async function deleteApk(apk: Apk) {
    if (!confirm(`Delete version ${apk.version_name} (${apk.version_code})?`)) return;
    try { await api.apps.deleteApk(apk.id); toast.success("Version deleted."); await load(); }
    catch (e) { toast.error("Delete failed", e instanceof Error ? e.message : undefined); }
  }
  async function deleteApp() {
    if (!app) return;
    if (!confirm(`Delete ${app.name} and ALL versions? Permanent.`)) return;
    try { await api.apps.remove(app.id); router.replace("/my-apps"); }
    catch (e) { toast.error("Delete failed", e instanceof Error ? e.message : undefined); }
  }
  async function saveChangelog() {
    if (!editingChangelog) return;
    setSavingChangelog(true);
    try {
      // Drop blank entries server-side and on the wire — an explicit empty
      // dict is interpreted as "clear it" by the API.
      const trimmed: Record<string, string> = {};
      for (const [locale, text] of Object.entries(editingChangelog.entries)) {
        if (text.trim()) trimmed[locale] = text.trim();
      }
      const payload =
        Object.keys(trimmed).length === 0 ? null : trimmed;
      await api.apps.updateApk(editingChangelog.apkId, { whats_new: payload });
      toast.success("Changelog saved.");
      setEditingChangelog(null);
      await load();
    } catch (e) {
      toast.error("Save failed", e instanceof Error ? e.message : undefined);
    } finally { setSavingChangelog(false); }
  }
  async function clearChangelog(apkId: string) {
    setSavingChangelog(true);
    try {
      await api.apps.updateApk(apkId, { whats_new: null });
      toast.success("Changelog cleared.");
      setEditingChangelog(null);
      await load();
    } catch (e) {
      toast.error("Clear failed", e instanceof Error ? e.message : undefined);
    } finally { setSavingChangelog(false); }
  }
  async function uploadCustomIcon(file: File) {
    if (!app) return;
    try { await api.apps.uploadIcon(app.id, file); toast.success("Custom icon uploaded."); await load(); }
    catch (e) { toast.error("Icon upload failed", e instanceof Error ? e.message : undefined); }
  }
  async function uploadFeatureGraphic(file: File) {
    if (!app) return;
    try { await api.apps.uploadFeatureGraphic(app.id, file); toast.success("Featured graphic uploaded."); await load(); }
    catch (e) { toast.error("Upload failed", e instanceof Error ? e.message : undefined); }
  }
  async function clearFeatureGraphic() {
    if (!app) return;
    if (!confirm("Remove the featured graphic?")) return;
    try { await api.apps.deleteFeatureGraphic(app.id); toast.success("Featured graphic removed."); await load(); }
    catch (e) { toast.error("Delete failed", e instanceof Error ? e.message : undefined); }
  }
  async function uploadPromoGraphic(file: File) {
    if (!app) return;
    try { await api.apps.uploadPromoGraphic(app.id, file); toast.success("Promo graphic uploaded."); await load(); }
    catch (e) { toast.error("Upload failed", e instanceof Error ? e.message : undefined); }
  }
  async function clearPromoGraphic() {
    if (!app) return;
    if (!confirm("Remove the promo graphic?")) return;
    try { await api.apps.deletePromoGraphic(app.id); toast.success("Promo graphic removed."); await load(); }
    catch (e) { toast.error("Delete failed", e instanceof Error ? e.message : undefined); }
  }
  async function uploadTvBanner(file: File) {
    if (!app) return;
    try { await api.apps.uploadTvBanner(app.id, file); toast.success("TV banner uploaded."); await load(); }
    catch (e) { toast.error("Upload failed", e instanceof Error ? e.message : undefined); }
  }
  async function clearTvBanner() {
    if (!app) return;
    if (!confirm("Remove the TV banner?")) return;
    try { await api.apps.deleteTvBanner(app.id); toast.success("TV banner removed."); await load(); }
    catch (e) { toast.error("Delete failed", e instanceof Error ? e.message : undefined); }
  }
  async function pinSuggestedVersion(versionCode: number) {
    if (!app) return;
    try {
      await api.apps.update(app.id, { suggested_version_code: versionCode });
      toast.success(`Suggested version pinned to v${versionCode}.`);
      await load();
    } catch (e) {
      toast.error("Pin failed", e instanceof Error ? e.message : undefined);
    }
  }
  async function resetSuggestedVersion() {
    if (!app) return;
    try {
      // null tells the server to clear the manual pin and revert to
      // auto-tracking the latest published APK.
      await api.apps.update(app.id, { suggested_version_code: null });
      toast.success("Suggested version back to auto.");
      await load();
    } catch (e) {
      toast.error("Reset failed", e instanceof Error ? e.message : undefined);
    }
  }
  async function toggleApkAntiFeature(apk: Apk, flag: string) {
    // Toggle locally then save. Optimistic + reload to stay in sync with the
    // server (the index rebuild is async so we want the canonical state back).
    const current = apk.anti_features || [];
    const next = current.includes(flag)
      ? current.filter((f) => f !== flag)
      : [...current, flag];
    setSavingApkId(apk.id);
    try {
      await api.apps.updateApk(apk.id, { anti_features: next });
      await load();
    } catch (e) {
      toast.error("Save failed", e instanceof Error ? e.message : undefined);
    } finally {
      setSavingApkId(null);
    }
  }
  async function revertIcon() {
    if (!app) return;
    if (!confirm("Revert to the icon extracted from the latest APK?")) return;
    try { await api.apps.revertIcon(app.id); toast.success("Icon reverted."); await load(); }
    catch (e) { toast.error("Revert failed", e instanceof Error ? e.message : undefined); }
  }
  async function uploadScreenshots(files: FileList | null) {
    if (!app || !files || files.length === 0) return;
    try {
      await api.apps.uploadScreenshots(app.id, Array.from(files));
      toast.success(`${files.length} screenshot${files.length === 1 ? "" : "s"} uploaded.`);
      await load();
    } catch (e) {
      toast.error("Upload failed", e instanceof Error ? e.message : undefined);
    }
  }
  async function deleteScreenshot(screenshotId: string) {
    if (!app) return;
    if (!confirm("Delete this screenshot?")) return;
    try { await api.apps.deleteScreenshot(app.id, screenshotId); await load(); }
    catch (e) { toast.error("Delete failed", e instanceof Error ? e.message : undefined); }
  }

  // dnd-kit sensors. A 6px activation distance prevents accidental drags on
  // click — important because the tile itself is the drag handle, and we
  // don't want a tap on the close button to be misread as the start of a
  // swipe.
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function onScreenshotDragEnd(e: DragEndEvent) {
    if (!app) return;
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const fromIndex = screenshots.findIndex((s) => s.id === active.id);
    const toIndex = screenshots.findIndex((s) => s.id === over.id);
    if (fromIndex === -1 || toIndex === -1) return;
    const previous = screenshots;
    const next = arrayMove(screenshots, fromIndex, toIndex);
    setScreenshots(next);
    setReorderingScreenshots(true);
    try {
      await api.apps.reorderScreenshots(app.id, next.map((s) => s.id));
      toast.success("Screenshot order saved.");
    } catch (err) {
      // Revert to the server-known state so the UI doesn't lie.
      setScreenshots(previous);
      toast.error("Reorder failed", err instanceof Error ? err.message : undefined);
    } finally {
      setReorderingScreenshots(false);
    }
  }

  if (!app && !error) {
    return <div className="flex justify-center py-24"><Spinner /></div>;
  }
  if (!app) {
    return <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{error}</p>;
  }

  const published = [...app.apks].filter((a) => a.status === "published").sort((a, b) => b.version_code - a.version_code);
  const latest = published[0];

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="surface flex flex-wrap items-start gap-5 p-6">
        <AppIcon iconPath={app.icon_path} name={app.name} size={88} version={app.updated_at} className="shadow-e2" />
        <div className="min-w-0 flex-1">
          <Link href="/my-apps" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft hover:text-ink">
            <ArrowLeft className="h-4 w-4" /> My apps
          </Link>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">{app.name}</h1>
          <p className="mt-0.5 font-mono text-xs text-ink-mute">{app.package_name}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge variant={app.visibility === "private" ? "accent" : "outline"}>{app.visibility}</Badge>
            <Badge variant={app.status === "published" ? "primary" : "soft"}>{app.status.replace("_", " ")}</Badge>
          </div>
        </div>
        <Button asChild variant="outlined" size="md">
          <Link href={`/apps/${app.package_name}`}>
            <Eye className="h-4 w-4" /> Public page
          </Link>
        </Button>
      </header>


      {/* ──── Listing ──── */}
      <Section step="01" title="Listing" subtitle="Package name is locked to the signing certificate.">
        <form onSubmit={save} className="grid gap-4 md:grid-cols-2">
          <FormField label="Title" htmlFor="name" className="md:col-span-2">
            <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField label="Package (locked)" htmlFor="pkg">
            <Input id="pkg" disabled value={app.package_name} className="font-mono text-xs" />
          </FormField>
          <FormField label="Visibility" htmlFor="vis">
            <select
              id="vis"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as "public" | "private")}
              className="h-12 w-full rounded-xl border border-outline bg-surface px-3 text-sm focus:border-primary focus:outline-none"
            >
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
          </FormField>
          <FormField label="Summary" htmlFor="sum" className="md:col-span-2">
            <Input id="sum" value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={255} />
          </FormField>
          <FormField label="Description" htmlFor="desc" className="md:col-span-2">
            <textarea
              id="desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
              className="w-full rounded-xl border border-outline bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
            />
          </FormField>
          <FormField label="Categories" className="md:col-span-2">
            <CategoryPicker
              available={availableCategories}
              selectedIds={selectedCategoryIds}
              onToggle={toggleCategory}
              onClear={() => setSelectedCategoryIds([])}
            />
          </FormField>
          <FormField label="Author" htmlFor="author"><Input id="author" value={authorName} onChange={(e) => setAuthorName(e.target.value)} /></FormField>
          <FormField label="License" htmlFor="lic"><Input id="lic" value={license} onChange={(e) => setLicense(e.target.value)} /></FormField>
          <FormField label="Website" htmlFor="web"><Input id="web" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} /></FormField>
          <FormField label="Source code" htmlFor="src"><Input id="src" type="url" value={sourceCode} onChange={(e) => setSourceCode(e.target.value)} /></FormField>
          <FormField label="Issue tracker" htmlFor="issue" className="md:col-span-2">
            <Input id="issue" type="url" value={issueTracker} onChange={(e) => setIssueTracker(e.target.value)} />
          </FormField>
          <FormField label="Author email" htmlFor="aemail">
            <Input id="aemail" type="email" value={authorEmail} onChange={(e) => setAuthorEmail(e.target.value)} />
          </FormField>
          <FormField label="Translation URL" htmlFor="trans">
            <Input id="trans" type="url" placeholder="https://weblate.example.org/…" value={translation} onChange={(e) => setTranslation(e.target.value)} />
          </FormField>
          <FormField label="Donate URL" htmlFor="don">
            <Input id="don" type="url" value={donate} onChange={(e) => setDonate(e.target.value)} />
          </FormField>
          <FormField label="Liberapay" htmlFor="lib">
            <Input id="lib" type="url" placeholder="https://liberapay.com/you" value={liberapay} onChange={(e) => setLiberapay(e.target.value)} />
          </FormField>
          <FormField label="Open Collective" htmlFor="oc">
            <Input id="oc" type="url" placeholder="https://opencollective.com/you" value={openCollective} onChange={(e) => setOpenCollective(e.target.value)} />
          </FormField>
          <FormField label="Bitcoin" htmlFor="btc">
            <Input id="btc" placeholder="bc1q… or bitcoin:bc1q…" value={bitcoin} onChange={(e) => setBitcoin(e.target.value)} />
          </FormField>
          <div className="md:col-span-2 flex justify-end">
            <Button type="submit" variant="filled" size="lg" disabled={saving}>
              {saving ? "Saving…" : "Save listing"}
            </Button>
          </div>
        </form>

        {app.locked_signer_sha256 && (
          <div className="mt-6 rounded-2xl border border-outline-soft bg-surface-2/50 p-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-pill bg-surface text-ink-soft">
                <ShieldAlert className="h-3.5 w-3.5" strokeWidth={2.2} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-ink">Signing certificate locked</div>
                <p className="mt-0.5 text-xs text-ink-mute">
                  Subsequent APK uploads must be signed with this exact certificate.
                  Anything else is rejected before it can replace the package.
                </p>
                <code className="mt-2 block select-all break-all rounded-xl border border-outline-soft bg-surface px-3 py-2 font-mono text-[11px] text-ink-soft">
                  SHA-256 {app.locked_signer_sha256}
                </code>
              </div>
            </div>
          </div>
        )}
      </Section>

      {/* ──── Icon ──── */}
      <Section step="02" title="Cover art" subtitle="Auto-extracted from the latest APK. Upload a custom one to lock it.">
        <div className="flex flex-wrap items-center gap-5">
          <AppIcon iconPath={app.icon_path} name={app.name} size={96} version={app.updated_at} className="shadow-e2" />
          <div className="flex-1 space-y-2">
            <Badge variant={app.icon_is_custom ? "primary" : "outline"}>
              {app.icon_is_custom ? "custom" : "auto-extracted"}
            </Badge>
            {app.icon_path && (
              <div className="font-mono text-[11px] text-ink-mute">{app.icon_path}</div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex">
                <span className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-pill bg-primary-container px-4 text-sm font-semibold text-primary-on-container hover:brightness-[1.04]">
                  <ImagePlus className="h-4 w-4" /> Upload custom
                </span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadCustomIcon(f); e.target.value = ""; }}
                  className="sr-only"
                />
              </label>
              {app.icon_is_custom && (
                <Button type="button" variant="outlined" size="md" onClick={revertIcon}>
                  <RotateCcw className="h-4 w-4" /> Revert to auto
                </Button>
              )}
            </div>
          </div>
        </div>
      </Section>

      {/* ──── Banners ──── */}
      <Section
        step="2b"
        title="Banners"
        subtitle="Optional promotional graphics. F-Droid clients pick the right one per surface — feature on phones, TV banner on Android TV, promo as a tablet tile."
      >
        <div className="grid gap-4 md:grid-cols-3">
          <BannerSlot
            label="Featured"
            hint="1024 × 500 — shown above the description on phones."
            aspect="aspect-[1024/500]"
            url={mediaUrl(app.feature_graphic_path) || null}
            onUpload={uploadFeatureGraphic}
            onClear={clearFeatureGraphic}
          />
          <BannerSlot
            label="Promo"
            hint="320 × 180 — tablet & sidebar promo tile."
            aspect="aspect-[320/180]"
            url={mediaUrl(app.promo_graphic_path) || null}
            onUpload={uploadPromoGraphic}
            onClear={clearPromoGraphic}
          />
          <BannerSlot
            label="TV banner"
            hint="1280 × 720 — Android TV launcher card."
            aspect="aspect-video"
            url={mediaUrl(app.tv_banner_path) || null}
            onUpload={uploadTvBanner}
            onClear={clearTvBanner}
          />
        </div>
      </Section>

      {/* ──── Screenshots ──── */}
      <Section
        step="03"
        title="Screenshots"
        subtitle={
          screenshots.length > 1
            ? "PNG / JPEG / WebP, resized to 1080×1920 max. Drag tiles to reorder."
            : "PNG / JPEG / WebP, resized to 1080×1920 max."
        }
      >
        <label className="inline-flex">
          <span className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-pill bg-primary-container px-4 text-sm font-semibold text-primary-on-container hover:brightness-[1.04]">
            <ImagePlus className="h-4 w-4" /> Add screenshots
          </span>
          <input
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => { uploadScreenshots(e.target.files); e.target.value = ""; }}
            className="sr-only"
          />
        </label>
        {screenshots.length === 0 ? (
          <p className="mt-4 text-sm italic text-ink-mute">No screenshots yet.</p>
        ) : (
          <DndContext
            sensors={dndSensors}
            collisionDetection={closestCenter}
            onDragEnd={onScreenshotDragEnd}
          >
            <SortableContext
              items={screenshots.map((s) => s.id)}
              strategy={rectSortingStrategy}
            >
              <div className={cn("mt-4 flex flex-wrap gap-3", reorderingScreenshots && "opacity-90")}>
                {screenshots.map((s, i) => (
                  <SortableScreenshot
                    key={s.id}
                    screenshot={s}
                    index={i}
                    onDelete={deleteScreenshot}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </Section>

      {/* ──── Translations ──── */}
      <Section
        step="04"
        title="Translations"
        subtitle="Per-locale overrides of the listing fields. F-Droid clients pick the closest match for the user's device locale."
      >
        <LocalizationsEditor
          appId={app.id}
          localizations={app.localizations}
          onSaved={load}
        />
      </Section>

      {/* ──── Permissions ──── */}
      {latest && (
        <Section step="05" title="Permissions" subtitle={`Declared by v${latest.version_name} (${latest.version_code})`}>
          <AppPermissions permissions={latest.permissions} />
        </Section>
      )}

      {/* ──── Versions ──── */}
      <Section
        step="06"
        title="Versions"
        subtitle={
          app.suggested_version_is_manual
            ? `Upload a new APK to publish a new version. The signer must match. Suggested version is pinned — uploads no longer auto-bump it.`
            : `Upload a new APK to publish a new version. The signer must match. The latest published version is auto-suggested to F-Droid clients.`
        }
      >
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <label className="inline-flex">
            <span className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-pill bg-primary px-4 text-sm font-semibold text-primary-fg shadow-e1 hover:brightness-[1.04]">
              <Upload className="h-4 w-4" /> Upload new version
            </span>
            <input
              type="file"
              accept=".apk,application/vnd.android.package-archive"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadVersion(f); e.target.value = ""; }}
              disabled={uploading}
              className="sr-only"
            />
          </label>
          {uploading && (
            <span className="text-sm text-ink-soft">Uploading…</span>
          )}
          {app.suggested_version_is_manual && (
            <Button
              type="button"
              variant="outlined"
              size="sm"
              onClick={resetSuggestedVersion}
              className="ml-auto"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Auto-suggest latest
            </Button>
          )}
        </div>

        <ul className="space-y-2">
          {app.apks.length === 0 ? (
            <li className="rounded-xl border border-dashed border-outline px-4 py-10 text-center italic text-ink-mute">
              No versions yet.
            </li>
          ) : (
            app.apks.map((apk) => {
              const isEditing = editingChangelog?.apkId === apk.id;
              const isSuggested = apk.version_code === app.suggested_version_code;
              const canPin = apk.status === "published" && !isSuggested;
              return (
                <Fragment key={apk.id}>
                  <li
                    className={cn(
                      "surface flex flex-wrap items-center gap-3 p-4 transition-shadow",
                      isSuggested && "ring-2 ring-primary",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-base font-semibold text-ink">v{apk.version_name}</span>
                        <Badge variant={apk.status === "published" ? "primary" : "soft"}>
                          {apk.status.replace("_", " ")}
                        </Badge>
                        {isSuggested && (
                          <Badge variant="accent" className="font-mono uppercase tracking-wider">
                            {app.suggested_version_is_manual ? "pinned" : "suggested"}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-ink-mute">
                        Code {apk.version_code} · {formatBytes(apk.size_bytes)} · SDK {apk.min_sdk ?? "?"}–{apk.target_sdk ?? "?"}
                      </div>
                      {(() => {
                        const preview = pickLocalizedText(apk.whats_new);
                        const locales = apk.whats_new ? Object.keys(apk.whats_new) : [];
                        if (!preview) {
                          return (
                            <p className="mt-1 text-xs italic text-ink-mute">No changelog</p>
                          );
                        }
                        return (
                          <p
                            title={preview.text}
                            className="mt-1 max-w-md truncate text-xs text-ink-soft"
                          >
                            ★ <span className="font-mono text-[10px] text-ink-mute">{preview.locale}</span>{" "}
                            {preview.text}
                            {locales.length > 1 && (
                              <span className="ml-1 text-ink-mute">
                                (+{locales.length - 1} more)
                              </span>
                            )}
                          </p>
                        );
                      })()}
                      <AntiFeatureChips
                        apk={apk}
                        disabled={savingApkId === apk.id}
                        onToggle={(flag) => toggleApkAntiFeature(apk, flag)}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {canPin && (
                        <Button
                          size="sm"
                          variant="text"
                          onClick={() => pinSuggestedVersion(apk.version_code)}
                          title="Make this the version F-Droid clients recommend"
                        >
                          Suggest this
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outlined"
                        onClick={() => {
                          if (isEditing) {
                            setEditingChangelog(null);
                            return;
                          }
                          // Hydrate the draft from the server-side dict (an
                          // empty bag gives us a single en-US tab to start).
                          const initial: Record<string, string> = {};
                          if (apk.whats_new) {
                            for (const [l, t] of Object.entries(apk.whats_new)) {
                              if (t) initial[l] = t;
                            }
                          }
                          if (Object.keys(initial).length === 0) initial["en-US"] = "";
                          const firstLocale = Object.keys(initial)[0];
                          setEditingChangelog({
                            apkId: apk.id,
                            entries: initial,
                            activeLocale: firstLocale,
                          });
                        }}
                      >
                        {isEditing ? "Close" : apk.whats_new ? "Edit notes" : "Add notes"}
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => deleteApk(apk)}>
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </Button>
                    </div>
                  </li>
                  {isEditing && editingChangelog && (
                    <li className="rounded-2xl bg-surface-2 p-4">
                      <ChangelogEditor
                        version={`v${apk.version_name} (${apk.version_code})`}
                        draft={editingChangelog}
                        onChange={setEditingChangelog}
                      />
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button size="md" variant="filled" onClick={saveChangelog} disabled={savingChangelog}>
                          {savingChangelog ? "Saving…" : "Save"}
                        </Button>
                        <Button size="md" variant="ghost" onClick={() => setEditingChangelog(null)}>Cancel</Button>
                        {apk.whats_new && Object.keys(apk.whats_new).length > 0 && (
                          <Button size="md" variant="text" className="ml-auto text-danger" onClick={() => clearChangelog(apk.id)}>
                            Clear all locales
                          </Button>
                        )}
                      </div>
                    </li>
                  )}
                </Fragment>
              );
            })
          )}
        </ul>
      </Section>

      {/* ──── Danger zone ──── */}
      <section className="rounded-3xl border-2 border-danger/40 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold tracking-tight text-danger">Danger zone</h2>
            <p className="text-sm text-ink-soft">Deletes the app and all of its versions, icons and screenshots.</p>
          </div>
          <Button variant="danger" onClick={deleteApp}>
            <Trash2 className="h-4 w-4" /> Delete release
          </Button>
        </div>
      </section>
    </div>
  );
}

function Section({
  step,
  title,
  subtitle,
  children,
}: {
  step: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="surface p-6">
      <header className="mb-5 flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-pill bg-primary-container font-mono text-sm font-bold text-primary-on-container">
          {step}
        </span>
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink">{title}</h2>
          {subtitle && <p className="text-sm text-ink-mute">{subtitle}</p>}
        </div>
      </header>
      {children}
    </section>
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
      <Label htmlFor={htmlFor} className="text-sm font-medium text-ink-soft">{label}</Label>
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <div className="h-6 w-6 animate-spin rounded-full border-2 border-outline-soft border-t-primary" role="status" aria-label="Loading" />
  );
}

/* Multi-locale release notes editor. Each known locale is a clickable pill;
 * the active pill swaps the textarea body. An "+ Add language" pill opens a
 * compact picker (common locales not already on this APK, plus a free-text
 * BCP47 fallback). Removing a locale just drops it from the local entries
 * map — the parent's save flow trims blanks and PATCHes the resulting
 * dict, so removing here + saving deletes the locale server-side. */
type ChangelogDraft = {
  apkId: string;
  entries: Record<string, string>;
  activeLocale: string;
};

function ChangelogEditor({
  version,
  draft,
  onChange,
}: {
  version: string;
  draft: ChangelogDraft;
  onChange: (next: ChangelogDraft) => void;
}) {
  const [picker, setPicker] = useState(false);
  const [custom, setCustom] = useState("");
  const locales = Object.keys(draft.entries);

  function patch(entries: Record<string, string>, activeLocale?: string) {
    onChange({
      apkId: draft.apkId,
      entries,
      activeLocale: activeLocale ?? draft.activeLocale,
    });
  }

  function addLocale(code: string) {
    if (!code || draft.entries[code] !== undefined) return;
    patch({ ...draft.entries, [code]: "" }, code);
    setPicker(false);
    setCustom("");
  }

  function removeLocale(code: string) {
    const { [code]: _drop, ...rest } = draft.entries;
    const nextActive = rest[draft.activeLocale] !== undefined
      ? draft.activeLocale
      : Object.keys(rest)[0] ?? "en-US";
    if (Object.keys(rest).length === 0) {
      // Never let the user leave an empty editor with zero locales; reset
      // to a single en-US tab so the next save can either populate it or
      // explicitly clear (Save with a blank textarea clears).
      patch({ "en-US": "" }, "en-US");
      return;
    }
    patch(rest, nextActive);
  }

  const available = COMMON_LOCALES.filter((l) => draft.entries[l.code] === undefined);

  return (
    <div>
      <Label className="text-xs font-medium text-ink-soft">
        Release notes for {version}
      </Label>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {locales.map((code) => {
          const active = code === draft.activeLocale;
          const lbl = localeLabel(code);
          return (
            <span key={code} className="inline-flex items-center">
              <button
                type="button"
                onClick={() => patch(draft.entries, code)}
                aria-pressed={active}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-l-pill border px-3 py-1 text-xs font-medium transition-colors",
                  active
                    ? "border-primary bg-primary text-primary-fg"
                    : "border-outline-soft bg-surface text-ink-soft hover:border-outline hover:bg-surface-2 hover:text-ink",
                )}
                title={lbl.label}
              >
                <span className="font-mono text-[10px]">{code}</span>
                {draft.entries[code]?.trim() && <span className="opacity-70">●</span>}
              </button>
              <button
                type="button"
                onClick={() => removeLocale(code)}
                aria-label={`Remove ${lbl.label}`}
                className={cn(
                  "inline-flex h-[22px] items-center justify-center rounded-r-pill border border-l-0 px-1.5 transition-colors",
                  active
                    ? "border-primary bg-primary text-primary-fg/80 hover:text-primary-fg"
                    : "border-outline-soft bg-surface text-ink-mute hover:border-danger hover:bg-danger-container hover:text-danger-on-container",
                )}
              >
                <X className="h-3 w-3" strokeWidth={2.6} />
              </button>
            </span>
          );
        })}

        <div className="relative">
          <button
            type="button"
            onClick={() => setPicker((o) => !o)}
            className="inline-flex items-center gap-1 rounded-pill border border-dashed border-outline px-3 py-1 text-xs font-medium text-ink-soft transition-colors hover:border-primary hover:text-primary"
          >
            <Plus className="h-3 w-3" strokeWidth={2.6} /> Add language
          </button>
          {picker && (
            <div className="absolute left-0 top-9 z-20 w-72 rounded-2xl border border-outline-soft bg-surface p-3 shadow-e3">
              <div className="mb-1 px-1 text-[10px] uppercase tracking-wider text-ink-mute">
                Pick a locale
              </div>
              <div className="max-h-56 space-y-0.5 overflow-y-auto">
                {available.length === 0 ? (
                  <p className="px-2 py-2 text-xs italic text-ink-mute">
                    Every common locale is already covered.
                  </p>
                ) : (
                  available.map((l) => (
                    <button
                      key={l.code}
                      type="button"
                      onClick={() => addLocale(l.code)}
                      className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2"
                    >
                      <span className="truncate font-medium text-ink">{l.label}</span>
                      <span className="font-mono text-[10px] text-ink-mute">{l.code}</span>
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
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                    className="h-9"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outlined"
                    onClick={() => addLocale(custom.trim())}
                    disabled={!custom.trim()}
                  >
                    Add
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <textarea
        rows={5}
        value={draft.entries[draft.activeLocale] ?? ""}
        onChange={(e) =>
          patch({ ...draft.entries, [draft.activeLocale]: e.target.value })
        }
        className="mt-3 w-full rounded-xl border border-outline bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
        placeholder={`• What changed in ${localeLabel(draft.activeLocale).label}…`}
      />
      <p className="mt-1 text-[10px] text-ink-mute">
        Each locale is independent. Empty tabs are dropped on save — they
        won't ship to the F-Droid client.
      </p>
    </div>
  );
}

/* One panel inside the Banners section. Renders the current asset (or a
 * dashed placeholder), an upload button, and a Remove button when one is
 * already set. Aspect ratio is forced so the preview always matches the
 * shape the F-Droid client expects, even if the source was off-ratio. */
function BannerSlot({
  label,
  hint,
  aspect,
  url,
  onUpload,
  onClear,
}: {
  label: string;
  hint: string;
  aspect: string;
  url: string | null;
  onUpload: (file: File) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-ink">{label}</span>
        {url && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1 text-xs text-ink-mute transition-colors hover:text-danger"
          >
            <Trash2 className="h-3 w-3" /> remove
          </button>
        )}
      </div>
      <label
        className={cn(
          "group relative block overflow-hidden rounded-2xl border bg-surface-2 transition-colors",
          aspect,
          url
            ? "border-outline-soft shadow-e1 cursor-pointer"
            : "border-dashed border-outline cursor-pointer hover:border-primary hover:bg-primary-container/30",
        )}
      >
        {url ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={`${label} banner`}
              className="h-full w-full object-cover"
            />
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55 text-xs font-semibold uppercase tracking-wider text-white opacity-0 transition-opacity group-hover:opacity-100">
              Replace
            </span>
          </>
        ) : (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-ink-mute">
            <ImagePlus className="h-5 w-5" strokeWidth={2} />
            <span className="text-[11px] font-medium">Upload {label.toLowerCase()}</span>
          </span>
        )}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
            e.target.value = "";
          }}
          className="sr-only"
        />
      </label>
      <p className="text-[11px] text-ink-mute">{hint}</p>
    </div>
  );
}

/* A single screenshot tile inside the sortable grid. The tile itself acts as
 * the drag handle (via the dedicated grab affordance pinned to its top-left
 * — keeps drag intent obvious and stops a wandering pointer from triggering
 * a reorder on the X button). A small ordinal in the bottom-left hints the
 * current position and gives screen readers something to anchor onto. */
function SortableScreenshot({
  screenshot,
  index,
  onDelete,
}: {
  screenshot: Screenshot;
  index: number;
  onDelete: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: screenshot.id });

  const url = mediaUrl(screenshot.storage_key);
  if (!url) return null;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        "group relative overflow-hidden rounded-xl border border-outline-soft bg-surface-2",
        isDragging
          ? "z-10 cursor-grabbing shadow-e3 ring-2 ring-primary"
          : "shadow-e1 transition-shadow hover:shadow-e2",
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={`Screenshot ${index + 1}`}
        className="h-44 w-auto select-none object-contain"
        draggable={false}
      />
      <button
        type="button"
        aria-label={`Drag screenshot ${index + 1}`}
        {...attributes}
        {...listeners}
        className={cn(
          "absolute left-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-pill bg-surface/85 text-ink-soft backdrop-blur",
          "cursor-grab opacity-0 transition-opacity group-hover:opacity-100",
          "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30",
          isDragging && "cursor-grabbing opacity-100",
        )}
      >
        <GripVertical className="h-3.5 w-3.5" strokeWidth={2.4} />
      </button>
      <span className="absolute bottom-1.5 left-1.5 flex h-6 min-w-[1.5rem] items-center justify-center rounded-pill bg-surface/85 px-2 font-mono text-[10px] font-semibold text-ink-soft backdrop-blur">
        {index + 1}
      </span>
      <button
        type="button"
        onClick={() => onDelete(screenshot.id)}
        aria-label="Delete screenshot"
        className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-pill bg-danger text-danger-fg opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-danger/30"
      >
        <X className="h-3.5 w-3.5" strokeWidth={2.6} />
      </button>
    </div>
  );
}

/* Two-track category picker: top row shows what's currently on the app
 * (chip-pills with an X), bottom row shows the rest of the taxonomy as
 * outlined chips. Splitting the two states stops the chip cloud from
 * becoming a "where is what again?" puzzle when the list grows past a
 * dozen entries. */
function CategoryPicker({
  available,
  selectedIds,
  onToggle,
  onClear,
}: {
  available: Category[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  onClear: () => void;
}) {
  if (available.length === 0) {
    return <p className="text-xs italic text-ink-mute">Loading…</p>;
  }
  const selected = available.filter((c) => selectedIds.includes(c.id));
  const rest = available.filter((c) => !selectedIds.includes(c.id));

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-outline-soft bg-surface-2/40 p-3">
        <div className="mb-2 flex items-center justify-between gap-2 text-[11px] uppercase tracking-wider text-ink-mute">
          <span>
            On this app · <span className="font-mono normal-case text-ink-soft">{selected.length}</span>
          </span>
          {selected.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="font-mono text-[10px] text-ink-mute hover:text-danger"
            >
              clear all
            </button>
          )}
        </div>
        {selected.length === 0 ? (
          <p className="px-1 py-2 text-xs italic text-ink-mute">
            Nothing selected. Pick one or more below — F-Droid clients use
            this to group your app in their catalogue.
          </p>
        ) : (
          <ul role="group" aria-label="Selected categories" className="flex flex-wrap gap-1.5">
            {selected.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onToggle(c.id)}
                  className="group inline-flex items-center gap-1.5 rounded-pill bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg shadow-e1 transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30"
                  aria-label={`Remove ${c.name}`}
                >
                  {c.name}
                  <X className="h-3 w-3 opacity-75 transition-opacity group-hover:opacity-100" strokeWidth={2.6} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="mb-2 px-1 text-[11px] uppercase tracking-wider text-ink-mute">
          Available · <span className="font-mono normal-case text-ink-soft">{rest.length}</span>
        </div>
        {rest.length === 0 ? (
          <p className="px-1 py-2 text-xs italic text-ink-mute">
            All available categories are already selected.
          </p>
        ) : (
          <ul role="group" aria-label="Available categories" className="flex flex-wrap gap-1.5">
            {rest.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onToggle(c.id)}
                  className="inline-flex items-center gap-1.5 rounded-pill border border-outline-soft bg-surface px-3 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-primary hover:bg-primary-container hover:text-primary-on-container focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30"
                  aria-label={`Add ${c.name}`}
                >
                  <Plus className="h-3 w-3 opacity-70" strokeWidth={2.6} />
                  {c.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// The set the F-Droid client recognises and renders as warning badges. Order
// roughly matches how upstream metadata lists them, with the security/privacy
// ones first.
const KNOWN_ANTI_FEATURES = [
  "Tracking",
  "NonFreeNet",
  "NonFreeAdd",
  "KnownVuln",
  "NoSourceSince",
  "NonFreeAssets",
  "NonFreeDep",
  "UpstreamNonFree",
  "DisabledAlgorithm",
  "NSFW",
] as const;

function AntiFeatureChips({
  apk,
  disabled,
  onToggle,
}: {
  apk: Apk;
  disabled: boolean;
  onToggle: (flag: string) => void;
}) {
  const active = new Set(apk.anti_features || []);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <ShieldAlert className="h-3.5 w-3.5 text-ink-mute" />
      <span className="mr-1 text-[10px] uppercase tracking-wider text-ink-mute">
        Anti-features
      </span>
      {KNOWN_ANTI_FEATURES.map((flag) => {
        const on = active.has(flag);
        return (
          <button
            key={flag}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(flag)}
            className={cn(
              "rounded-pill border px-2 py-0.5 text-[10px] font-semibold transition-colors",
              on
                ? "border-accent bg-accent-container text-accent-on-container"
                : "border-outline-soft bg-surface text-ink-mute hover:border-outline hover:text-ink",
              disabled && "opacity-50",
            )}
          >
            {flag}
          </button>
        );
      })}
    </div>
  );
}

export default function ManageAppClient() {
  return (
    <AuthGuard>
      <ManageAppInner />
    </AuthGuard>
  );
}
