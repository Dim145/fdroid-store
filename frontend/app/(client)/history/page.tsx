"use client";

import { ArrowUpRight, Check, Download, Library, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AppIcon } from "@/components/app-icon";
import { AuthGuard } from "@/components/auth-guard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, type DownloadHistoryItem } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { cn, formatBytes, formatDate } from "@/lib/utils";


function HistoryInner() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const [items, setItems] = useState<DownloadHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.downloadHistory()
      .then((res) => { if (!cancelled) setItems(res.items); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t("history.loadFailed")); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Derived state --------------------------------------------------
  const rows = items ?? [];
  const stats = useMemo(() => {
    const totalDownloads = rows.reduce((s, i) => s + i.download_count, 0);
    const totalBytes = rows.reduce((s, i) => s + i.bytes_total, 0);
    const updatable = rows.filter((i) => i.has_update_available);
    // Earliest "last_downloaded_at" → proxy for "since when have you
    // been collecting". Not exact (we don't record the first download
    // separately), but it's an honest stand-in for the narrative.
    const earliest = rows
      .map((i) => i.last_downloaded_at)
      .filter(Boolean)
      .sort()[0] as string | undefined;
    return {
      apps: rows.length,
      downloads: totalDownloads,
      bytes: totalBytes,
      updatable: updatable.length,
      earliest,
    };
  }, [rows]);

  const updatable = useMemo(
    () => rows.filter((i) => i.has_update_available),
    [rows],
  );
  // "Up to date" — sort by last_downloaded_at desc for a friendly ordering.
  const collected = useMemo(
    () => rows
      .filter((i) => !i.has_update_available)
      .sort((a, b) => {
        const ad = a.last_downloaded_at ?? "";
        const bd = b.last_downloaded_at ?? "";
        return bd.localeCompare(ad);
      }),
    [rows],
  );

  // Narrative line ("You've collected X apps · Y downloads · since DATE")
  const intro = useMemo(() => {
    if (!user) return null;
    if (rows.length === 0) return null;
    const since = stats.earliest
      ? new Date(stats.earliest).toLocaleDateString(i18n.language, {
          month: "long",
          year: "numeric",
        })
      : null;
    return t("history.heroIntro", {
      name: user.full_name?.split(" ")[0] || user.username,
      apps: stats.apps,
      downloads: stats.downloads,
      since: since || t("history.heroIntroSinceUnknown"),
    });
  }, [user, rows.length, stats.apps, stats.downloads, stats.earliest, i18n.language, t]);

  return (
    <div className="space-y-8 pb-12">
      {/* ---------- Hero — warm radial mesh -------------------- */}
      <header className="relative overflow-hidden rounded-3xl border border-outline-soft bg-surface px-6 py-9 md:px-10 md:py-12">
        {/* Soft, layered radial blobs. Distinct from the linear textures
            on admin pages — this is a personal page, the feel should
            be luminous and warm. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage: [
              "radial-gradient(60% 70% at 0% 0%, rgb(var(--primary) / 0.18), transparent 60%)",
              "radial-gradient(40% 60% at 100% 0%, rgb(var(--accent) / 0.15), transparent 65%)",
              "radial-gradient(50% 60% at 50% 110%, rgb(var(--primary) / 0.08), transparent 60%)",
            ].join(", "),
          }}
        />
        {/* Faint paper grain */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.03] mix-blend-multiply"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, rgb(var(--ink)) 1px, transparent 0)",
            backgroundSize: "5px 5px",
          }}
        />
        <div className="relative">
          <div className="eyebrow flex items-center gap-2">
            <Library className="h-3.5 w-3.5" /> {t("history.eyebrow")}
          </div>
          <h1 className="mt-2 text-4xl font-bold leading-tight tracking-tight text-ink md:text-5xl">
            {t("history.title")}
          </h1>
          {intro && (
            <p className="mt-3 max-w-2xl text-base text-ink-soft md:text-lg">
              {intro}
            </p>
          )}
          {!intro && (
            <p className="mt-3 max-w-2xl text-ink-soft">{t("history.subtitle")}</p>
          )}
        </div>

        {/* Stats — only when we have data. Numbers anim from 0. */}
        {rows.length > 0 && (
          <dl className="relative mt-8 grid grid-cols-2 gap-6 md:grid-cols-4">
            <Stat label={t("history.stats.apps")} value={stats.apps} />
            <Stat label={t("history.stats.downloads")} value={stats.downloads} accent="primary" />
            <Stat label={t("history.stats.updatesAvailable")} value={stats.updatable} accent={stats.updatable > 0 ? "accent" : "mute"} />
            <BytesStat label={t("history.stats.totalFetched")} bytes={stats.bytes} />
          </dl>
        )}
      </header>

      {error && (
        <p className="rounded-2xl border border-danger bg-danger-container px-4 py-3 text-sm text-danger-on-container">
          {error}
        </p>
      )}

      {items === null ? (
        <SkeletonShelf />
      ) : rows.length === 0 ? (
        <EmptyShelf />
      ) : (
        <>
          {/* ---------- Updates section --------------------- */}
          {updatable.length > 0 && (
            <section>
              <SectionHeader
                icon={<Sparkles className="h-4 w-4" />}
                title={t("history.updatesSection")}
                subtitle={t("history.updatesSubtitle", { count: updatable.length })}
                tone="accent"
              />
              <ul className="grid gap-3 sm:grid-cols-2">
                {updatable.map((it, i) => (
                  <UpdateCard key={it.app_id} item={it} index={i} />
                ))}
              </ul>
            </section>
          )}

          {/* ---------- Up to date list --------------------- */}
          {collected.length > 0 && (
            <section>
              <SectionHeader
                icon={<Check className="h-4 w-4" />}
                title={t("history.shelfSection")}
                subtitle={t("history.shelfSubtitle", { count: collected.length })}
                tone="primary"
              />
              <ul className="space-y-2">
                {collected.map((it, i) => (
                  <ShelfRow key={it.app_id} item={it} index={i} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {/* Footnote — keeps the old explanation but styled smaller, italic */}
      <p className="mx-auto max-w-prose rounded-2xl border border-dashed border-outline-soft bg-surface-2/30 px-5 py-3 text-center text-xs italic leading-relaxed text-ink-mute">
        <strong className="font-semibold not-italic text-ink-soft">
          {t("history.whyNoInstalled")}
        </strong>{" "}
        {t("history.whyNoInstalledBody")}
      </p>
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Section header                                                             */
/* -------------------------------------------------------------------------- */

function SectionHeader({
  icon,
  title,
  subtitle,
  tone = "primary",
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  tone?: "primary" | "accent";
}) {
  const dotColor =
    tone === "accent"
      ? "bg-accent"
      : "bg-primary";
  return (
    <header className="mb-3 flex items-center gap-3">
      <span className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-pill text-white shadow-e1",
        dotColor,
      )}>
        {icon}
      </span>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>
        {subtitle && <p className="text-xs text-ink-mute">{subtitle}</p>}
      </div>
    </header>
  );
}


/* -------------------------------------------------------------------------- */
/*  Update card (large)                                                        */
/* -------------------------------------------------------------------------- */

function UpdateCard({ item, index }: { item: DownloadHistoryItem; index: number }) {
  const { t } = useTranslation();
  return (
    <li
      style={{ animationDelay: `${Math.min(index, 9) * 50}ms` }}
      className="group relative isolate animate-fade-up overflow-hidden rounded-3xl border-2 border-accent/40 bg-surface p-5 shadow-e1 transition-all hover:border-accent hover:shadow-e2"
    >
      {/* Pulsing dot at top-right — signals "new" without being loud */}
      <span
        aria-hidden
        className="absolute right-4 top-4 flex h-2 w-2"
      >
        <span className="absolute h-full w-full animate-ping rounded-full bg-accent/60" />
        <span className="relative h-2 w-2 rounded-full bg-accent" />
      </span>

      <div className="flex items-start gap-4">
        <AppIcon
          iconPath={item.icon_path}
          name={item.app_name}
          size={64}
          className="shrink-0 shadow-e2 transition-transform group-hover:scale-[1.04]"
        />
        <div className="min-w-0 flex-1">
          <Link
            href={`/apps/${encodeURIComponent(item.package_name)}`}
            className="block truncate text-lg font-bold tracking-tight text-ink hover:text-primary"
          >
            {item.app_name}
          </Link>
          <div className="truncate font-mono text-[11px] text-ink-mute">
            {item.package_name}
          </div>
        </div>
      </div>

      {/* Version delta — the headline of an update card */}
      <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-2xl bg-surface-2/60 px-4 py-3">
        <div className="text-left">
          <div className="text-[10px] uppercase tracking-wider text-ink-mute">
            {t("history.youHave")}
          </div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-ink-soft line-through decoration-ink-mute/50">
            v{item.last_apk_version_name ?? "?"}
          </div>
        </div>
        <ArrowUpRight className="h-4 w-4 shrink-0 text-accent" strokeWidth={2.2} />
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-accent-on-container">
            {t("history.available")}
          </div>
          <div className="mt-0.5 font-mono text-sm font-bold text-accent">
            v{item.latest_apk_version_name ?? "?"}
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-end justify-between gap-3">
        <div className="text-[11px] text-ink-mute">
          {item.last_downloaded_at && (
            <span>{t("history.lastFetched", { date: formatDate(item.last_downloaded_at) })}</span>
          )}
        </div>
        <Button asChild variant="filled" size="sm">
          <Link href={`/apps/${encodeURIComponent(item.package_name)}`}>
            <Download className="h-3.5 w-3.5" /> {t("history.update")}
          </Link>
        </Button>
      </div>
    </li>
  );
}


/* -------------------------------------------------------------------------- */
/*  Shelf row (up-to-date)                                                     */
/* -------------------------------------------------------------------------- */

function ShelfRow({ item, index }: { item: DownloadHistoryItem; index: number }) {
  const { t } = useTranslation();
  return (
    <li
      style={{ animationDelay: `${Math.min(index, 9) * 30}ms` }}
      className="group flex animate-fade-up flex-wrap items-center gap-4 rounded-2xl border border-outline-soft bg-surface px-4 py-3 transition-all hover:border-outline hover:shadow-e1"
    >
      <AppIcon
        iconPath={item.icon_path}
        name={item.app_name}
        size={48}
        className="shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <Link
            href={`/apps/${encodeURIComponent(item.package_name)}`}
            className="truncate text-base font-semibold text-ink hover:text-primary"
          >
            {item.app_name}
          </Link>
          <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-wider">
            v{item.last_apk_version_name ?? "?"}
          </Badge>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-mute">
          <span className="truncate font-mono">{item.package_name}</span>
          {item.last_downloaded_at && (
            <>
              <span aria-hidden>·</span>
              <span>{t("history.lastFetched", { date: formatDate(item.last_downloaded_at) })}</span>
            </>
          )}
        </div>
      </div>
      <div className="hidden text-right md:block">
        <div className="text-[10px] uppercase tracking-wider text-ink-mute">
          {t("history.stats.downloads")}
        </div>
        <div className="font-mono text-xs text-ink-soft">
          {item.download_count} · {formatBytes(item.bytes_total)}
        </div>
      </div>
      <Link
        href={`/apps/${encodeURIComponent(item.package_name)}`}
        className="inline-flex h-9 items-center gap-1 rounded-pill border border-outline-soft bg-surface px-3 text-xs font-medium text-ink-soft transition-colors hover:border-primary hover:bg-primary-container/40 hover:text-primary"
      >
        {t("history.view")} <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2.4} />
      </Link>
    </li>
  );
}


/* -------------------------------------------------------------------------- */
/*  Animated stats                                                             */
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
    const duration = 700;
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
      <dd className={cn("mt-1 font-mono text-3xl font-bold tabular-nums tracking-tight md:text-4xl", color)}>
        {display}
      </dd>
    </div>
  );
}


/** Bytes have a unit that changes (B → KiB → MiB → GiB) — animating the
 *  number directly would flicker the unit. Instead we tween the raw
 *  byte count and format it on each tick. */
function BytesStat({ label, bytes }: { label: string; bytes: number }) {
  const [display, setDisplay] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    const from = prev.current;
    const to = bytes;
    prev.current = to;
    if (from === to) { setDisplay(to); return; }
    const duration = 700;
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
  }, [bytes]);
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.18em] text-ink-mute">{label}</dt>
      <dd className="mt-1 font-mono text-2xl font-bold tabular-nums tracking-tight text-ink md:text-3xl">
        {formatBytes(display)}
      </dd>
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Skeleton + empty                                                           */
/* -------------------------------------------------------------------------- */

function SkeletonShelf() {
  return (
    <ul className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <li
          key={i}
          className="flex items-center gap-4 rounded-2xl border border-outline-soft bg-surface px-4 py-3"
        >
          <div className="h-12 w-12 animate-pulse rounded-2xl bg-surface-2" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-40 animate-pulse rounded-pill bg-surface-2" />
            <div className="h-2 w-56 animate-pulse rounded-pill bg-surface-2" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function EmptyShelf() {
  const { t } = useTranslation();
  return (
    <div className="relative overflow-hidden rounded-3xl border border-dashed border-outline-soft bg-surface-2/30 px-6 py-16 text-center">
      <div className="text-5xl">📀</div>
      <p className="mt-4 text-base font-medium text-ink">{t("history.empty")}</p>
      <p className="mt-1 text-sm text-ink-mute">{t("history.emptyHint")}</p>
      <div className="mt-5">
        <Button asChild variant="filled">
          <Link href="/apps">{t("history.browseCta")}</Link>
        </Button>
      </div>
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Page export                                                                */
/* -------------------------------------------------------------------------- */

export default function HistoryPage() {
  return (
    <AuthGuard>
      <HistoryInner />
    </AuthGuard>
  );
}
