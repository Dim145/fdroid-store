"use client";

import { Activity, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, type JobsSnapshot } from "@/lib/api";
import { toast } from "@/lib/toast-store";
import { formatDate } from "@/lib/utils";


export default function AdminJobsPage() {
  const { t } = useTranslation();
  const [snap, setSnap] = useState<JobsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  async function reload() {
    setLoading(true);
    try {
      setSnap(await api.admin.jobs());
    } catch (e) {
      toast.error(t("admin.jobs.loadFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
  }

  async function triggerReindex() {
    try {
      await api.admin.reindex();
      toast.success(t("admin.jobs.reindexQueued"));
      // Give arq a moment to register the job before we snapshot again.
      setTimeout(reload, 600);
    } catch (e) {
      toast.error(t("admin.jobs.reindexFailed"), e instanceof Error ? e.message : undefined);
    }
  }

  useEffect(() => {
    void reload();
    // Auto-refresh every 10s — the page is for live observation.
    const id = window.setInterval(reload, 10000);
    return () => window.clearInterval(id);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow">{t("admin.eyebrow")}</div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">
            {t("admin.jobs.title")}
          </h1>
          <p className="mt-1 text-ink-soft">{t("admin.jobs.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outlined" onClick={reload} disabled={loading}>
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            {t("admin.jobs.refresh")}
          </Button>
          <Button variant="filled" onClick={triggerReindex}>
            <Activity className="h-4 w-4" /> {t("admin.jobs.triggerReindex")}
          </Button>
        </div>
      </header>

      {!snap?.available && (
        <div className="rounded-xl border border-danger bg-danger-container px-4 py-3 text-sm text-danger-on-container">
          {t("admin.jobs.unavailable")}{snap?.error ? ` — ${snap.error}` : ""}
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-2">
        <div className="surface p-6">
          <div className="eyebrow">{t("admin.jobs.queued")}</div>
          <div className="mt-2 text-3xl font-bold tracking-tight text-ink">{snap?.queued ?? 0}</div>
        </div>
        <div className="surface p-6">
          <div className="eyebrow">{t("admin.jobs.inProgress")}</div>
          <div className="mt-2 text-3xl font-bold tracking-tight text-ink">{snap?.in_progress ?? 0}</div>
        </div>
      </section>

      <section className="surface p-6">
        <h2 className="mb-3 text-lg font-bold tracking-tight text-ink">{t("admin.jobs.recent")}</h2>
        {(snap?.recent || []).length === 0 ? (
          <p className="rounded-xl border border-dashed border-outline px-4 py-8 text-center italic text-ink-mute">
            {t("admin.jobs.noRecent")}
          </p>
        ) : (
          <ul className="space-y-2">
            {(snap?.recent || []).map((r, i) => (
              <li
                key={i}
                className="grid gap-2 rounded-xl border border-outline-soft bg-surface px-3 py-2 text-xs md:grid-cols-[160px_140px_100px_1fr]"
              >
                <span className="font-mono text-ink-mute">
                  {r.finish_time ? formatDate(r.finish_time) : (r.start_time ? formatDate(r.start_time) : "—")}
                </span>
                <span className="font-mono">{r.function || r.raw_key || "?"}</span>
                <span>
                  {r.success === true && <Badge variant="primary">{t("admin.jobs.ok")}</Badge>}
                  {r.success === false && <Badge variant="accent">{t("admin.jobs.fail")}</Badge>}
                  {r.success === undefined && <Badge variant="soft">?</Badge>}
                </span>
                <span className="min-w-0 truncate text-ink-soft" title={r.result_str || ""}>
                  {r.duration_ms != null && (
                    <span className="mr-2 font-mono text-ink-mute">
                      {r.duration_ms.toLocaleString()} ms
                    </span>
                  )}
                  {r.result_str || "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
        {snap?.observed_at && (
          <p className="mt-3 text-[11px] text-ink-mute">
            {t("admin.jobs.observed", { when: formatDate(new Date(snap.observed_at * 1000).toISOString()) })}
          </p>
        )}
      </section>
    </div>
  );
}
