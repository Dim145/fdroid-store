"use client";

import { Activity, AppWindow, Download, Inbox, Package, RefreshCw, Settings2, Users } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { api, type AdminStats } from "@/lib/api";

export default function AdminDashboardPage() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);

  async function refresh() {
    try { setStats(await api.admin.stats()); }
    catch (e) { setError(e instanceof Error ? e.message : t("errors.loadFailed")); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  async function reindex() {
    setReindexing(true);
    try { await api.admin.reindex(); }
    catch (e) { setError(e instanceof Error ? e.message : t("admin.overview.reindexFailed")); }
    finally { setReindexing(false); setTimeout(refresh, 1500); }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow">{t("admin.overview.eyebrow")}</div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">{t("admin.overview.title")}</h1>
        </div>
        <Button onClick={reindex} variant="filled" size="lg" disabled={reindexing}>
          <RefreshCw className={reindexing ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> {t("admin.overview.triggerReindex")}
        </Button>
      </header>

      {error && <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{error}</p>}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat icon={<Users className="h-5 w-5" />} label={t("admin.overview.stats.users")} value={stats?.total_users} />
        <Stat
          icon={<Package className="h-5 w-5" />}
          label={t("admin.overview.stats.apps")}
          value={stats?.total_apps}
          hint={stats ? t("admin.overview.stats.publishedCount", { count: stats.published_apps }) : undefined}
        />
        <Stat icon={<Activity className="h-5 w-5" />} label={t("admin.overview.stats.pendingApks")} value={stats?.pending_apks} highlight={Boolean(stats?.pending_apks)} />
        <Stat icon={<Download className="h-5 w-5" />} label={t("admin.overview.stats.downloads")} value={stats?.total_downloads} />
      </section>

      <section className="surface p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-ink">{t("admin.overview.recentDownloads")}</h2>
          <span className="text-xs text-ink-mute">{t("admin.overview.last20")}</span>
        </div>
        <ul className="divide-y divide-outline-soft">
          {stats?.recent_downloads.length === 0 && (
            // The dashboard sits empty until the *first* install — that can be
            // hours after the repo is set up. Rather than a bald "nothing to
            // see here" line, give the admin two concrete next steps: tidy
            // the catalogue, or grab the repo URL to subscribe a client. Both
            // are one click away from the side nav, but surfacing them inline
            // shortens the loop while the dashboard is still cold.
            <li className="flex flex-col items-start gap-4 py-8 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-ink-mute">
                  <Inbox className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink">{t("admin.overview.noDownloads")}</div>
                  <p className="mt-0.5 max-w-md text-xs text-ink-soft">
                    {t("admin.overview.noDownloadsBody")}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 sm:shrink-0">
                <Button asChild variant="tonal" size="sm">
                  <Link href="/admin/apps">
                    <AppWindow className="h-3.5 w-3.5" />
                    {t("admin.overview.noDownloadsManageApps")}
                  </Link>
                </Button>
                <Button asChild variant="outlined" size="sm">
                  <Link href="/admin/repo">
                    <Settings2 className="h-3.5 w-3.5" />
                    {t("admin.overview.noDownloadsRepoUrl")}
                  </Link>
                </Button>
              </div>
            </li>
          )}
          {stats?.recent_downloads.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 py-2.5 text-xs">
              <span className="font-mono text-ink-soft">{new Date(d.created_at).toLocaleString()}</span>
              <span className="text-ink-mute">
                <span className="text-ink">{d.app_name ?? t("admin.overview.deletedApp")}</span>
                <span className="font-mono"> · </span>
                <span className="text-ink">{d.username ?? (d.user_id ? t("admin.overview.deletedUser") : t("admin.overview.anon"))}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Stat({
  icon, label, value, hint, highlight,
}: { icon: React.ReactNode; label: string; value: number | undefined; hint?: string; highlight?: boolean }) {
  return (
    <div className={`surface p-5 ${highlight ? "ring-2 ring-accent" : ""}`}>
      <div className="flex items-center gap-2 text-ink-mute">
        {icon}
        <span className="text-[11px] uppercase tracking-wider">{label}</span>
      </div>
      <div className="mt-3 text-4xl font-bold tracking-tight text-ink">
        {value !== undefined ? value : "—"}
      </div>
      {hint && <div className="mt-1 text-xs text-ink-mute">{hint}</div>}
    </div>
  );
}
