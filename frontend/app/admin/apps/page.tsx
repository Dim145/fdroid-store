"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Eye,
  Package,
  PauseCircle,
  Pencil,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AppIcon } from "@/components/app-icon";
import { NsfwTag } from "@/components/nsfw-tag";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type Apk, type AppDetail } from "@/lib/api";
import { toast } from "@/lib/toast-store";
import { cn, formatBytes, formatDate } from "@/lib/utils";


type StatusKey = AppDetail["status"];
type FilterKey = "all" | StatusKey;


/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function AdminAppsPage() {
  return <AdminAppsPageInner />;
}

function AdminAppsPageInner() {
  const { t } = useTranslation();
  // The drawer is identified in the URL by package name (stable, shareable)
  // rather than app UUID — the URL ``?app=org.foo.bar`` survives renames,
  // index rebuilds, and works as a copy/pasted deeplink without leaking
  // internal IDs.
  //
  // We keep the *canonical* state in React (``openPkg``) rather than in
  // ``useSearchParams``: under ``output: "export"`` + ``trailingSlash``,
  // ``router.replace`` to the same pathname doesn't always notify
  // ``useSearchParams`` subscribers — which left a reloaded
  // ``?app=<pkg>`` URL unable to close the drawer (every Escape /
  // click-outside / X call fired ``router.replace`` to a no-op URL, and
  // the search-params hook never re-rendered).
  //
  // The URL is still kept in sync — but via ``history.replaceState``,
  // which is a synchronous DOM-level update unrelated to Next's router.
  const [openPkg, setOpenPkg] = useState<string | null>(null);
  const [apps, setApps] = useState<AppDetail[] | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [bulkBusy, setBulkBusy] = useState(false);

  // Pick up the URL value once the route mounts. We read ``window.location``
  // directly instead of ``useSearchParams`` because the latter is empty at
  // the first render tick under ``output: "export"`` (params are baked into
  // the URL, not into the prerendered HTML), and only fills in after
  // hydration — by which point we've already missed the chance to set
  // the initial state without an extra render.
  //
  // Also listen to ``popstate`` so the back/forward buttons restore the
  // drawer state instead of leaving the URL and the open state out of
  // sync.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => {
      const p = new URLSearchParams(window.location.search).get("app");
      setOpenPkg(p);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  // Map ``openPkg`` → app id once the list has loaded.
  const openId = useMemo(() => {
    if (!openPkg || !apps) return null;
    const hit = apps.find((a) => a.package_name === openPkg);
    return hit?.id ?? null;
  }, [openPkg, apps]);

  const setOpenId = useCallback(
    (id: string | null) => {
      const hit = id && apps ? apps.find((a) => a.id === id) : null;
      const nextPkg = hit ? hit.package_name : null;
      // Local state is the source of truth — flip it first so the
      // drawer closes on the very next render, regardless of whether
      // the URL update is observed by React.
      setOpenPkg(nextPkg);
      // Mirror to the URL for shareable / reloadable deeplinks. We use
      // the browser's history API directly so the change is a pure DOM
      // update, no Next.js navigation involved.
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        if (nextPkg) url.searchParams.set("app", nextPkg);
        else url.searchParams.delete("app");
        window.history.replaceState(null, "", url.toString());
      }
    },
    [apps],
  );

  async function refresh() {
    try {
      const data = await api.admin.listApps();
      setApps(data);
    } catch (e) {
      toast.error(t("admin.apps.loadFailed"), e instanceof Error ? e.message : undefined);
    }
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, []);

  // --- Derived state --------------------------------------------------
  const rows = apps ?? [];

  /** Apps with at least one APK awaiting review. We surface those in a
   *  prominent queue at the top so the admin doesn't have to dig. */
  const pendingApps = useMemo(
    () => rows.filter((a) => a.apks?.some((apk) => apk.status === "pending_review")),
    [rows],
  );

  const stats = useMemo(() => {
    return {
      total: rows.length,
      published: rows.filter((a) => a.status === "published").length,
      draft: rows.filter((a) => a.status === "draft").length,
      pendingReview: pendingApps.length,
      archived: rows.filter((a) => a.status === "archived").length,
    };
  }, [rows, pendingApps]);

  const visible = useMemo(() => {
    if (!apps) return null;
    const needle = q.trim().toLowerCase();
    let list = rows;
    if (filter !== "all") list = list.filter((a) => a.status === filter);
    if (needle) {
      list = list.filter(
        (a) =>
          a.name.toLowerCase().includes(needle) ||
          a.package_name.toLowerCase().includes(needle) ||
          (a.author_name && a.author_name.toLowerCase().includes(needle)),
      );
    }
    return list;
  }, [apps, rows, filter, q]);

  const openApp = useMemo(
    () => (openId ? rows.find((a) => a.id === openId) ?? null : null),
    [rows, openId],
  );

  // --- Mutations ------------------------------------------------------
  async function publishApk(apkId: string) {
    try {
      await api.admin.publishApk(apkId);
      toast.success(t("admin.apps.toast.apkPublished"));
      await refresh();
    } catch (e) {
      toast.error(t("admin.apps.toast.apkPublishFailed"), e instanceof Error ? e.message : undefined);
    }
  }
  async function rejectApk(apkId: string, reason: string) {
    try {
      await api.admin.rejectApk(apkId, reason);
      toast.success(t("admin.apps.toast.apkRejected"));
      await refresh();
    } catch (e) {
      toast.error(t("admin.apps.toast.apkRejectFailed"), e instanceof Error ? e.message : undefined);
    }
  }
  async function setStatus(appId: string, status: StatusKey) {
    try {
      await api.admin.updateApp(appId, { status });
      toast.success(t("admin.apps.toast.statusUpdated"));
      await refresh();
    } catch (e) {
      toast.error(t("admin.apps.toast.statusFailed"), e instanceof Error ? e.message : undefined);
    }
  }
  async function rescanApp(appId: string, name: string) {
    try {
      const r = await api.admin.rescanApp(appId);
      toast.success(
        t("admin.apps.toast.rescanned", {
          name,
          apks: r.rescanned_apks,
          icons: r.icons_refreshed,
          errors: r.failed.length,
        }),
      );
      await refresh();
    } catch (e) {
      toast.error(t("admin.apps.toast.rescanFailed"), e instanceof Error ? e.message : undefined);
    }
  }
  async function rescanAll() {
    if (!confirm(t("admin.apps.rescanAllConfirm"))) return;
    setBulkBusy(true);
    try {
      const r = await api.admin.rescanAll();
      toast.success(t("admin.apps.toast.rescanAll", { apks: r.rescanned_apks, icons: r.icons_refreshed }));
      await refresh();
    } catch (e) {
      toast.error(t("admin.apps.toast.rescanFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="space-y-8 pb-12">
      {/* ---------- Hero — moderation desk -------------------------- */}
      <header className="relative overflow-hidden rounded-3xl border border-outline-soft bg-surface px-6 py-8 md:px-10 md:py-10">
        {/* Faint horizontal scanlines — the "console / control room"
            texture, different from /admin/users (dots) and
            /admin/categories (diagonal hatching). */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, rgb(var(--ink)) 0, rgb(var(--ink)) 1px, transparent 1px, transparent 3px)",
          }}
        />
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div className="min-w-0">
            <div className="eyebrow">{t("admin.eyebrow")}</div>
            <h1 className="mt-1 text-4xl font-bold tracking-tight text-ink md:text-5xl">
              {t("admin.apps.title")}
            </h1>
            <p className="mt-2 max-w-prose text-ink-soft">{t("admin.apps.subtitle")}</p>
          </div>
          <Button variant="outlined" onClick={rescanAll} disabled={bulkBusy}>
            <RefreshCw className={bulkBusy ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            {bulkBusy ? t("admin.apps.rescanning") : t("admin.apps.rescanAll")}
          </Button>
        </div>

        <dl className="relative mt-8 grid grid-cols-2 gap-6 md:grid-cols-4 xl:grid-cols-5">
          <Stat label={t("admin.apps.stats.total")} value={stats.total} />
          <Stat label={t("admin.apps.stats.published")} value={stats.published} accent="primary" />
          <Stat label={t("admin.apps.stats.draft")} value={stats.draft} accent="mute" />
          <Stat label={t("admin.apps.stats.pending")} value={stats.pendingReview} accent={stats.pendingReview > 0 ? "accent" : "mute"} />
          <Stat label={t("admin.apps.stats.archived")} value={stats.archived} accent="mute" />
        </dl>
      </header>

      {/* ---------- Pending review queue --------------------------- */}
      {pendingApps.length > 0 && (
        <PendingQueue
          apps={pendingApps}
          onPublish={publishApk}
          onReject={rejectApk}
        />
      )}

      {/* ---------- Filter bar ------------------------------------ */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-mute" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("admin.apps.search")}
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <FilterChip label={t("admin.apps.filter.all")} active={filter === "all"} onClick={() => setFilter("all")} count={stats.total} />
          <FilterChip label={t("admin.apps.filter.published")} active={filter === "published"} onClick={() => setFilter("published")} count={stats.published} />
          <FilterChip label={t("admin.apps.filter.draft")} active={filter === "draft"} onClick={() => setFilter("draft")} count={stats.draft} />
          <FilterChip label={t("admin.apps.filter.archived")} active={filter === "archived"} onClick={() => setFilter("archived")} count={stats.archived} />
          <FilterChip label={t("admin.apps.filter.rejected")} active={filter === "rejected"} onClick={() => setFilter("rejected")} count={rows.filter((a) => a.status === "rejected").length} />
        </div>
      </div>

      {/* ---------- List ----------------------------------------- */}
      {visible === null ? (
        <SkeletonList />
      ) : visible.length === 0 ? (
        <EmptyState
          isFiltered={!!q || filter !== "all"}
          onReset={() => { setQ(""); setFilter("all"); }}
        />
      ) : (
        <ul className="space-y-2">
          {visible.map((a, i) => (
            <AppRow
              key={a.id}
              app={a}
              index={i}
              selected={a.id === openId}
              onOpen={() => setOpenId(a.id)}
            />
          ))}
        </ul>
      )}

      {/* ---------- Drawer --------------------------------------- */}
      <Sheet open={openApp != null} onClose={() => setOpenId(null)}>
        {openApp && (
          <AppDrawer
            app={openApp}
            onClose={() => setOpenId(null)}
            onPublishApk={publishApk}
            onRejectApk={rejectApk}
            onSetStatus={(s) => setStatus(openApp.id, s)}
            onRescan={() => rescanApp(openApp.id, openApp.name)}
          />
        )}
      </Sheet>
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Pending APK queue                                                          */
/* -------------------------------------------------------------------------- */

function PendingQueue({
  apps,
  onPublish,
  onReject,
}: {
  apps: AppDetail[];
  onPublish: (apkId: string) => Promise<void>;
  onReject: (apkId: string, reason: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  // Flatten: one entry per pending APK with its parent app context.
  const items = useMemo(
    () =>
      apps.flatMap((app) =>
        (app.apks ?? [])
          .filter((apk) => apk.status === "pending_review")
          .map((apk) => ({ app, apk })),
      ),
    [apps],
  );
  return (
    <section className="relative overflow-hidden rounded-3xl border-2 border-accent/40 bg-accent-container/20 p-5">
      {/* Animated accent shimmer along the top edge — signals urgency */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden"
      >
        <span className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-accent to-transparent" style={{ animation: "shimmer 2.4s linear infinite" }} />
      </div>
      <div className="mb-4 flex items-center gap-2 text-accent-on-container">
        <AlertTriangle className="h-5 w-5" />
        <h2 className="text-lg font-bold tracking-tight">
          {t("admin.apps.pendingTitle", { count: items.length })}
        </h2>
      </div>
      <ul className="space-y-2">
        {items.map(({ app, apk }) => (
          <PendingRow key={apk.id} app={app} apk={apk} onPublish={onPublish} onReject={onReject} />
        ))}
      </ul>
      <style jsx>{`
        @keyframes shimmer {
          from { transform: translateX(-100%); }
          to   { transform: translateX(400%); }
        }
      `}</style>
    </section>
  );
}

function PendingRow({
  app,
  apk,
  onPublish,
  onReject,
}: {
  app: AppDetail;
  apk: Apk;
  onPublish: (apkId: string) => Promise<void>;
  onReject: (apkId: string, reason: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"pub" | "rej" | null>(null);

  async function doPublish() {
    setBusy("pub");
    try { await onPublish(apk.id); } finally { setBusy(null); }
  }
  async function doReject() {
    setBusy("rej");
    try {
      await onReject(apk.id, reason.trim() || t("admin.apps.rejectDefault"));
      setRejecting(false);
      setReason("");
    } finally { setBusy(null); }
  }

  return (
    <li className="rounded-2xl border border-outline-soft bg-surface p-3">
      <div className="flex flex-wrap items-center gap-3">
        <AppIcon iconPath={app.icon_path} name={app.name} size={40} shape="rounded" version={app.updated_at} mediaToken={app.media_token} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-semibold text-ink">{app.name}</span>
            <Badge variant="accent" className="font-mono text-[10px]">
              v{apk.version_name} ({apk.version_code})
            </Badge>
          </div>
          <div className="truncate font-mono text-[11px] text-ink-mute">{app.package_name}</div>
        </div>
        <div className="hidden text-right md:block">
          <div className="text-[10px] uppercase tracking-wider text-ink-mute">{t("admin.apps.pending.uploaded")}</div>
          <div className="font-mono text-xs text-ink-soft">{formatDate(apk.created_at)}</div>
        </div>
        {!rejecting && (
          <div className="flex gap-2">
            <Button size="sm" variant="filled" onClick={doPublish} disabled={busy != null}>
              <CheckCircle2 className="h-3.5 w-3.5" /> {busy === "pub" ? t("common.saving") : t("admin.apps.buttons.publish")}
            </Button>
            <Button size="sm" variant="outlined" onClick={() => setRejecting(true)} disabled={busy != null}>
              <X className="h-3.5 w-3.5" /> {t("admin.apps.buttons.reject")}
            </Button>
          </div>
        )}
      </div>
      {rejecting && (
        <div className="mt-3 rounded-xl bg-surface-2 p-3">
          <label className="text-[10px] uppercase tracking-wider text-ink-mute">{t("admin.apps.rejectReasonLabel")}</label>
          <Input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("admin.apps.rejectPlaceholder")}
            className="mt-1"
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="danger" onClick={doReject} disabled={busy != null}>
              {busy === "rej" ? t("common.saving") : t("admin.apps.buttons.confirmReject")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setRejecting(false); setReason(""); }}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}


/* -------------------------------------------------------------------------- */
/*  Filter chip                                                                */
/* -------------------------------------------------------------------------- */

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-2 rounded-pill border px-3.5 py-1.5 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-fg shadow-e1"
          : "border-outline-soft bg-surface text-ink-soft hover:border-outline hover:bg-surface-2 hover:text-ink",
      )}
    >
      {label}
      <span
        className={cn(
          "rounded-pill px-1.5 py-px font-mono text-[10px] tabular-nums",
          active ? "bg-primary-fg/15 text-primary-fg" : "bg-surface-2 text-ink-mute",
        )}
      >
        {count}
      </span>
    </button>
  );
}


/* -------------------------------------------------------------------------- */
/*  App row                                                                    */
/* -------------------------------------------------------------------------- */

function StatusPill({ status }: { status: StatusKey }) {
  const { t } = useTranslation();
  const cfg: Record<StatusKey, { variant: "primary" | "soft" | "outline" | "accent"; cls?: string }> = {
    draft: { variant: "outline" },
    pending_review: { variant: "accent" },
    published: { variant: "primary" },
    rejected: { variant: "soft", cls: "text-danger" },
    archived: { variant: "soft" },
  };
  const c = cfg[status];
  return (
    <Badge variant={c.variant} className={cn("text-[10px] uppercase tracking-wider", c.cls)}>
      {t(`admin.apps.filter.${status === "pending_review" ? "pending" : status}`)}
    </Badge>
  );
}

function AppRow({
  app,
  index,
  selected,
  onOpen,
}: {
  app: AppDetail;
  index: number;
  selected: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const pendingCount = (app.apks ?? []).filter((a) => a.status === "pending_review").length;
  return (
    <li
      style={{ animationDelay: `${Math.min(index, 9) * 35}ms` }}
      className={cn(
        "group flex animate-fade-up flex-wrap items-center gap-4 rounded-2xl border bg-surface px-4 py-3 transition-all",
        selected
          ? "border-primary shadow-e2 ring-2 ring-primary/15"
          : "border-outline-soft hover:border-outline hover:shadow-e1",
      )}
    >
      <div className="relative shrink-0">
        <AppIcon iconPath={app.icon_path} name={app.name} size={44} shape="rounded" version={app.updated_at} mediaToken={app.media_token} />
        <NsfwTag active={app.is_nsfw} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-base font-semibold text-ink">{app.name}</span>
          {pendingCount > 0 && (
            <Badge variant="accent" className="text-[10px] uppercase tracking-wider">
              {t("admin.apps.row.pendingApks", { count: pendingCount })}
            </Badge>
          )}
          {app.visibility === "private" && (
            <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
              {t("admin.apps.filter.private")}
            </Badge>
          )}
        </div>
        <div className="truncate font-mono text-[11px] text-ink-mute">
          {app.package_name}
          {app.author_name && <> · {app.author_name}</>}
        </div>
      </div>
      <div className="hidden text-right md:block">
        <div className="text-[10px] uppercase tracking-wider text-ink-mute">{t("admin.apps.row.updated")}</div>
        <div className="font-mono text-xs text-ink-soft">{formatDate(app.updated_at)}</div>
      </div>
      <StatusPill status={app.status} />
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex h-9 items-center gap-1 rounded-pill border border-outline-soft bg-surface px-3 text-xs font-medium text-ink-soft transition-colors hover:border-primary hover:bg-primary-container/40 hover:text-primary"
      >
        {t("admin.apps.row.manage")} <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2.4} />
      </button>
    </li>
  );
}


/* -------------------------------------------------------------------------- */
/*  Drawer                                                                     */
/* -------------------------------------------------------------------------- */

function Sheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Remember which element opened the sheet so we can restore focus
  // when it closes — without this, the user's keyboard focus ends up
  // on ``<body>`` after dismissal and the next Tab starts from the top
  // of the page.
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Focus trap. When the sheet opens, grab the first focusable element
  // inside the panel; when the user tabs out, loop back. When it
  // closes, give focus back to whatever the user was on before.
  //
  // Implemented at this level rather than via a library because we
  // only need the bare minimum: ``Tab`` / ``Shift+Tab`` wrapping, plus
  // the focus restoration on close. The dialog already handles
  // Escape + click-outside.
  useEffect(() => {
    if (!open) return;
    lastFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    function focusables(): HTMLElement[] {
      const root = panelRef.current;
      if (!root) return [];
      const sel =
        'a[href],area[href],button:not([disabled]),' +
        'input:not([disabled]):not([type="hidden"]),' +
        'select:not([disabled]),textarea:not([disabled]),' +
        '[tabindex]:not([tabindex="-1"])';
      return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
    }

    // Defer one tick so React has time to render the panel children.
    const raf = requestAnimationFrame(() => {
      const first = focusables()[0];
      first?.focus();
    });

    function onTab(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !panelRef.current?.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !panelRef.current?.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onTab);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onTab);
      // Restore caller's focus on close so screen-reader users don't
      // get parked at the top of the page.
      const back = lastFocusedRef.current;
      if (back && document.contains(back)) {
        back.focus();
      }
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        // Bumped from ``bg-black/40`` + ``backdrop-blur-[2px]`` — at
        // the previous opacity the moderation list behind the sheet
        // was still legible enough that the modal didn't read as
        // *modal*. /60 + a stronger blur gives the standard "the
        // rest of the page is paused" cue without going opaque.
        className="absolute inset-0 animate-fade-in bg-black/60 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        // ``tabIndex={-1}`` lets ``ref.focus()`` work as a fallback
        // when no interactive child exists yet (e.g. during the
        // initial render before children mount).
        tabIndex={-1}
        className="absolute right-0 top-0 flex h-full w-[min(560px,100vw)] animate-slide-in-right flex-col overflow-y-auto border-l border-outline-soft bg-surface shadow-e3"
      >
        {children}
      </div>
    </div>
  );
}


function AppDrawer({
  app,
  onClose,
  onPublishApk,
  onRejectApk,
  onSetStatus,
  onRescan,
}: {
  app: AppDetail;
  onClose: () => void;
  onPublishApk: (apkId: string) => Promise<void>;
  onRejectApk: (apkId: string, reason: string) => Promise<void>;
  onSetStatus: (status: StatusKey) => Promise<void>;
  onRescan: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <header className="sticky top-0 z-10 flex items-start gap-3 border-b border-outline-soft bg-surface/90 px-6 py-4 backdrop-blur">
        <div className="relative shrink-0">
          <AppIcon iconPath={app.icon_path} name={app.name} size={56} shape="rounded" version={app.updated_at} mediaToken={app.media_token} />
          <NsfwTag active={app.is_nsfw} size="md" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-bold tracking-tight text-ink">{app.name}</h2>
          <p className="truncate font-mono text-[11px] text-ink-mute">{app.package_name}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <StatusPill status={app.status} />
            <Badge variant={app.visibility === "private" ? "accent" : "outline"} className="text-[10px] uppercase tracking-wider">
              {app.visibility}
            </Badge>
            {app.author_name && (
              <span className="text-[10px] uppercase tracking-wider text-ink-mute">
                · {app.author_name}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-pill text-ink-mute hover:bg-surface-2 hover:text-ink"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="space-y-6 px-6 py-6">
        {/* Quick actions strip */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <ActionTile
            icon={<Eye className="h-4 w-4" />}
            label={t("admin.apps.drawer.viewPublic")}
            href={`/apps/${app.package_name}`}
          />
          <ActionTile
            icon={<Pencil className="h-4 w-4" />}
            label={t("admin.apps.drawer.fullEdit")}
            href={`/my-apps/${app.id}`}
          />
          <ActionTile
            icon={<RefreshCw className={busy ? "h-4 w-4 animate-spin" : "h-4 w-4"} />}
            label={busy ? t("admin.apps.drawer.rescanning") : t("admin.apps.drawer.rescan")}
            onClick={async () => { setBusy(true); try { await onRescan(); } finally { setBusy(false); } }}
            disabled={busy}
          />
        </div>

        {/* Lifecycle */}
        <DrawerSection
          icon={<Sparkles className="h-4 w-4" />}
          title={t("admin.apps.drawer.lifecycle")}
          subtitle={t("admin.apps.drawer.lifecycleBody")}
        >
          <LifecyclePicker current={app.status} onChange={onSetStatus} />
        </DrawerSection>

        {/* Versions */}
        <DrawerSection
          icon={<Package className="h-4 w-4" />}
          title={t("admin.apps.drawer.versions", { count: app.apks?.length ?? 0 })}
          subtitle={t("admin.apps.drawer.versionsBody")}
        >
          <VersionList
            apks={app.apks ?? []}
            onPublish={onPublishApk}
            onReject={onRejectApk}
          />
        </DrawerSection>

        {/* Quick details */}
        <DrawerSection
          icon={<ShieldAlert className="h-4 w-4" />}
          title={t("admin.apps.drawer.signature")}
        >
          {app.locked_signer_sha256 ? (
            <code className="block break-all rounded-xl border border-outline-soft bg-surface-2 px-3 py-2 font-mono text-[11px] text-ink-soft">
              {app.locked_signer_sha256}
            </code>
          ) : (
            <p className="text-xs italic text-ink-mute">{t("admin.apps.drawer.signatureUnset")}</p>
          )}
        </DrawerSection>
      </div>
    </>
  );
}


function DrawerSection({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <header className="mb-3 flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-ink-soft">
          {icon}
        </span>
        <div>
          <h3 className="text-sm font-semibold tracking-tight text-ink">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs leading-relaxed text-ink-mute">{subtitle}</p>}
        </div>
      </header>
      {children}
    </section>
  );
}


function ActionTile({
  icon,
  label,
  href,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const inner = (
    <span
      className={cn(
        "flex h-full flex-col items-start justify-between gap-2 rounded-xl border border-outline-soft bg-surface px-3 py-2.5 text-xs font-medium transition-colors",
        disabled
          ? "opacity-60"
          : "hover:border-primary hover:bg-primary-container/30 hover:text-primary",
      )}
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-pill bg-surface-2 text-ink-soft">
        {icon}
      </span>
      <span className="text-sm">{label}</span>
    </span>
  );
  if (href) {
    return <Link href={href}>{inner}</Link>;
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="text-left">
      {inner}
    </button>
  );
}


function LifecyclePicker({
  current,
  onChange,
}: {
  current: StatusKey;
  onChange: (s: StatusKey) => Promise<void>;
}) {
  const { t } = useTranslation();
  const lanes: { key: StatusKey; label: string; icon: React.ReactNode }[] = [
    { key: "draft", label: t("admin.apps.filter.draft"), icon: <PauseCircle className="h-3.5 w-3.5" /> },
    { key: "published", label: t("admin.apps.filter.published"), icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
    { key: "archived", label: t("admin.apps.filter.archived"), icon: <Package className="h-3.5 w-3.5" /> },
  ];
  const [busy, setBusy] = useState<StatusKey | null>(null);
  return (
    <div className="grid grid-cols-3 gap-1.5 rounded-2xl border border-outline-soft bg-surface-2/50 p-1">
      {lanes.map((l) => {
        const active = current === l.key;
        return (
          <button
            key={l.key}
            type="button"
            disabled={active || busy != null}
            onClick={async () => { setBusy(l.key); try { await onChange(l.key); } finally { setBusy(null); } }}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition-colors",
              active
                ? "bg-surface text-ink shadow-e1"
                : "text-ink-soft hover:bg-surface hover:text-ink",
            )}
          >
            {busy === l.key ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              l.icon
            )}
            {l.label}
          </button>
        );
      })}
    </div>
  );
}


function VersionList({
  apks,
  onPublish,
  onReject,
}: {
  apks: Apk[];
  onPublish: (apkId: string) => Promise<void>;
  onReject: (apkId: string, reason: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  // Newest first.
  const sorted = useMemo(() => [...apks].sort((a, b) => b.version_code - a.version_code), [apks]);
  if (sorted.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-outline-soft bg-surface-2/30 px-4 py-6 text-center text-xs italic text-ink-mute">
        {t("admin.apps.drawer.noVersions")}
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {sorted.map((apk) => (
        <VersionRow key={apk.id} apk={apk} onPublish={onPublish} onReject={onReject} />
      ))}
    </ul>
  );
}


function VersionRow({
  apk,
  onPublish,
  onReject,
}: {
  apk: Apk;
  onPublish: (apkId: string) => Promise<void>;
  onReject: (apkId: string, reason: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const tone =
    apk.status === "published"
      ? "border-l-primary"
      : apk.status === "pending_review"
        ? "border-l-accent"
        : apk.status === "rejected"
          ? "border-l-danger"
          : "border-l-outline";

  const statusLabel =
    apk.status === "pending_review"
      ? t("admin.apps.filter.pending")
      : apk.status === "uploaded" || apk.status === "parsed"
        ? apk.status
        : t(`admin.apps.filter.${apk.status}`);

  return (
    <li
      className={cn(
        "overflow-hidden rounded-xl border border-outline-soft bg-surface",
        tone,
        "border-l-2",
      )}
    >
      <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono text-sm font-semibold text-ink">v{apk.version_name}</span>
            <span className="font-mono text-[11px] text-ink-mute">({apk.version_code})</span>
            <Badge
              variant={
                apk.status === "published" ? "primary"
                  : apk.status === "pending_review" ? "accent"
                    : "soft"
              }
              className="text-[10px] uppercase tracking-wider"
            >
              {statusLabel}
            </Badge>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-ink-mute">
            {formatBytes(apk.size_bytes)} · SDK {apk.min_sdk ?? "?"}–{apk.target_sdk ?? "?"}
            {apk.published_at && <> · {t("admin.apps.drawer.publishedOn", { when: formatDate(apk.published_at) })}</>}
          </div>
          {apk.rejection_reason && (
            <p className="mt-1 text-[11px] italic text-danger">{apk.rejection_reason}</p>
          )}
        </div>
        {apk.status === "pending_review" && !rejecting && (
          <div className="flex gap-1.5">
            <Button size="sm" variant="filled" onClick={() => onPublish(apk.id)}>
              <CheckCircle2 className="h-3.5 w-3.5" /> {t("admin.apps.buttons.publish")}
            </Button>
            <Button size="sm" variant="outlined" onClick={() => setRejecting(true)}>
              <X className="h-3.5 w-3.5" /> {t("admin.apps.buttons.reject")}
            </Button>
          </div>
        )}
      </div>
      {rejecting && (
        <div className="border-t border-outline-soft bg-surface-2 px-3 py-2.5">
          <label className="text-[10px] uppercase tracking-wider text-ink-mute">
            {t("admin.apps.rejectReasonLabel")}
          </label>
          <Input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("admin.apps.rejectPlaceholder")}
            className="mt-1"
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button
              size="sm"
              variant="danger"
              onClick={async () => {
                await onReject(apk.id, reason.trim() || t("admin.apps.rejectDefault"));
                setRejecting(false);
                setReason("");
              }}
            >
              <Trash2 className="h-3.5 w-3.5" /> {t("admin.apps.buttons.confirmReject")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setRejecting(false); setReason(""); }}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}


/* -------------------------------------------------------------------------- */
/*  Stat + skeleton + empty                                                    */
/* -------------------------------------------------------------------------- */

function Stat({
  label,
  value,
  accent = "ink",
}: {
  label: string;
  value: number;
  accent?: "ink" | "primary" | "accent" | "danger" | "mute";
}) {
  const [display, setDisplay] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    const from = prev.current;
    const to = value;
    prev.current = to;
    if (from === to) { setDisplay(to); return; }
    const duration = 650;
    const start = performance.now();
    let raf = 0;
    function tick(now: number) {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  const color = {
    ink: "text-ink",
    primary: "text-primary",
    accent: "text-accent",
    danger: "text-danger",
    mute: "text-ink-mute",
  }[accent];

  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.18em] text-ink-mute">{label}</dt>
      <dd className={cn("nums-no-slash mt-1 text-3xl font-bold tabular-nums tracking-tight md:text-4xl", color)}>
        {display}
      </dd>
    </div>
  );
}


function SkeletonList() {
  return (
    <ul className="space-y-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <li
          key={i}
          className="flex items-center gap-4 rounded-2xl border border-outline-soft bg-surface px-4 py-3"
        >
          <div className="h-11 w-11 animate-pulse rounded-2xl bg-surface-2" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-32 animate-pulse rounded-pill bg-surface-2" />
            <div className="h-2 w-48 animate-pulse rounded-pill bg-surface-2" />
          </div>
        </li>
      ))}
    </ul>
  );
}


function EmptyState({
  isFiltered,
  onReset,
}: {
  isFiltered: boolean;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-outline-soft bg-surface-2/30 px-6 py-16 text-center">
      <div className="text-3xl">📦</div>
      <p className="text-sm font-medium text-ink">
        {isFiltered ? t("admin.apps.emptyFilter") : t("admin.apps.empty")}
      </p>
      {isFiltered && (
        <Button variant="outlined" size="sm" onClick={onReset}>
          {t("admin.apps.clearFilters")}
        </Button>
      )}
    </div>
  );
}
