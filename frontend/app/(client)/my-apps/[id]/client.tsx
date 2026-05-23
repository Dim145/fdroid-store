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
import { ArrowLeft, Bug, CheckCircle2, Download, Eye, GripVertical, ImagePlus, Loader2, Plus, RotateCcw, ShieldAlert, ShieldCheck, Trash2, Upload, X, XCircle } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { AppIcon } from "@/components/app-icon";
import { AppPermissions } from "@/components/app-permissions";
import { AuthGuard } from "@/components/auth-guard";
import { CollaboratorsSection } from "@/components/collaborators-section";
import { DeployTokensSection } from "@/components/deploy-tokens-section";
import { GithubSourceSection } from "@/components/github-source-section";
import { ProxySourcesSection } from "@/components/proxy-sources-section";
import { LocalizationsEditor } from "@/components/localizations-editor";
import { MarkdownEditor } from "@/components/markdown/markdown-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet } from "@/components/ui/sheet";
import { api, mediaUrl, type Apk, type AppDetail, type Category, type CveSeverity, type ReproducibilityStatus, type SbomRead, type Screenshot } from "@/lib/api";
import { COMMON_LOCALES, localeLabel } from "@/lib/locales";
import { useAuth } from "@/lib/auth-store";
import { useRepoInfo } from "@/lib/repo-store";
import { toast } from "@/lib/toast-store";
import { cn, formatBytes, formatDate, pickLocalizedText } from "@/lib/utils";

/** Per-file upload tracker for the multi-screenshot upload flow. One
 *  entry exists from the moment a file enters the queue until ~900 ms
 *  after the entire batch finishes — that linger time lets the user see
 *  the success badge land before the placeholder swaps out for the
 *  persisted tile. */
type PendingShot = {
  tempId: string;
  name: string;
  status: "queued" | "uploading" | "done" | "error";
  screenshot?: Screenshot;
  error?: string;
};

function ManageAppInner() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();
  // Admin master switch for the Reproducible Builds feature. Comes from
  // the public /setup/status hydrate — when off we hide the per-APK
  // editor below; the backend mirrors the gate by returning 403 if a
  // client somehow manages to POST anyway.
  const repo = useRepoInfo();
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
  // Per-file upload progress for screenshots. Each entry is a "tile slot"
  // that renders inline next to the persisted screenshots: a spinner
  // while uploading, the real image once the API call resolves, an
  // error chip if the upload failed. Cleared a moment after ``load()``
  // syncs the persisted shots back into ``screenshots`` so the UI never
  // shows the same image twice.
  const [pendingShots, setPendingShots] = useState<PendingShot[]>([]);
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

  // Drives the editorial sidebar — the rail highlights whichever section
  // is currently dominating the viewport, click-scroll falls back to a
  // smooth jump for keyboard users, and the active section is mirrored
  // into ``location.hash`` so a refresh (or a deep-link from a "Continue
  // editing" toast) restores the user's scroll position.
  const [activeSection, setActiveSection] = useState<string>("listing");

  // Suppress observer-driven hash updates while a programmatic smooth
  // scroll is in flight. Without this, clicking "Versions" briefly shows
  // ``#fiche`` → ``#captures`` → ``#versions`` in the URL bar as the
  // intermediate sections cross the live band — distracting and noisy
  // in the browser history (even with replaceState the visual flicker
  // is unpleasant). 800 ms covers the smooth scroll on this page; after
  // the lock expires the observer takes over normally.
  const programmaticScrollRef = useRef<number>(0);

  // Helper kept inline because it's used by both the click path and the
  // initial-hash effect. ``smooth`` is on for clicks (user-driven) and
  // off for the mount effect (we want to land at the section without an
  // animated scroll-from-top on a fresh page load).
  const writeHashRef = useRef<(key: string) => void>(() => {});
  writeHashRef.current = (key: string) => {
    const desired = `#${key}`;
    if (typeof window !== "undefined" && window.location.hash !== desired) {
      window.history.replaceState(null, "", desired);
    }
  };

  useEffect(() => {
    if (!app) return;
    const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-section]"));
    if (nodes.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the entry closest to the top edge of our "live band".
        // rootMargin shrinks the viewport so only the middle third
        // counts as "in view" — prevents jitter when two sections share
        // the screen.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target) {
          const key = (visible[0].target as HTMLElement).dataset.section;
          if (!key) return;
          setActiveSection(key);
          // Only sync the URL when we're not in the middle of a click-
          // driven smooth scroll. See ``programmaticScrollRef`` above.
          if (Date.now() - programmaticScrollRef.current > 800) {
            writeHashRef.current(key);
          }
        }
      },
      { rootMargin: "-30% 0px -55% 0px", threshold: 0 },
    );
    for (const n of nodes) observer.observe(n);
    return () => observer.disconnect();
  }, [app?.id]);

  // On first load (or when the user pastes a deep-link URL), jump to
  // whichever section the hash names. Runs after ``app`` resolves so
  // the section nodes are actually in the DOM.
  //
  // The page above the target is image-heavy (screenshots grid, banner
  // thumbs, app icon) and the images load async — so the target section
  // keeps shifting downward in the seconds after the initial paint.
  // ResizeObserver isn't reliable here because most thumbnails use
  // fixed-size containers, so their parent sections never actually
  // resize when the image bytes arrive. We poll every 50 ms for up to
  // 1.5 s instead: re-scrolling if the target's absolute position has
  // moved since the last tick, stopping early once we've had three
  // consecutive ticks at a stable position.
  useEffect(() => {
    if (!app) return;
    if (typeof window === "undefined") return;
    const hash = window.location.hash.replace(/^#/, "");
    if (!/^[a-z][a-z0-9_-]*$/i.test(hash)) return;
    const el = document.querySelector<HTMLElement>(
      `[data-section="${hash}"]`,
    );
    if (!el) return;
    setActiveSection(hash);

    let lastTop = -1;
    let stable = 0;
    const deadline = Date.now() + 1500;
    const tick = () => {
      const rect = el.getBoundingClientRect();
      const absTop = rect.top + window.scrollY;
      if (absTop !== lastTop) {
        // Target moved (images loading above, or first run). Realign
        // and bump the observer suppression window so the rail's URL
        // mirror doesn't briefly latch onto an intermediate section.
        window.scrollTo({ top: absTop - 80, behavior: "auto" });
        programmaticScrollRef.current = Date.now();
        lastTop = absTop;
        stable = 0;
      } else {
        stable += 1;
      }
      // Three consecutive stable ticks (~150 ms) means images above
      // the target have settled — stop polling.
      if (stable >= 3 || Date.now() > deadline) {
        window.clearInterval(intervalId);
      }
    };
    const intervalId = window.setInterval(tick, 50);
    tick(); // run once immediately so the first paint already starts in the right place

    return () => window.clearInterval(intervalId);
  }, [app?.id]);

  function scrollToSection(key: string) {
    const el = document.querySelector<HTMLElement>(`[data-section="${key}"]`);
    if (el) {
      // Account for the sticky site header (~64px) so the section title
      // lands just below it rather than under it.
      const top = el.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({ top, behavior: "smooth" });
      setActiveSection(key);
      writeHashRef.current(key);
      programmaticScrollRef.current = Date.now();
    }
  }

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
      setError(e instanceof Error ? e.message : t("myApps.edit.loadFailed"));
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
      toast.success(t("myApps.edit.saved"));
      await load();
    } catch (e) {
      toast.error(t("myApps.edit.saveFailed"), e instanceof Error ? e.message : undefined);
    } finally { setSaving(false); }
  }
  async function uploadVersion(file: File) {
    if (!app) return;
    setUploading(true);
    try {
      // Inspect first — it stages the file under ``staging/<sha>.apk``
      // and returns a token. If staging succeeded, the follow-up
      // promotion is a tiny JSON post; otherwise we fall back to a
      // second multipart upload (network-rare case, S3 down, etc.).
      const info = await api.apps.inspectApk(file);
      if (info.staging_token) {
        await api.apps.uploadApkStaged(app.id, info.staging_token);
      } else {
        await api.apps.uploadApk(app.id, file);
      }
      toast.success(t("myApps.edit.versions.uploaded"));
      await load();
    } catch (e) {
      toast.error(t("myApps.edit.versions.uploadFailed"), e instanceof Error ? e.message : undefined);
    } finally { setUploading(false); }
  }
  async function deleteApk(apk: Apk) {
    if (!confirm(t("myApps.edit.versions.deleteConfirm", { name: apk.version_name, code: apk.version_code }))) return;
    try { await api.apps.deleteApk(apk.id); toast.success(t("myApps.edit.versions.deleted")); await load(); }
    catch (e) { toast.error(t("myApps.edit.versions.deleteFailed"), e instanceof Error ? e.message : undefined); }
  }
  async function deleteApp() {
    if (!app) return;
    if (!confirm(t("myApps.edit.deleteAppConfirm", { name: app.name }))) return;
    try { await api.apps.remove(app.id); router.replace("/my-apps"); }
    catch (e) { toast.error(t("myApps.edit.deleteAppFailed"), e instanceof Error ? e.message : undefined); }
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
      toast.success(t("myApps.edit.versions.changelogSaved"));
      setEditingChangelog(null);
      await load();
    } catch (e) {
      toast.error(t("myApps.edit.versions.changelogSaveFailed"), e instanceof Error ? e.message : undefined);
    } finally { setSavingChangelog(false); }
  }
  async function clearChangelog(apkId: string) {
    setSavingChangelog(true);
    try {
      await api.apps.updateApk(apkId, { whats_new: null });
      toast.success(t("myApps.edit.versions.changelogCleared"));
      setEditingChangelog(null);
      await load();
    } catch (e) {
      toast.error(t("myApps.edit.versions.changelogClearFailed"), e instanceof Error ? e.message : undefined);
    } finally { setSavingChangelog(false); }
  }
  async function uploadCustomIcon(file: File) {
    if (!app) return;
    try { await api.apps.uploadIcon(app.id, file); toast.success(t("myApps.edit.iconUploaded")); await load(); }
    catch (e) { toast.error(t("myApps.edit.iconUploadFailed"), e instanceof Error ? e.message : undefined); }
  }
  async function uploadFeatureGraphic(file: File) {
    if (!app) return;
    try { await api.apps.uploadFeatureGraphic(app.id, file); toast.success(t("myApps.edit.banner.uploaded", { name: t("myApps.edit.banner.featured") })); await load(); }
    catch (e) { toast.error(t("myApps.edit.banner.uploadFailed"), e instanceof Error ? e.message : undefined); }
  }
  async function clearFeatureGraphic() {
    if (!app) return;
    if (!confirm(t("myApps.edit.banner.removeConfirm", { name: t("myApps.edit.banner.featured").toLowerCase() }))) return;
    try { await api.apps.deleteFeatureGraphic(app.id); toast.success(t("myApps.edit.banner.removed", { name: t("myApps.edit.banner.featured") })); await load(); }
    catch (e) { toast.error(t("myApps.edit.banner.deleteFailed"), e instanceof Error ? e.message : undefined); }
  }
  async function uploadPromoGraphic(file: File) {
    if (!app) return;
    try { await api.apps.uploadPromoGraphic(app.id, file); toast.success(t("myApps.edit.banner.uploaded", { name: t("myApps.edit.banner.promo") })); await load(); }
    catch (e) { toast.error(t("myApps.edit.banner.uploadFailed"), e instanceof Error ? e.message : undefined); }
  }
  async function clearPromoGraphic() {
    if (!app) return;
    if (!confirm(t("myApps.edit.banner.removeConfirm", { name: t("myApps.edit.banner.promo").toLowerCase() }))) return;
    try { await api.apps.deletePromoGraphic(app.id); toast.success(t("myApps.edit.banner.removed", { name: t("myApps.edit.banner.promo") })); await load(); }
    catch (e) { toast.error(t("myApps.edit.banner.deleteFailed"), e instanceof Error ? e.message : undefined); }
  }
  async function uploadTvBanner(file: File) {
    if (!app) return;
    try { await api.apps.uploadTvBanner(app.id, file); toast.success(t("myApps.edit.banner.uploaded", { name: t("myApps.edit.banner.tv") })); await load(); }
    catch (e) { toast.error(t("myApps.edit.banner.uploadFailed"), e instanceof Error ? e.message : undefined); }
  }
  async function clearTvBanner() {
    if (!app) return;
    if (!confirm(t("myApps.edit.banner.removeConfirm", { name: t("myApps.edit.banner.tv").toLowerCase() }))) return;
    try { await api.apps.deleteTvBanner(app.id); toast.success(t("myApps.edit.banner.removed", { name: t("myApps.edit.banner.tv") })); await load(); }
    catch (e) { toast.error(t("myApps.edit.banner.deleteFailed"), e instanceof Error ? e.message : undefined); }
  }
  async function pinSuggestedVersion(versionCode: number) {
    if (!app) return;
    try {
      await api.apps.update(app.id, { suggested_version_code: versionCode });
      toast.success(t("myApps.edit.versions.pinned_toast", { code: versionCode }));
      await load();
    } catch (e) {
      toast.error(t("myApps.edit.versions.pinFailed"), e instanceof Error ? e.message : undefined);
    }
  }
  async function resetSuggestedVersion() {
    if (!app) return;
    try {
      // null tells the server to clear the manual pin and revert to
      // auto-tracking the latest published APK.
      await api.apps.update(app.id, { suggested_version_code: null });
      toast.success(t("myApps.edit.versions.reset_toast"));
      await load();
    } catch (e) {
      toast.error(t("myApps.edit.versions.resetFailed"), e instanceof Error ? e.message : undefined);
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
      toast.error(t("myApps.edit.saveFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setSavingApkId(null);
    }
  }
  function updateApkInPlace(updated: Apk) {
    // Local-only merge — the reproducibility endpoints don't touch the
    // F-Droid index so a full reload would be wasteful. We just swap the
    // matching row in the existing app.apks array.
    setApp((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        apks: prev.apks.map((a) => (a.id === updated.id ? updated : a)),
      };
    });
  }
  async function revertIcon() {
    if (!app) return;
    if (!confirm(t("myApps.edit.revertIconConfirm"))) return;
    try { await api.apps.revertIcon(app.id); toast.success(t("myApps.edit.iconReverted")); await load(); }
    catch (e) { toast.error(t("myApps.edit.iconRevertFailed"), e instanceof Error ? e.message : undefined); }
  }
  async function uploadScreenshots(files: FileList | null) {
    if (!app || !files || files.length === 0) return;
    // Upload sequentially, one file per request, so:
    //   1. each upload's completion is observable as a state transition
    //      (the placeholder tile morphs into the real screenshot tile);
    //   2. the section header counter advances 0/N → 1/N → … → N/N
    //      instead of jumping from 0 to N at the very end;
    //   3. a failure on file 3/5 leaves files 1, 2, 4, 5 succeeded —
    //      previously a single multipart upload was atomic-failure.
    // Trade-off: N HTTP round-trips instead of one. For screenshots
    // (small files, low count) the latency cost is negligible.
    const fileList = Array.from(files);
    const queue: PendingShot[] = fileList.map((f, i) => ({
      tempId: `pending-${Date.now()}-${i}-${f.name}`,
      name: f.name,
      status: "queued" as const,
    }));
    setPendingShots(queue);
    let successCount = 0;
    let errorCount = 0;
    for (let i = 0; i < fileList.length; i++) {
      const tempId = queue[i].tempId;
      setPendingShots((prev) =>
        prev.map((p) => (p.tempId === tempId ? { ...p, status: "uploading" } : p)),
      );
      try {
        const res = await api.apps.uploadScreenshots(app.id, [fileList[i]]);
        const screenshot = res[0];
        setPendingShots((prev) =>
          prev.map((p) =>
            p.tempId === tempId ? { ...p, status: "done", screenshot } : p,
          ),
        );
        successCount++;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : "upload failed";
        setPendingShots((prev) =>
          prev.map((p) =>
            p.tempId === tempId ? { ...p, status: "error", error: errMsg } : p,
          ),
        );
        errorCount++;
      }
    }
    // Resync persisted state. Hold the placeholder strip visible for a
    // short beat so the user sees the green/red badges land before the
    // placeholders disappear into the real grid.
    await load();
    window.setTimeout(() => setPendingShots([]), 900);
    if (errorCount === 0) {
      toast.success(t("myApps.edit.screenshots.uploaded", { count: successCount }));
    } else if (successCount > 0) {
      toast.error(
        t("myApps.edit.screenshots.uploadFailed"),
        t("myApps.edit.screenshots.partialUpload", { ok: successCount, failed: errorCount }),
      );
    } else {
      toast.error(t("myApps.edit.screenshots.uploadFailed"));
    }
  }
  async function deleteScreenshot(screenshotId: string) {
    if (!app) return;
    if (!confirm(t("myApps.edit.screenshots.deleteConfirm"))) return;
    try { await api.apps.deleteScreenshot(app.id, screenshotId); await load(); }
    catch (e) { toast.error(t("myApps.edit.screenshots.deleteFailed"), e instanceof Error ? e.message : undefined); }
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
      toast.success(t("myApps.edit.screenshots.reorderSaved"));
    } catch (err) {
      // Revert to the server-known state so the UI doesn't lie.
      setScreenshots(previous);
      toast.error(t("myApps.edit.screenshots.reorderFailed"), err instanceof Error ? err.message : undefined);
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

  // Section roster — drives both the sidebar rail and the section
  // chrome. Order matches the visual flow; "permissions" only renders
  // when a published APK exists so we conditionally drop it. Auto-
  // numbered from the position so we can rearrange without re-hand-
  // numbering the call sites.
  const baseRoster: { id: string; label: string }[] = [
    { id: "listing", label: t("myApps.edit.sections.listing") },
    { id: "icon", label: t("myApps.edit.sections.icon") },
    { id: "graphics", label: t("myApps.edit.sections.graphics") },
    { id: "screenshots", label: t("myApps.edit.sections.screenshots") },
    { id: "translations", label: t("myApps.edit.sections.translations") },
    ...(latest ? [{ id: "permissions", label: t("myApps.edit.sections.permissions") }] : []),
    { id: "versions", label: t("myApps.edit.sections.versions") },
    { id: "github", label: t("myApps.edit.sections.githubSource") },
    { id: "proxy-sources", label: t("myApps.edit.sections.proxySources") },
    { id: "ci", label: t("myApps.edit.sections.deployTokens") },
    { id: "collaborators", label: t("myApps.edit.sections.collaborators") },
  ];
  const sectionRoster = baseRoster.map((s, i) => ({
    ...s,
    step: String(i + 1).padStart(2, "0"),
  }));
  const stepOf = (id: string) => sectionRoster.find((s) => s.id === id)?.step ?? "";

  return (
    <div className="relative space-y-8 pb-12">
      {/* Letterhead rule — extremely faint horizontal hairlines every 4 px
          create a typesetter's ruled-paper feel unique to this page.
          Fixed so it doesn't drift while the page scrolls. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 opacity-[0.025]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(to bottom, rgb(var(--ink)) 0 1px, transparent 1px 4px)",
        }}
      />

      <Hero app={app} />

      <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
        <Rail
          sections={sectionRoster}
          active={activeSection}
          onPick={scrollToSection}
        />

        <div className="min-w-0 space-y-6">
      {/* ──── Listing ──── */}
      <Section id="listing" step={stepOf("listing")} title={t("myApps.edit.sections.listing")} subtitle={t("myApps.edit.sections.listingSubtitle")}>
        <form onSubmit={save} className="grid gap-4 md:grid-cols-2">
          <FormField label={t("myApps.edit.fields.title")} htmlFor="name" className="md:col-span-2">
            <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField label={t("myApps.edit.fields.packageLocked")} htmlFor="pkg">
            <Input id="pkg" disabled value={app.package_name} className="font-mono text-xs" />
          </FormField>
          <FormField label={t("myApps.edit.fields.visibility")} htmlFor="vis">
            <select
              id="vis"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as "public" | "private")}
              className="h-12 w-full rounded-xl border border-outline bg-surface px-3 text-sm focus:border-primary focus:outline-none"
            >
              <option value="public">{t("myApps.edit.fields.visibilityPublic")}</option>
              <option value="private">{t("myApps.edit.fields.visibilityPrivate")}</option>
            </select>
          </FormField>
          <FormField label={t("myApps.edit.fields.summary")} htmlFor="sum" className="md:col-span-2">
            <Input id="sum" value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={255} />
          </FormField>
          <FormField label={t("myApps.edit.fields.description")} htmlFor="desc" className="md:col-span-2">
            <MarkdownEditor
              id="desc"
              value={description}
              onChange={setDescription}
              minRows={6}
              placeholder={t("myApps.edit.fields.descriptionPlaceholder")}
            />
          </FormField>
          <FormField label={t("myApps.edit.fields.categories")} className="md:col-span-2">
            <CategoryPicker
              available={availableCategories}
              selectedIds={selectedCategoryIds}
              onToggle={toggleCategory}
              onClear={() => setSelectedCategoryIds([])}
            />
          </FormField>
          <FormField label={t("myApps.edit.fields.author")} htmlFor="author"><Input id="author" value={authorName} onChange={(e) => setAuthorName(e.target.value)} /></FormField>
          <FormField label={t("myApps.edit.fields.license")} htmlFor="lic"><Input id="lic" value={license} onChange={(e) => setLicense(e.target.value)} /></FormField>
          <FormField label={t("myApps.edit.fields.website")} htmlFor="web"><Input id="web" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} /></FormField>
          <FormField label={t("myApps.edit.fields.sourceCode")} htmlFor="src"><Input id="src" type="url" value={sourceCode} onChange={(e) => setSourceCode(e.target.value)} /></FormField>
          <FormField label={t("myApps.edit.fields.issueTracker")} htmlFor="issue" className="md:col-span-2">
            <Input id="issue" type="url" value={issueTracker} onChange={(e) => setIssueTracker(e.target.value)} />
          </FormField>
          <FormField label={t("myApps.edit.fields.authorEmail")} htmlFor="aemail">
            <Input id="aemail" type="email" value={authorEmail} onChange={(e) => setAuthorEmail(e.target.value)} />
          </FormField>
          <FormField label={t("myApps.edit.fields.translationUrl")} htmlFor="trans">
            <Input id="trans" type="url" placeholder={t("myApps.edit.fields.translationPlaceholder")} value={translation} onChange={(e) => setTranslation(e.target.value)} />
          </FormField>
          <FormField label={t("myApps.edit.fields.donateUrl")} htmlFor="don">
            <Input id="don" type="url" value={donate} onChange={(e) => setDonate(e.target.value)} />
          </FormField>
          <FormField label={t("myApps.edit.fields.liberapay")} htmlFor="lib">
            <Input id="lib" type="url" placeholder={t("myApps.edit.fields.liberapayPlaceholder")} value={liberapay} onChange={(e) => setLiberapay(e.target.value)} />
          </FormField>
          <FormField label={t("myApps.edit.fields.openCollective")} htmlFor="oc">
            <Input id="oc" type="url" placeholder={t("myApps.edit.fields.openCollectivePlaceholder")} value={openCollective} onChange={(e) => setOpenCollective(e.target.value)} />
          </FormField>
          <FormField label={t("myApps.edit.fields.bitcoin")} htmlFor="btc">
            <Input id="btc" placeholder={t("myApps.edit.fields.bitcoinPlaceholder")} value={bitcoin} onChange={(e) => setBitcoin(e.target.value)} />
          </FormField>
          <div className="md:col-span-2 flex justify-end">
            <Button type="submit" variant="filled" size="lg" disabled={saving}>
              {saving ? t("common.saving") : t("myApps.edit.saveListing")}
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
                <div className="text-sm font-semibold text-ink">{t("myApps.edit.signerLocked.title")}</div>
                <p className="mt-0.5 text-xs text-ink-mute">
                  {t("myApps.edit.signerLocked.body")}
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
      <Section id="icon" step={stepOf("icon")} title={t("myApps.edit.sections.icon")} subtitle={t("myApps.edit.sections.iconSubtitle")}>
        <div className="flex flex-wrap items-center gap-5">
          <AppIcon iconPath={app.icon_path} name={app.name} size={96} version={app.updated_at} mediaToken={app.media_token} className="shadow-e2" />
          <div className="flex-1 space-y-2">
            <Badge variant={app.icon_is_custom ? "primary" : "outline"}>
              {app.icon_is_custom ? t("myApps.edit.iconCustom") : t("myApps.edit.iconAuto")}
            </Badge>
            {app.icon_path && (
              <div className="font-mono text-[11px] text-ink-mute">{app.icon_path}</div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex">
                <span className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-pill bg-primary-container px-4 text-sm font-semibold text-primary-on-container hover:brightness-[1.04]">
                  <ImagePlus className="h-4 w-4" /> {t("myApps.edit.uploadCustomIcon")}
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
                  <RotateCcw className="h-4 w-4" /> {t("myApps.edit.revertIcon")}
                </Button>
              )}
            </div>
          </div>
        </div>
      </Section>

      {/* ──── Banners ──── */}
      <Section
        id="graphics"
        step={stepOf("graphics")}
        title={t("myApps.edit.sections.graphics")}
        subtitle={t("myApps.edit.sections.graphicsSubtitle")}
      >
        <div className="grid gap-4 md:grid-cols-3">
          <BannerSlot
            label={t("myApps.edit.banner.featured")}
            hint={t("myApps.edit.banner.featuredHint")}
            aspect="aspect-[1024/500]"
            url={mediaUrl(app.feature_graphic_path, { token: app.media_token }) || null}
            onUpload={uploadFeatureGraphic}
            onClear={clearFeatureGraphic}
          />
          <BannerSlot
            label={t("myApps.edit.banner.promo")}
            hint={t("myApps.edit.banner.promoHint")}
            aspect="aspect-[320/180]"
            url={mediaUrl(app.promo_graphic_path, { token: app.media_token }) || null}
            onUpload={uploadPromoGraphic}
            onClear={clearPromoGraphic}
          />
          <BannerSlot
            label={t("myApps.edit.banner.tv")}
            hint={t("myApps.edit.banner.tvHint")}
            aspect="aspect-video"
            url={mediaUrl(app.tv_banner_path, { token: app.media_token }) || null}
            onUpload={uploadTvBanner}
            onClear={clearTvBanner}
          />
        </div>
      </Section>

      {/* ──── Screenshots ──── */}
      <Section
        id="screenshots"
        step={stepOf("screenshots")}
        title={t("myApps.edit.sections.screenshots")}
        subtitle={
          screenshots.length > 1
            ? t("myApps.edit.sections.screenshotsSubtitleReorder")
            : t("myApps.edit.sections.screenshotsSubtitle")
        }
      >
        <label className="inline-flex">
          <span className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-pill bg-primary-container px-4 text-sm font-semibold text-primary-on-container hover:brightness-[1.04]">
            <ImagePlus className="h-4 w-4" /> {t("myApps.edit.screenshots.add")}
          </span>
          <input
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => { uploadScreenshots(e.target.files); e.target.value = ""; }}
            className="sr-only"
          />
        </label>
        <ScreenshotUploadProgress pendingShots={pendingShots} />
        <ScreenshotGrid
          screenshots={screenshots}
          pendingShots={pendingShots}
          mediaToken={app.media_token}
          reordering={reorderingScreenshots}
          dndSensors={dndSensors}
          onDragEnd={onScreenshotDragEnd}
          onDelete={deleteScreenshot}
        />
      </Section>

      {/* ──── Translations ──── */}
      <Section
        id="translations"
        step={stepOf("translations")}
        title={t("myApps.edit.sections.translations")}
        subtitle={t("myApps.edit.sections.translationsSubtitle")}
      >
        <LocalizationsEditor
          appId={app.id}
          localizations={app.localizations}
          onSaved={load}
        />
      </Section>

      {/* ──── Permissions ──── */}
      {latest && (
        <Section id="permissions" step={stepOf("permissions")} title={t("myApps.edit.sections.permissions")} subtitle={t("myApps.edit.sections.permissionsSubtitle", { name: latest.version_name, code: latest.version_code })}>
          <AppPermissions permissions={latest.permissions} />
        </Section>
      )}

      {/* ──── Versions ──── */}
      <Section
        id="versions"
        step={stepOf("versions")}
        title={t("myApps.edit.sections.versions")}
        subtitle={
          app.suggested_version_is_manual
            ? t("myApps.edit.sections.versionsSubtitleManual")
            : t("myApps.edit.sections.versionsSubtitleAuto")
        }
      >
        <RetentionBanner app={app} />
        {currentUser?.role === "admin" && (
          <RetentionAdminOverride app={app} onSaved={() => void load()} />
        )}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <label className="inline-flex">
            <span className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-pill bg-primary px-4 text-sm font-semibold text-primary-fg shadow-e1 hover:brightness-[1.04]">
              <Upload className="h-4 w-4" /> {t("myApps.edit.versions.uploadNew")}
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
            <span className="text-sm text-ink-soft">{t("myApps.edit.versions.uploading")}</span>
          )}
          {app.suggested_version_is_manual && (
            <Button
              type="button"
              variant="outlined"
              size="sm"
              onClick={resetSuggestedVersion}
              className="ml-auto"
            >
              <RotateCcw className="h-3.5 w-3.5" /> {t("myApps.edit.versions.autoLatest")}
            </Button>
          )}
        </div>

        <ul className="space-y-2">
          {app.apks.length === 0 ? (
            <li className="rounded-xl border border-dashed border-outline px-4 py-10 text-center italic text-ink-mute">
              {t("myApps.edit.versions.none")}
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
                            {app.suggested_version_is_manual ? t("myApps.edit.versions.pinned") : t("myApps.edit.versions.suggested")}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-ink-mute">
                        {t("myApps.edit.versions.metaLine", {
                          code: apk.version_code,
                          size: formatBytes(apk.size_bytes),
                          min: apk.min_sdk ?? "?",
                          max: apk.target_sdk ?? "?",
                        })}
                      </div>
                      {(() => {
                        const preview = pickLocalizedText(apk.whats_new);
                        const locales = apk.whats_new ? Object.keys(apk.whats_new) : [];
                        if (!preview) {
                          return (
                            <p className="mt-1 text-xs italic text-ink-mute">{t("myApps.edit.versions.noChangelog")}</p>
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
                                {t("myApps.edit.versions.moreLocales", { n: locales.length - 1 })}
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
                      {repo.reproducibleBuildsEnabled && (
                        <ReproducibilityRow
                          apk={apk}
                          onUpdated={(updated) => updateApkInPlace(updated)}
                        />
                      )}
                      <CveRow apk={apk} />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {canPin && (
                        <Button
                          size="sm"
                          variant="text"
                          onClick={() => pinSuggestedVersion(apk.version_code)}
                          title={t("myApps.edit.versions.suggestThisTitle")}
                        >
                          {t("myApps.edit.versions.suggestThis")}
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
                            for (const [l, txt] of Object.entries(apk.whats_new)) {
                              if (txt) initial[l] = txt;
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
                        {apk.whats_new ? t("myApps.edit.versions.editNotes") : t("myApps.edit.versions.addNotes")}
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => deleteApk(apk)}>
                        <Trash2 className="h-3.5 w-3.5" /> {t("common.delete")}
                      </Button>
                    </div>
                  </li>
                  {isEditing && editingChangelog && (
                    <Sheet
                      open={true}
                      onClose={() => setEditingChangelog(null)}
                      title={
                        apk.whats_new
                          ? t("myApps.edit.versions.editNotes")
                          : t("myApps.edit.versions.addNotes")
                      }
                      eyebrow={
                        <>
                          <span className="rounded-pill border border-outline-soft bg-surface-2 px-2 py-0.5 text-ink">
                            v{apk.version_name}
                          </span>
                          <span className="opacity-60">·</span>
                          <span>code {apk.version_code}</span>
                        </>
                      }
                      footer={
                        <>
                          {apk.whats_new && Object.keys(apk.whats_new).length > 0 && (
                            <Button
                              size="md"
                              variant="text"
                              className="mr-auto text-danger"
                              onClick={() => clearChangelog(apk.id)}
                            >
                              {t("myApps.edit.versions.clearAllLocales")}
                            </Button>
                          )}
                          <Button size="md" variant="ghost" onClick={() => setEditingChangelog(null)}>
                            {t("common.cancel")}
                          </Button>
                          <Button size="md" variant="filled" onClick={saveChangelog} disabled={savingChangelog}>
                            {savingChangelog ? t("common.saving") : t("common.save")}
                          </Button>
                        </>
                      }
                    >
                      <ChangelogEditor
                        version={`v${apk.version_name} (${apk.version_code})`}
                        draft={editingChangelog}
                        onChange={setEditingChangelog}
                      />
                    </Sheet>
                  )}
                </Fragment>
              );
            })
          )}
        </ul>
      </Section>

      {/* ──── GitHub source auto-fetch ──── */}
      <Section
        id="github"
        step={stepOf("github")}
        title={t("myApps.edit.sections.githubSource")}
        subtitle={t("myApps.edit.sections.githubSourceSubtitle")}
      >
        <GithubSourceSection appId={app.id} onImported={() => void load()} />
      </Section>

      {/* ──── Proxy-driven sources (F-Droid mirror, Patreon, private registry, …) ──── */}
      <Section
        id="proxy-sources"
        step={stepOf("proxy-sources")}
        title={t("myApps.edit.sections.proxySources")}
        subtitle={t("myApps.edit.sections.proxySourcesSubtitle")}
      >
        <ProxySourcesSection appId={app.id} onImported={() => void load()} />
      </Section>

      {/* ──── CI deploy tokens ──── */}
      {currentUser && (
        <Section
          id="ci"
          step={stepOf("ci")}
          title={t("myApps.edit.sections.deployTokens")}
          subtitle={t("myApps.edit.sections.deployTokensSubtitle")}
        >
          <DeployTokensSection appId={app.id} />
        </Section>
      )}

      {/* ──── Collaborators ──── */}
      {currentUser && app.owner_id && (
        <Section id="collaborators" step={stepOf("collaborators")} title={t("myApps.edit.sections.collaborators")} subtitle={t("myApps.edit.sections.collaboratorsSubtitle")}>
          <CollaboratorsSection
            appId={app.id}
            ownerId={app.owner_id}
            currentUserId={currentUser.id}
          />
        </Section>
      )}

          <DangerZone onDelete={deleteApp} />
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Editorial chrome: Hero, Rail, Section, DangerZone                          */
/* -------------------------------------------------------------------------- */

function Hero({ app }: { app: AppDetail }) {
  const { t } = useTranslation();
  return (
    <header className="relative overflow-hidden rounded-3xl border border-outline-soft bg-surface px-6 py-7 md:px-10 md:py-9 animate-fade-up">
      {/* Editorial header decoration: a soft tint wash + a hairline pair
          at the corner — like the trim mark in a printed layout. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 80% at 100% 0%, rgb(var(--primary) / 0.10), transparent 65%)",
        }}
      />
      <div aria-hidden className="pointer-events-none absolute right-6 top-6 h-12 w-12">
        <div className="absolute inset-x-0 top-0 h-px bg-outline" />
        <div className="absolute inset-y-0 right-0 w-px bg-outline" />
      </div>

      <div className="relative">
        <Link href="/my-apps" className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-ink-mute hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" /> {t("myApps.edit.back")}
        </Link>

        <div className="mt-4 flex flex-wrap items-start gap-6">
          <AppIcon
            iconPath={app.icon_path}
            name={app.name}
            size={96}
            version={app.updated_at}
            mediaToken={app.media_token}
            className="shadow-e2"
          />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-4xl font-bold tracking-tight text-ink md:text-5xl">
              {app.name}
            </h1>
            {/* Hairline + package — a typesetter's slug under the title. */}
            <div className="mt-2 flex items-center gap-3">
              <span className="h-px w-8 bg-outline" aria-hidden />
              <span className="truncate font-mono text-xs text-ink-mute">
                {app.package_name}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <Badge variant={app.visibility === "private" ? "accent" : "outline"}>
                {app.visibility}
              </Badge>
              <Badge variant={app.status === "published" ? "primary" : "soft"}>
                {app.status.replace("_", " ")}
              </Badge>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ExportYamlButton app={app} />
            <Button asChild variant="outlined" size="md">
              <Link href={`/apps/${app.package_name}`}>
                <Eye className="h-4 w-4" /> {t("myApps.edit.publicPage")}
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}

/** Download the F-Droid ``metadata.yml`` for this app. Lives next to the
 *  "Page publique" CTA in the Hero — both are app-level metadata actions
 *  that aren't part of any one Section. */
function ExportYamlButton({ app }: { app: AppDetail }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const { filename, blob } = await api.apps.exportMetadataYaml(app.id);
      // Standard pattern for forced-download in the browser: create an
      // object URL, anchor element, click it, revoke. ``a.download``
      // hints the filename — the server-provided Content-Disposition
      // wins in practice but this keeps the file named even on UAs
      // that ignore the header.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(t("myApps.edit.exportYamlOk"));
    } catch (e) {
      toast.error(
        t("myApps.edit.exportYamlFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="outlined" size="md" onClick={download} disabled={busy}>
      <Download className="h-4 w-4" />
      {busy ? t("common.loading") : t("myApps.edit.exportYaml")}
    </Button>
  );
}


function Rail({
  sections,
  active,
  onPick,
}: {
  sections: { id: string; step: string; label: string }[];
  active: string;
  onPick: (id: string) => void;
}) {
  // Hidden on mobile — the long content already provides natural flow.
  // On desktop it sits sticky just under the site header so the operator
  // can jump between sections without losing place.
  return (
    <nav aria-label="Sections" className="hidden lg:block">
      <div className="sticky top-20 space-y-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-mute">
          / sections
        </div>
        <ul className="space-y-0.5">
          {sections.map((s) => {
            const isActive = s.id === active;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onPick(s.id)}
                  className={cn(
                    "group flex w-full items-baseline gap-3 rounded-xl px-2 py-1.5 text-left transition-colors",
                    isActive
                      ? "bg-primary-container/40 text-primary-on-container"
                      : "text-ink-soft hover:bg-surface-2 hover:text-ink",
                  )}
                >
                  <span
                    className={cn(
                      "w-7 shrink-0 font-mono text-[10px] tabular-nums tracking-wider",
                      isActive ? "text-primary" : "text-ink-mute",
                    )}
                  >
                    {s.step}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.label}</span>
                  {isActive && (
                    // ``self-center`` overrides the row's ``items-baseline``
                    // (used to align the step number with the label). An
                    // empty span has no text baseline, so the default lands
                    // it on the row's bottom edge — visibly off-centre.
                    <span aria-hidden className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-primary" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}


/** Surface the repo's retention policy on the Versions section. Visible
 *  to anyone with manage rights — knowing "the oldest version will be
 *  deleted on the next upload" is information owners + collaborators
 *  benefit from before pressing Upload. */
function RetentionBanner({ app }: { app: AppDetail }) {
  const { t } = useTranslation();
  const cap = app.effective_max_versions;
  if (cap == null || cap <= 0) return null;
  const apks = app.apks ?? [];
  const sortedAsc = [...apks].sort((a, b) => a.version_code - b.version_code);
  // What WOULD be evicted on the next upload? Skip the suggested
  // version (server-side eviction does the same) and return the
  // oldest non-suggested APK. Returns null when adding one more APK
  // wouldn't exceed the cap.
  const suggested = app.suggested_version_code;
  let nextEvicted: Apk | null = null;
  if (apks.length + 1 > cap) {
    for (const a of sortedAsc) {
      if (suggested != null && a.version_code === suggested) continue;
      nextEvicted = a;
      break;
    }
  }
  const tone = apks.length >= cap ? "warn" : "info";
  return (
    <div
      className={cn(
        "mb-4 flex flex-wrap items-start gap-3 rounded-2xl border px-4 py-3 text-xs leading-relaxed",
        tone === "warn"
          ? "border-accent/40 bg-accent-container/30 text-ink"
          : "border-outline-soft bg-surface-2 text-ink-soft",
      )}
    >
      <ShieldAlert className={cn("mt-0.5 h-4 w-4 shrink-0", tone === "warn" ? "text-accent" : "text-ink-mute")} />
      <div className="min-w-0">
        <div className="font-semibold text-ink">
          {t("myApps.edit.versions.retentionTitle", { kept: apks.length, cap })}
        </div>
        {nextEvicted ? (
          <p className="mt-0.5">
            <Trans
              i18nKey="myApps.edit.versions.retentionNextEvict"
              values={{
                name: nextEvicted.version_name,
                code: nextEvicted.version_code,
              }}
              components={{ b: <span className="font-mono text-ink" /> }}
            />
          </p>
        ) : (
          <p className="mt-0.5">{t("myApps.edit.versions.retentionBody")}</p>
        )}
      </div>
    </div>
  );
}


/** Admin-only knob to set or clear the per-app retention override.
 *  Lives under the RetentionBanner so admins see the current state
 *  before reaching for the override. ``""`` means "follow repo
 *  default", ``"0"`` means "no cap for this app", any positive int
 *  pins the cap. */
function RetentionAdminOverride({
  app,
  onSaved,
}: {
  app: AppDetail;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState<string>(
    app.max_versions_override == null ? "" : String(app.max_versions_override),
  );
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {};
      const trimmed = value.trim();
      if (trimmed === "") {
        payload.reset_max_versions_override = true;
      } else {
        const n = parseInt(trimmed, 10);
        if (!Number.isFinite(n) || n < 0) {
          toast.error(t("myApps.edit.versions.retentionOverrideInvalid"));
          return;
        }
        payload.max_versions_override = n;
      }
      await api.admin.updateApp(app.id, payload);
      toast.success(t("myApps.edit.versions.retentionOverrideSaved"));
      onSaved();
    } catch (e) {
      toast.error(t("myApps.edit.versions.retentionOverrideFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={save}
      className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-dashed border-outline px-4 py-3"
    >
      <div className="flex basis-full flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
          {t("myApps.edit.versions.retentionOverrideEyebrow")}
        </span>
        {/* Show the current repo default as a chip so the admin
            knows what value the override will be clamped against.
            ``null`` means no global cap — render an infinity glyph. */}
        <span className="inline-flex items-center gap-1.5 rounded-pill border border-outline-soft bg-surface px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-soft">
          <span className="text-ink-mute">{t("myApps.edit.versions.retentionRepoDefaultLabel")}</span>
          <span className="tabular-nums text-ink">
            {app.repo_default_max_versions == null ? "∞" : String(app.repo_default_max_versions)}
          </span>
        </span>
      </div>
      {/* Label is its own ``basis-full`` row so Input + Button stay
          siblings of the same flex line — combined with the form's
          ``items-center``, the button now centres against the input's
          midline (not against the [Label + Input] column's midline,
          which left it visually floating against the label). */}
      <Label htmlFor="ret-override" className="block basis-full text-xs font-medium text-ink-soft">
        {t("myApps.edit.versions.retentionOverrideLabel")}
      </Label>
      <Input
        id="ret-override"
        type="number"
        min={0}
        inputMode="numeric"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("myApps.edit.versions.retentionOverridePlaceholder")}
        className="min-w-[10rem] flex-1"
      />
      <Button type="submit" variant="outlined" size="sm" disabled={busy} className="shrink-0">
        {busy ? t("common.saving") : t("common.save")}
      </Button>
      <p className="basis-full text-[11px] text-ink-mute">
        {t("myApps.edit.versions.retentionOverrideHint")}
      </p>
    </form>
  );
}


function Section({
  id,
  step,
  title,
  subtitle,
  children,
}: {
  id: string;
  step: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      data-section={id}
      id={`section-${id}`}
      className="relative scroll-mt-24 rounded-3xl border border-outline-soft bg-surface p-6 md:p-8"
    >
      <header className="mb-6 flex flex-col gap-2 border-b border-outline-soft pb-5">
        <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-mute">
          Section {step}
        </div>
        <div className="flex items-baseline gap-4">
          {/* Oversized faint section number in the gutter — the editorial
              signature of this page. tabular-nums keeps it stable. */}
          <span className="hidden font-bold text-outline tabular-nums leading-none md:block md:text-6xl">
            {step}
          </span>
          <div className="min-w-0">
            <h2 className="text-2xl font-bold tracking-tight text-ink">{title}</h2>
            {subtitle && (
              <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-soft">
                {subtitle}
              </p>
            )}
          </div>
        </div>
      </header>
      {children}
    </section>
  );
}


function DangerZone({ onDelete }: { onDelete: () => void }) {
  const { t } = useTranslation();
  return (
    <section
      className="relative overflow-hidden rounded-3xl border-2 border-danger/40 p-6"
      style={{
        background:
          "linear-gradient(135deg, rgb(var(--danger) / 0.06) 0%, transparent 60%)",
      }}
    >
      {/* Diagonal hazard hatch in the corner — distinct from the page's
          horizontal rule texture, signals "this is the destructive end
          of the workshop". */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 opacity-30"
        style={{
          backgroundImage:
            "repeating-linear-gradient(45deg, rgb(var(--danger)) 0 2px, transparent 2px 8px)",
        }}
      />
      <div className="relative flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-danger">
            ⚠ {t("myApps.edit.sections.dangerEyebrow")}
          </div>
          <h2 className="mt-1 text-xl font-bold tracking-tight text-danger">
            {t("myApps.edit.sections.danger")}
          </h2>
          <p className="mt-1 max-w-prose text-sm text-ink-soft">
            {t("myApps.edit.sections.dangerSubtitle")}
          </p>
        </div>
        <Button variant="danger" onClick={onDelete}>
          <Trash2 className="h-4 w-4" /> {t("myApps.edit.deleteApp")}
        </Button>
      </div>
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
  const { t } = useTranslation();
  return (
    <div className="h-6 w-6 animate-spin rounded-full border-2 border-outline-soft border-t-primary" role="status" aria-label={t("common.loading")} />
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
  const { t } = useTranslation();
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
        {t("myApps.edit.changelog.title", { version })}
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
                aria-label={t("myApps.edit.changelog.remove", { label: lbl.label })}
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
            <Plus className="h-3 w-3" strokeWidth={2.6} /> {t("myApps.edit.changelog.addLanguage")}
          </button>
          {picker && (
            <div className="absolute left-0 top-9 z-20 w-72 rounded-2xl border border-outline-soft bg-surface p-3 shadow-e3">
              <div className="mb-1 px-1 text-[10px] uppercase tracking-wider text-ink-mute">
                {t("myApps.edit.changelog.pickLocale")}
              </div>
              <div className="max-h-56 space-y-0.5 overflow-y-auto">
                {available.length === 0 ? (
                  <p className="px-2 py-2 text-xs italic text-ink-mute">
                    {t("myApps.edit.changelog.everyCovered")}
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
                  {t("myApps.edit.changelog.other")}
                </div>
                <div className="flex gap-1.5 px-1">
                  <Input
                    placeholder={t("myApps.edit.changelog.otherPlaceholder")}
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
                    {t("common.add")}
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
        placeholder={t("myApps.edit.changelog.placeholder", { name: localeLabel(draft.activeLocale).label })}
      />
      <p className="mt-1 text-[10px] text-ink-mute">
        {t("myApps.edit.changelog.footnote")}
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
  const { t } = useTranslation();
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
            <Trash2 className="h-3 w-3" /> {t("common.remove")}
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
              {t("myApps.edit.banner.replace")}
            </span>
          </>
        ) : (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-ink-mute">
            <ImagePlus className="h-5 w-5" strokeWidth={2} />
            <span className="text-[11px] font-medium">{t("myApps.edit.banner.uploadLabel", { label: label.toLowerCase() })}</span>
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
  mediaToken,
  onDelete,
}: {
  screenshot: Screenshot;
  index: number;
  mediaToken: string | null;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: screenshot.id });

  const url = mediaUrl(screenshot.storage_key, { token: mediaToken });
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
        aria-label={t("myApps.edit.screenshots.drag", { n: index + 1 })}
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
        aria-label={t("myApps.edit.screenshots.deleteLabel")}
        className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-pill bg-danger text-danger-fg opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-danger/30"
      >
        <X className="h-3.5 w-3.5" strokeWidth={2.6} />
      </button>
    </div>
  );
}

/* The visible grid for the screenshots section. Merges the persisted
 * screenshots (sortable) with the in-flight pending placeholders so the
 * user sees images appear progressively rather than waiting for the
 * whole batch to finish.
 *
 * Once a placeholder lands as ``done`` it carries the same screenshot
 * id as the freshly-fetched persistent tile — we filter the persisted
 * list against the in-flight set so we never render the same image
 * twice during the brief overlap. After ``pendingShots`` clears, the
 * filter becomes a no-op and the real grid takes over fully. */
function ScreenshotGrid({
  screenshots,
  pendingShots,
  mediaToken,
  reordering,
  dndSensors,
  onDragEnd,
  onDelete,
}: {
  screenshots: Screenshot[];
  pendingShots: PendingShot[];
  mediaToken: string | null;
  reordering: boolean;
  dndSensors: ReturnType<typeof useSensors>;
  onDragEnd: (e: DragEndEvent) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const pendingDoneIds = useMemo(
    () =>
      new Set(
        pendingShots
          .filter((p) => p.status === "done" && p.screenshot)
          .map((p) => p.screenshot!.id),
      ),
    [pendingShots],
  );
  const visible = useMemo(
    () => screenshots.filter((s) => !pendingDoneIds.has(s.id)),
    [screenshots, pendingDoneIds],
  );

  if (visible.length === 0 && pendingShots.length === 0) {
    return (
      <p className="mt-4 text-sm italic text-ink-mute">{t("myApps.edit.screenshots.empty")}</p>
    );
  }

  return (
    <div className={cn("mt-4 flex flex-wrap gap-3", reordering && "opacity-90")}>
      {visible.length > 0 && (
        <DndContext
          sensors={dndSensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={visible.map((s) => s.id)}
            strategy={rectSortingStrategy}
          >
            {visible.map((s, i) => (
              <SortableScreenshot
                key={s.id}
                screenshot={s}
                index={i}
                mediaToken={mediaToken}
                onDelete={onDelete}
              />
            ))}
          </SortableContext>
        </DndContext>
      )}
      {pendingShots.map((p) => (
        <PendingShotTile key={p.tempId} pending={p} mediaToken={mediaToken} />
      ))}
    </div>
  );
}


/* The header chip that sits above the screenshot grid while an upload
 * batch is in flight. Three jobs:
 *  1. A glance-readable counter (N done / M total) so the user knows how
 *     much further they have to wait.
 *  2. A progress meter that fills as ``done + error`` advances — the
 *     bar tints amber when any file errored so the final state isn't
 *     ambiguous.
 *  3. A status eyebrow that flips from "uploading" through "uploaded"
 *     or "uploaded with errors" before fading out with the placeholders.
 *
 * Matches the editorial typesetter aesthetic of the rest of the page:
 * mono uppercase eyebrow, tabular-nums counter, hairline border, no
 * embellishment beyond what carries information. */
function ScreenshotUploadProgress({
  pendingShots,
}: {
  pendingShots: PendingShot[];
}) {
  const { t } = useTranslation();
  if (pendingShots.length === 0) return null;

  const total = pendingShots.length;
  const doneCount = pendingShots.filter((p) => p.status === "done").length;
  const errorCount = pendingShots.filter((p) => p.status === "error").length;
  const processingCount = pendingShots.filter(
    (p) => p.status === "queued" || p.status === "uploading",
  ).length;
  const pct = Math.round(((doneCount + errorCount) / total) * 100);

  const stateKey =
    processingCount > 0
      ? "uploadingEyebrow"
      : errorCount > 0
        ? "uploadedWithErrorsEyebrow"
        : "uploadedAllEyebrow";

  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-4 overflow-hidden rounded-2xl border border-outline-soft bg-surface-2"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        {processingCount > 0 ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" strokeWidth={2.2} />
        ) : errorCount > 0 ? (
          <XCircle className="h-4 w-4 shrink-0 text-accent" strokeWidth={2.2} />
        ) : (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" strokeWidth={2.2} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-mute">
              {t(`myApps.edit.screenshots.${stateKey}`)}
            </span>
            <span className="font-mono text-xs tabular-nums text-ink">
              <span className={cn(errorCount > 0 ? "text-accent" : "text-primary")}>
                {doneCount}
              </span>
              <span className="text-ink-mute"> / </span>
              <span>{total}</span>
              {errorCount > 0 && (
                <span className="ml-2 text-[10px] uppercase tracking-wider text-danger">
                  {t("myApps.edit.screenshots.partialFailedChip", { failed: errorCount })}
                </span>
              )}
            </span>
          </div>
          {/* Progress meter. Uses ``transition-[width]`` so each per-file
              completion eases the bar forward — a static bar that
              snaps would lose the "things are moving" feeling. */}
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-pill bg-surface">
            <div
              className={cn(
                "h-full transition-[width] duration-500 ease-out",
                errorCount > 0 ? "bg-accent" : "bg-primary",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}


/* A single in-flight upload tile. Four visual states:
 *   queued     → dashed border, idle dot, file name
 *   uploading  → solid border, spinner, file name, primary tint
 *   done       → actual image rendered with a tiny green check chip
 *                in the corner that lasts until the parent clears the
 *                ``pendingShots`` array a beat after the batch finishes
 *   error      → red dashed border, X icon, error message tooltip
 *
 * Sized to roughly mirror a portrait phone screenshot (h-44 × w-28) so
 * the placeholder occupies the same footprint the persisted tile will
 * once the grid refreshes — no jarring layout shift on swap. */
function PendingShotTile({
  pending,
  mediaToken,
}: {
  pending: PendingShot;
  mediaToken: string | null;
}) {
  const { t } = useTranslation();
  const url = pending.screenshot
    ? mediaUrl(pending.screenshot.storage_key, { token: mediaToken })
    : null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${pending.name} — ${pending.status}`}
      className={cn(
        "relative h-44 w-28 shrink-0 overflow-hidden rounded-xl border bg-surface-2 transition-colors",
        pending.status === "queued" && "border-dashed border-outline",
        pending.status === "uploading" && "border-primary/40 shadow-e1",
        pending.status === "done" && "border-primary/40 shadow-e1",
        pending.status === "error" && "border-dashed border-danger/60 bg-danger-container/30",
      )}
    >
      {/* Done state shows the actual uploaded image so the user gets
          their first real preview without waiting for the batch to
          finish. Falls back to the status indicator if the URL builder
          returns null (token missing, anonymous, etc.) */}
      {pending.status === "done" && url ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={pending.name}
            className="h-full w-full object-contain animate-fade-up"
            draggable={false}
          />
          <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-pill bg-surface/90 px-1.5 py-0.5 shadow-e1 backdrop-blur">
            <CheckCircle2 className="h-3 w-3 text-primary" strokeWidth={2.6} />
            <span className="font-mono text-[9px] uppercase tracking-wider text-primary">
              {t("myApps.edit.screenshots.pendingDone")}
            </span>
          </span>
        </>
      ) : (
        <>
          {/* Faint diagonal hatch in the background while we wait — the
              same print-shop texture as the page's letterhead rule but
              denser, so the empty slot reads as "in progress" rather
              than "empty". */}
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-0 opacity-[0.06]",
              pending.status === "uploading" && "opacity-[0.10]",
            )}
            style={{
              backgroundImage:
                "repeating-linear-gradient(45deg, rgb(var(--ink)) 0 1px, transparent 1px 6px)",
            }}
          />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-2 text-center">
            {pending.status === "queued" && (
              <>
                <span className="relative flex h-5 w-5 items-center justify-center">
                  <span className="absolute inline-flex h-3 w-3 animate-ping rounded-full bg-ink-mute/60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-ink-mute" />
                </span>
                <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-ink-mute">
                  {t("myApps.edit.screenshots.pendingQueued")}
                </span>
              </>
            )}
            {pending.status === "uploading" && (
              <>
                <Loader2 className="h-6 w-6 animate-spin text-primary" strokeWidth={2} />
                <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-primary">
                  {t("myApps.edit.screenshots.pendingUploading")}
                </span>
              </>
            )}
            {pending.status === "error" && (
              <>
                <XCircle className="h-6 w-6 text-danger" strokeWidth={2} />
                <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-danger">
                  {t("myApps.edit.screenshots.pendingError")}
                </span>
              </>
            )}
          </div>
        </>
      )}
      {/* File-name caption — only while pre-image so we don't paint
          over the actual screenshot. The mono font matches the meta-
          line treatment in the rest of the page chrome. */}
      {pending.status !== "done" && (
        <div
          className="absolute inset-x-0 bottom-0 truncate border-t border-outline-soft bg-surface/85 px-2 py-1 text-center font-mono text-[9px] text-ink-soft backdrop-blur"
          title={pending.name}
        >
          {pending.name}
        </div>
      )}
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
  const { t } = useTranslation();
  if (available.length === 0) {
    return <p className="text-xs italic text-ink-mute">{t("myApps.edit.categories.loading")}</p>;
  }
  const selected = available.filter((c) => selectedIds.includes(c.id));
  const rest = available.filter((c) => !selectedIds.includes(c.id));

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-outline-soft bg-surface-2/40 p-3">
        <div className="mb-2 flex items-center justify-between gap-2 text-[11px] uppercase tracking-wider text-ink-mute">
          <span>
            {t("myApps.edit.categories.onThisApp")} · <span className="font-mono normal-case text-ink-soft">{selected.length}</span>
          </span>
          {selected.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="font-mono text-[10px] text-ink-mute hover:text-danger"
            >
              {t("myApps.edit.categories.clearAll")}
            </button>
          )}
        </div>
        {selected.length === 0 ? (
          <p className="px-1 py-2 text-xs italic text-ink-mute">
            {t("myApps.edit.categories.empty")}
          </p>
        ) : (
          <ul role="group" aria-label={t("myApps.edit.categories.onThisApp")} className="flex flex-wrap gap-1.5">
            {selected.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onToggle(c.id)}
                  className="group inline-flex items-center gap-1.5 rounded-pill bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg shadow-e1 transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30"
                  aria-label={t("myApps.edit.categories.remove", { name: c.name })}
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
          {t("myApps.edit.categories.available")} · <span className="font-mono normal-case text-ink-soft">{rest.length}</span>
        </div>
        {rest.length === 0 ? (
          <p className="px-1 py-2 text-xs italic text-ink-mute">
            {t("myApps.edit.categories.allSelected")}
          </p>
        ) : (
          <ul role="group" aria-label={t("myApps.edit.categories.available")} className="flex flex-wrap gap-1.5">
            {rest.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onToggle(c.id)}
                  className="inline-flex items-center gap-1.5 rounded-pill border border-outline-soft bg-surface px-3 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-primary hover:bg-primary-container hover:text-primary-on-container focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30"
                  aria-label={t("myApps.edit.categories.add", { name: c.name })}
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
  const { t } = useTranslation();
  const active = new Set(apk.anti_features || []);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <ShieldAlert className="h-3.5 w-3.5 text-ink-mute" />
      <span className="mr-1 text-[10px] uppercase tracking-wider text-ink-mute">
        {t("antiFeatures.title")}
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

/* -------------------------------------------------------------------------- */
/*  Reproducibility editor                                                     */
/* -------------------------------------------------------------------------- */

function ReproducibilityRow({
  apk,
  onUpdated,
}: {
  apk: Apk;
  onUpdated: (next: Apk) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [refHash, setRefHash] = useState(apk.reproducibility_reference_sha256 || "");
  const [refUrl, setRefUrl] = useState(apk.reproducibility_reference_url || "");
  const [notes, setNotes] = useState(apk.reproducibility_notes || "");
  const [statusOverride, setStatusOverride] = useState<ReproducibilityStatus | "">("");
  const [busy, setBusy] = useState<"save" | "verify" | null>(null);

  // Reset draft whenever the row is rehydrated (e.g. after a save).
  useEffect(() => {
    setRefHash(apk.reproducibility_reference_sha256 || "");
    setRefUrl(apk.reproducibility_reference_url || "");
    setNotes(apk.reproducibility_notes || "");
    setStatusOverride("");
  }, [
    apk.reproducibility_reference_sha256,
    apk.reproducibility_reference_url,
    apk.reproducibility_notes,
  ]);

  const status = apk.reproducibility_status;
  const statusColour: Record<ReproducibilityStatus, string> = {
    unknown: "border-outline-soft text-ink-mute",
    not_attempted: "border-outline-soft text-ink-soft",
    verified: "border-primary text-primary",
    failed: "border-danger text-danger",
  };

  async function save() {
    setBusy("save");
    try {
      const payload: {
        status?: ReproducibilityStatus;
        reference_sha256?: string;
        reference_url?: string | null;
        notes?: string | null;
      } = {};
      if (statusOverride) payload.status = statusOverride;
      const cleanedHash = refHash.trim().toLowerCase();
      if (cleanedHash) payload.reference_sha256 = cleanedHash;
      // ``null`` clears the field server-side; "" is treated as null.
      payload.reference_url = refUrl.trim() || null;
      payload.notes = notes.trim() || null;
      const next = await api.apps.setReproducibility(apk.id, payload);
      onUpdated(next);
      toast.success(t("myApps.edit.reproducibility.saved"));
      setEditing(false);
    } catch (e) {
      toast.error(
        t("myApps.edit.reproducibility.saveFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setBusy(null);
    }
  }

  async function verifyFromUrl() {
    const cleanedUrl = refUrl.trim();
    if (!cleanedUrl) {
      toast.error(t("myApps.edit.reproducibility.urlRequired"));
      return;
    }
    setBusy("verify");
    try {
      const next = await api.apps.verifyReproducibilityFromUrl(apk.id, {
        reference_url: cleanedUrl,
        notes: notes.trim() || null,
      });
      onUpdated(next);
      toast.success(t("myApps.edit.reproducibility.verified"));
    } catch (e) {
      toast.error(
        t("myApps.edit.reproducibility.verifyFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="h-3.5 w-3.5 text-ink-mute" />
        <span className="text-[10px] uppercase tracking-wider text-ink-mute">
          {t("myApps.edit.reproducibility.label")}
        </span>
        <span
          className={cn(
            "rounded-pill border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
            statusColour[status],
          )}
        >
          {t(`reproducibility.status.${status}`)}
        </span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-[11px] text-primary hover:underline"
        >
          {t("myApps.edit.reproducibility.edit")}
        </button>
      </div>
      <Sheet
        open={editing}
        onClose={() => setEditing(false)}
        title={t("myApps.edit.reproducibility.sheetTitle")}
        eyebrow={
          <>
            <span className="rounded-pill border border-outline-soft bg-surface-2 px-2 py-0.5 text-ink">
              v{apk.version_name}
            </span>
            <span className="opacity-60">·</span>
            <span>{t(`reproducibility.status.${status}`)}</span>
          </>
        }
        footer={
          <>
            <Button
              size="md"
              variant="outlined"
              onClick={verifyFromUrl}
              disabled={busy !== null || !refUrl.trim()}
            >
              {busy === "verify"
                ? t("myApps.edit.reproducibility.verifying")
                : t("myApps.edit.reproducibility.verifyFromUrl")}
            </Button>
            <Button size="md" variant="filled" onClick={save} disabled={busy !== null}>
              {busy === "save" ? t("common.saving") : t("common.save")}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <label className="block text-[10px] uppercase tracking-[0.22em] text-ink-mute">
            {t("myApps.edit.reproducibility.refHash")}
            <input
              type="text"
              value={refHash}
              onChange={(e) => setRefHash(e.target.value)}
              placeholder="64-hex SHA-256"
              maxLength={64}
              spellCheck={false}
              className="mt-1.5 block w-full rounded-xl border border-outline-soft bg-surface-2 px-3 py-2 font-mono text-sm text-ink focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30"
            />
          </label>
          <label className="block text-[10px] uppercase tracking-[0.22em] text-ink-mute">
            {t("myApps.edit.reproducibility.refUrl")}
            <input
              type="url"
              value={refUrl}
              onChange={(e) => setRefUrl(e.target.value)}
              placeholder="https://verification.f-droid.org/<pkg>_<vcode>.apk.json"
              maxLength={512}
              className="mt-1.5 block w-full rounded-xl border border-outline-soft bg-surface-2 px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30"
            />
          </label>
          <label className="block text-[10px] uppercase tracking-[0.22em] text-ink-mute">
            {t("myApps.edit.reproducibility.statusOverride")}
            <select
              value={statusOverride}
              onChange={(e) => setStatusOverride(e.target.value as ReproducibilityStatus | "")}
              className="mt-1.5 block w-full rounded-xl border border-outline-soft bg-surface-2 px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30"
            >
              <option value="">{t("myApps.edit.reproducibility.statusKeep")}</option>
              <option value="unknown">{t("reproducibility.status.unknown")}</option>
              <option value="not_attempted">{t("reproducibility.status.not_attempted")}</option>
              <option value="verified">{t("reproducibility.status.verified")}</option>
              <option value="failed">{t("reproducibility.status.failed")}</option>
            </select>
          </label>
          <label className="block text-[10px] uppercase tracking-[0.22em] text-ink-mute">
            {t("myApps.edit.reproducibility.notes")}
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={1000}
              rows={4}
              className="mt-1.5 block w-full rounded-xl border border-outline-soft bg-surface-2 px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30"
            />
          </label>
          <p className="text-xs leading-relaxed text-ink-mute">
            {t("myApps.edit.reproducibility.help")}
          </p>
        </div>
      </Sheet>
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  CVE / SBOM row                                                             */
/* -------------------------------------------------------------------------- */

const _SEVERITY_ORDER: CveSeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"];

function CveRow({ apk }: { apk: Apk }) {
  const { t } = useTranslation();
  const [sbom, setSbom] = useState<SbomRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [rescanning, setRescanning] = useState(false);

  // Single load on mount, then refresh on rescan or when the row is
  // currently scanning (polled at a slow cadence — Trivy can take a
  // minute on first run while the DB downloads).
  const reload = useCallback(async (opts: { summary?: boolean } = {}) => {
    try {
      const data = await api.apps.sbom(apk.id, { summary: opts.summary !== false });
      setSbom(data);
    } catch (e) {
      toast.error(t("myApps.edit.cve.loadFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
  }, [apk.id, t]);

  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [apk.id]);
  useEffect(() => {
    if (!sbom) return;
    if (sbom.status !== "pending" && sbom.status !== "scanning") return;
    const id = window.setInterval(() => { void reload(); }, 4000);
    return () => window.clearInterval(id);
  }, [sbom?.status, reload, sbom]);

  async function rescan() {
    setRescanning(true);
    try {
      await api.apps.sbomRescan(apk.id);
      toast.success(t("myApps.edit.cve.rescanEnqueued"));
      await reload();
    } catch (e) {
      toast.error(t("myApps.edit.cve.rescanFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setRescanning(false);
    }
  }

  if (loading) {
    return (
      <div className="mt-2 flex items-center gap-2 text-[11px] text-ink-mute">
        <Bug className="h-3.5 w-3.5" /> {t("common.loading")}
      </div>
    );
  }

  const status = sbom?.status || "never_scanned";
  // Severity counts default to 0 so the badge group always renders the
  // same width whether the scan found anything or not.
  const counts: Record<CveSeverity, number> = {
    CRITICAL: sbom?.cve_summary?.CRITICAL || 0,
    HIGH: sbom?.cve_summary?.HIGH || 0,
    MEDIUM: sbom?.cve_summary?.MEDIUM || 0,
    LOW: sbom?.cve_summary?.LOW || 0,
    UNKNOWN: sbom?.cve_summary?.UNKNOWN || 0,
  };
  const totalCves = Object.values(counts).reduce((a, b) => a + b, 0);

  const sheetDisabled =
    !sbom || status === "pending" || status === "scanning" || status === "skipped" || status === "never_scanned";

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Bug className="h-3.5 w-3.5 text-ink-mute" />
        <span className="text-[10px] uppercase tracking-wider text-ink-mute">
          {t("myApps.edit.cve.label")}
        </span>
        <CveStatusPill status={status} totalCves={totalCves} />
        {totalCves > 0 && (
          <div className="flex items-center gap-1">
            {_SEVERITY_ORDER.map((s) => counts[s] > 0 && (
              <SeverityChip key={s} severity={s} count={counts[s]} />
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-[11px] text-primary hover:underline disabled:text-ink-mute disabled:no-underline"
          // Anything terminal has something worth showing — either the CVE
          // table or the "no findings" notice (which is itself useful info:
          // "we scanned and found nothing"). Disable only while the worker
          // hasn't produced a result yet, or when there's no SBOM at all
          // (skipped / never scanned).
          disabled={sheetDisabled}
        >
          {t("myApps.edit.cve.details")}
        </button>
        <button
          type="button"
          onClick={rescan}
          disabled={rescanning || status === "pending" || status === "scanning"}
          className="text-[11px] text-primary hover:underline disabled:text-ink-mute disabled:no-underline"
        >
          {rescanning ? t("common.loading") : t("myApps.edit.cve.rescan")}
        </button>
        {sbom?.scanned_at && (
          <span className="text-[10px] text-ink-mute">
            {t("myApps.edit.cve.lastScan", { date: formatDate(sbom.scanned_at) })}
          </span>
        )}
      </div>
      {sbom?.error_message && (
        <p className="mt-2 rounded-xl border border-danger bg-danger-container px-3 py-2 text-xs text-danger-on-container">
          {sbom.error_message}
        </p>
      )}
      <Sheet
        open={expanded}
        onClose={() => setExpanded(false)}
        size="wide"
        title={t("myApps.edit.cve.sheetTitle")}
        eyebrow={
          <>
            <span className="rounded-pill border border-outline-soft bg-surface-2 px-2 py-0.5 text-ink">
              v{apk.version_name}
            </span>
            <span className="opacity-60">·</span>
            <span>
              {totalCves > 0
                ? t("myApps.edit.cve.sheetFindings", { count: totalCves })
                : t("myApps.edit.cve.sheetClean")}
            </span>
          </>
        }
        footer={
          <Button
            size="md"
            variant="outlined"
            onClick={rescan}
            disabled={rescanning || status === "pending" || status === "scanning"}
          >
            {rescanning ? t("common.loading") : t("myApps.edit.cve.rescan")}
          </Button>
        }
      >
        {sbom ? <CveDetails sbom={sbom} /> : null}
      </Sheet>
    </div>
  );
}

function CveStatusPill({ status, totalCves }: { status: string; totalCves: number }) {
  const { t } = useTranslation();
  const label = t(`myApps.edit.cve.status.${status}`);
  let cls = "border-outline-soft text-ink-mute";
  if (status === "done") {
    cls = totalCves > 0
      ? "border-danger text-danger"
      : "border-primary text-primary";
  } else if (status === "failed") {
    cls = "border-danger text-danger";
  } else if (status === "pending" || status === "scanning") {
    cls = "border-primary text-primary";
  }
  return (
    <span
      className={cn(
        "rounded-pill border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        cls,
      )}
    >
      {label}
    </span>
  );
}

function SeverityChip({ severity, count }: { severity: CveSeverity; count: number }) {
  const tone: Record<CveSeverity, string> = {
    CRITICAL: "border-danger bg-danger-container text-danger-on-container",
    HIGH: "border-danger bg-danger-container/60 text-danger-on-container",
    MEDIUM: "border-warning bg-warning-container text-warning-on-container",
    LOW: "border-outline-soft bg-surface text-ink-soft",
    UNKNOWN: "border-outline-soft bg-surface text-ink-mute",
  };
  return (
    <span
      className={cn(
        "rounded-pill border px-1.5 py-0 text-[10px] font-mono tabular-nums",
        tone[severity],
      )}
      title={severity.toLowerCase()}
    >
      {severity.charAt(0)} {count}
    </span>
  );
}

function CveDetails({ sbom }: { sbom: SbomRead }) {
  const { t } = useTranslation();
  if (sbom.cves.length === 0) {
    return (
      <p className="rounded-xl bg-surface-2 px-3 py-3 text-sm italic text-ink-mute">
        {t("myApps.edit.cve.noFindings")}
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-outline-soft">
      <table className="w-full text-xs">
        <thead className="bg-surface-2 text-[10px] uppercase tracking-wider text-ink-mute">
          <tr>
            <th className="px-3 py-2 text-left">{t("myApps.edit.cve.col.cve")}</th>
            <th className="px-3 py-2 text-left">{t("myApps.edit.cve.col.severity")}</th>
            <th className="px-3 py-2 text-left">{t("myApps.edit.cve.col.package")}</th>
            <th className="px-3 py-2 text-left">{t("myApps.edit.cve.col.fixed")}</th>
          </tr>
        </thead>
        <tbody>
          {sbom.cves.map((c) => (
            <tr key={c.cve_id + (c.package_name || "")} className="border-t border-outline-soft">
              <td className="px-3 py-2 font-mono">
                <a
                  href={`https://nvd.nist.gov/vuln/detail/${encodeURIComponent(c.cve_id)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {c.cve_id}
                </a>
              </td>
              <td className="px-3 py-2">
                <SeverityChip severity={c.severity} count={c.cvss_score != null ? Math.round(c.cvss_score * 10) / 10 : 0} />
              </td>
              <td className="px-3 py-2">
                {c.package_name ? (
                  <>
                    <div className="font-mono">{c.package_name}</div>
                    {c.installed_version && (
                      <div className="text-[10px] text-ink-mute">{c.installed_version}</div>
                    )}
                  </>
                ) : (
                  <span className="text-ink-mute">—</span>
                )}
              </td>
              <td className="px-3 py-2">
                {c.fixed_version ? (
                  <span className="font-mono text-primary">{c.fixed_version}</span>
                ) : (
                  <span className="text-ink-mute">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


export default function ManageAppClient() {
  return (
    <AuthGuard requireUploader>
      <ManageAppInner />
    </AuthGuard>
  );
}
