"use client";

import { BarChart3, Box, Download, HardDrive, Lock, Users } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AppIcon } from "@/components/app-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, type StatsPayload } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { cn, formatBytes, formatCount, formatDate } from "@/lib/utils";

/* ============================================================================
 * Public-or-auth aggregate stats for the repo. Visibility rules:
 *
 *   * Anonymous + repo public + public_stats ON  → public view (no private)
 *   * Anonymous + (private repo OR public_stats OFF) → backend 401, we show
 *     a "sign in to see" empty state
 *   * Authenticated non-admin → public view
 *   * Authenticated admin     → admin view (private apps included)
 * ============================================================================ */
export default function StatsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [data, setData] = useState<StatsPayload | null>(null);
  const [error, setError] = useState<"unauthorized" | "forbidden" | "other" | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .stats()
      .then((p) => { if (!cancelled) setData(p); })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "";
        if (/403|forbidden|administrator/i.test(msg)) setError("forbidden");
        else if (/401|unauth/i.test(msg)) setError("unauthorized");
        else setError("other");
      });
    return () => { cancelled = true; };
  }, []);

  if (error === "unauthorized") {
    return <UnauthorizedState />;
  }
  if (error === "forbidden") {
    return <ForbiddenState loggedIn={!!user} />;
  }
  if (error === "other") {
    return (
      <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">
        {t("stats.loadFailed")}
      </p>
    );
  }
  if (!data) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-10 animate-fade-up pb-12">
      <Hero data={data} />
      <TopApps apps={data.top_apps} />
      <DownloadsChart days={data.downloads_by_day} />
      <CategoriesBreakdown categories={data.categories} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function UnauthorizedState() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-2xl rounded-3xl border border-outline-soft bg-surface p-10 text-center">
      <Lock className="mx-auto h-8 w-8 text-ink-mute" strokeWidth={1.8} />
      <h1 className="mt-4 text-2xl font-bold tracking-tight text-ink">
        {t("stats.gatedTitle")}
      </h1>
      <p className="mt-2 text-sm text-ink-soft">{t("stats.gatedBody")}</p>
      <div className="mt-6">
        <Button asChild variant="filled">
          <Link href="/login?next=%2Fstats">{t("stats.signIn")}</Link>
        </Button>
      </div>
    </div>
  );
}

/* Stats are admin-only — the caller is signed in but lacks the role.
 * Distinct from ``Unauthorized``: signing in another account won't help,
 * only an admin can either grant the role or flip the page to public. */
function ForbiddenState({ loggedIn }: { loggedIn: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-2xl rounded-3xl border border-outline-soft bg-surface p-10 text-center">
      <Lock className="mx-auto h-8 w-8 text-ink-mute" strokeWidth={1.8} />
      <h1 className="mt-4 text-2xl font-bold tracking-tight text-ink">
        {t("stats.adminOnlyTitle")}
      </h1>
      <p className="mt-2 text-sm text-ink-soft">{t("stats.adminOnlyBody")}</p>
      {!loggedIn && (
        <div className="mt-6">
          <Button asChild variant="filled">
            <Link href="/login?next=%2Fstats">{t("stats.signIn")}</Link>
          </Button>
        </div>
      )}
    </div>
  );
}

function Hero({ data }: { data: StatsPayload }) {
  const { t } = useTranslation();
  return (
    <header className="relative overflow-hidden rounded-3xl border border-outline-soft bg-surface px-6 py-7 md:px-10 md:py-9">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 80% at 100% 0%, rgb(var(--primary) / 0.10), transparent 65%)",
        }}
      />
      <div className="relative">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-mute">
            {t("stats.eyebrow")}
          </span>
          {data.scope === "admin" && (
            <Badge variant="accent">{t("stats.adminScope")}</Badge>
          )}
        </div>
        <h1 className="mt-2 text-4xl font-bold tracking-tight text-ink md:text-5xl">
          {t("stats.title")}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-soft">
          {data.scope === "admin" ? t("stats.subtitleAdmin") : t("stats.subtitlePublic")}
        </p>
        <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-6 md:grid-cols-5">
          <StatTile icon={<Box className="h-4 w-4" />} label={t("stats.totals.apps")} value={formatCount(data.totals.apps)} />
          <StatTile icon={<Download className="h-4 w-4" />} label={t("stats.totals.apks")} value={formatCount(data.totals.apks_published)} />
          <StatTile icon={<Download className="h-4 w-4" />} label={t("stats.totals.downloads")} value={formatCount(data.totals.downloads)} accent="primary" />
          <StatTile icon={<HardDrive className="h-4 w-4" />} label={t("stats.totals.storage")} value={formatBytes(data.totals.bytes_published)} />
          <StatTile icon={<Users className="h-4 w-4" />} label={t("stats.totals.users")} value={formatCount(data.totals.active_users)} />
        </dl>
      </div>
    </header>
  );
}

function StatTile({
  icon,
  label,
  value,
  accent = "ink",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: "ink" | "primary";
}) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-ink-mute">
        <span className="text-ink-mute">{icon}</span>
        {label}
      </dt>
      <dd
        className={cn(
          "nums-no-slash mt-1 text-3xl font-bold tabular-nums tracking-tight md:text-4xl",
          accent === "primary" ? "text-primary" : "text-ink",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TopApps({ apps }: { apps: StatsPayload["top_apps"] }) {
  const { t } = useTranslation();
  if (apps.length === 0) return null;
  return (
    <section className="rounded-3xl border border-outline-soft bg-surface p-6 md:p-8">
      <header className="mb-6 flex items-baseline justify-between gap-3 border-b border-outline-soft pb-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-mute">
            {t("stats.topAppsEyebrow")}
          </div>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-ink">
            {t("stats.topAppsTitle")}
          </h2>
        </div>
      </header>
      <ol className="space-y-2">
        {apps.map((a, i) => (
          <li key={a.id}>
            <Link
              href={`/apps/${encodeURIComponent(a.package_name)}`}
              className="group flex items-center gap-4 rounded-2xl border border-outline-soft bg-surface px-4 py-3 transition-all hover:border-outline hover:shadow-e1"
            >
              <span className="w-6 shrink-0 font-mono text-[10px] tabular-nums text-ink-mute">
                {String(i + 1).padStart(2, "0")}
              </span>
              <AppIcon iconPath={a.icon_path} name={a.name} size={48} version={a.updated_at ?? undefined} className="shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-base font-semibold text-ink group-hover:text-primary">
                  {a.name}
                </div>
                <div className="truncate font-mono text-[11px] text-ink-mute">
                  {a.package_name}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wider text-ink-mute">
                  {t("stats.downloadsLabel")}
                </div>
                <div className="font-mono text-sm font-bold tabular-nums text-ink">
                  {formatCount(a.download_count)}
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function DownloadsChart({ days }: { days: StatsPayload["downloads_by_day"] }) {
  const { t } = useTranslation();
  // Fill missing days with zero so the bars cover the full 30-day window
  // even on a quiet repo (PG returns no row for empty days).
  const filled = useMemo(() => {
    const out: { date: string; count: number }[] = [];
    const map = new Map(days.map((d) => [d.date, d.count]));
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const iso = d.toISOString().slice(0, 10);
      out.push({ date: iso, count: map.get(iso) ?? 0 });
    }
    return out;
  }, [days]);
  const max = Math.max(1, ...filled.map((d) => d.count));
  const total = filled.reduce((s, d) => s + d.count, 0);

  return (
    <section className="rounded-3xl border border-outline-soft bg-surface p-6 md:p-8">
      <header className="mb-6 flex items-baseline justify-between gap-3 border-b border-outline-soft pb-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-mute">
            {t("stats.downloadsEyebrow")}
          </div>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-ink">
            {t("stats.downloadsTitle")}
          </h2>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-ink-mute">
            {t("stats.downloadsTotal30")}
          </div>
          <div className="font-mono text-2xl font-bold tabular-nums text-ink">
            {formatCount(total)}
          </div>
        </div>
      </header>

      {/* Stacked-bar chart, CSS-only — height of each bar is the day's
          count relative to the busiest day, capped at 100%. A bar of
          height 0 still renders a 2 px stub so the day shows up. */}
      <div className="flex h-40 items-end gap-1">
        {filled.map((d) => {
          const pct = Math.max(2, (d.count / max) * 100);
          return (
            <div
              key={d.date}
              className="group relative flex-1"
              style={{ height: `${pct}%` }}
              title={t("stats.tooltip", { date: formatDate(d.date), count: d.count })}
            >
              <div
                className={cn(
                  "h-full w-full rounded-t-sm transition-colors",
                  d.count > 0 ? "bg-primary/70 group-hover:bg-primary" : "bg-outline-soft",
                )}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-ink-mute">
        <span>{formatDate(filled[0]?.date ?? "")}</span>
        <span>{t("stats.today")}</span>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function CategoriesBreakdown({ categories }: { categories: StatsPayload["categories"] }) {
  const { t } = useTranslation();
  const visible = categories.filter((c) => c.app_count > 0);
  if (visible.length === 0) return null;
  const max = Math.max(1, ...visible.map((c) => c.app_count));

  return (
    <section className="rounded-3xl border border-outline-soft bg-surface p-6 md:p-8">
      <header className="mb-6 flex items-baseline justify-between gap-3 border-b border-outline-soft pb-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-mute">
            {t("stats.categoriesEyebrow")}
          </div>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-ink">
            {t("stats.categoriesTitle")}
          </h2>
        </div>
        <BarChart3 className="h-5 w-5 text-ink-mute" strokeWidth={2} />
      </header>
      <ul className="space-y-3">
        {visible.map((c) => {
          const pct = (c.app_count / max) * 100;
          return (
            <li key={c.id} className="flex items-center gap-3">
              <span className="w-32 shrink-0 truncate text-sm font-medium text-ink">
                {c.name}
              </span>
              <div className="relative h-2 flex-1 overflow-hidden rounded-pill bg-surface-2">
                <div
                  className="h-full rounded-pill bg-primary/80 transition-[width] duration-500 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="w-12 shrink-0 text-right font-mono text-sm tabular-nums text-ink-soft">
                {c.app_count}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function Spinner() {
  return (
    <div
      className="h-6 w-6 animate-spin rounded-full border-2 border-outline-soft border-t-primary"
      role="status"
      aria-label="Loading"
    />
  );
}
