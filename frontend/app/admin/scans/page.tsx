"use client";

import { Activity, PlayCircle, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api, type ApkScanRow, type RepoConfigInfo } from "@/lib/api";
import { toast } from "@/lib/toast-store";
import { cn, formatDate } from "@/lib/utils";


export default function AdminScansPage() {
  const { t } = useTranslation();
  const [repo, setRepo] = useState<RepoConfigInfo | null>(null);
  const [ping, setPing] = useState<{ ok: boolean; configured: boolean } | null>(null);
  const [scans, setScans] = useState<ApkScanRow[]>([]);
  const [onlyInfected, setOnlyInfected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  async function reload() {
    setLoading(true);
    try {
      const [r, p, s] = await Promise.all([
        api.admin.repo(),
        api.admin.clamavPing().catch(() => ({ ok: false, configured: false })),
        api.admin.scans({ only_infected: onlyInfected }),
      ]);
      setRepo(r);
      setPing(p);
      setScans(s);
    } catch (e) {
      toast.error(t("admin.scans.loadFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [onlyInfected]);

  async function toggle(field: "clamav_scan_on_upload" | "clamav_scan_periodic", value: boolean) {
    if (!repo) return;
    try {
      const updated = await api.admin.updateRepo({ [field]: value });
      setRepo(updated);
      toast.success(t("admin.scans.saved"));
    } catch (e) {
      toast.error(t("admin.scans.saveFailed"), e instanceof Error ? e.message : undefined);
    }
  }

  async function scanNow() {
    setScanning(true);
    try {
      await api.admin.clamavScanNow();
      toast.success(t("admin.scans.scanNowQueued"));
      // The worker stamps each row as it processes; poll a few times so
      // the history section catches up without the user having to hit
      // Refresh manually.
      for (const delay of [3000, 6000, 12000]) {
        await new Promise((r) => setTimeout(r, delay));
        await reload();
      }
    } catch (e) {
      toast.error(t("admin.scans.scanNowFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <div className="eyebrow">{t("admin.eyebrow")}</div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">
          {t("admin.scans.title")}
        </h1>
        <p className="mt-1 text-ink-soft">{t("admin.scans.subtitle")}</p>
      </header>

      {/* Connection status + toggles */}
      <section className="surface p-6">
        <div className="flex flex-wrap items-center gap-3">
          {ping?.configured ? (
            ping.ok ? (
              <Badge variant="primary">
                <ShieldCheck className="h-3 w-3" /> {t("admin.scans.reachable")}
              </Badge>
            ) : (
              <Badge variant="accent">
                <ShieldAlert className="h-3 w-3" /> {t("admin.scans.unreachable")}
              </Badge>
            )
          ) : (
            <Badge variant="soft">{t("admin.scans.notConfigured")}</Badge>
          )}
          <Button variant="outlined" size="sm" onClick={reload}>
            <RefreshCw className="h-3.5 w-3.5" /> {t("admin.scans.recheck")}
          </Button>
        </div>

        {!ping?.configured && (
          <p className="mt-3 text-xs text-ink-mute">
            {t("admin.scans.envHint")}
          </p>
        )}

        {ping?.configured && repo && (
          <div className="mt-4 space-y-3">
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-outline-soft bg-surface px-4 py-3">
              <div>
                <div className="text-sm font-medium text-ink">{t("admin.scans.toggleUpload")}</div>
                <div className="text-xs text-ink-mute">{t("admin.scans.toggleUploadBody")}</div>
              </div>
              <Switch
                checked={!!repo.clamav_scan_on_upload}
                onCheckedChange={(v) => toggle("clamav_scan_on_upload", v)}
              />
            </label>
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-outline-soft bg-surface px-4 py-3">
              <div>
                <div className="text-sm font-medium text-ink">{t("admin.scans.togglePeriodic")}</div>
                <div className="text-xs text-ink-mute">{t("admin.scans.togglePeriodicBody")}</div>
              </div>
              <Switch
                checked={!!repo.clamav_scan_periodic}
                onCheckedChange={(v) => toggle("clamav_scan_periodic", v)}
              />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-outline-soft bg-surface px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink">{t("admin.scans.scanNow")}</div>
                {/* Swap the rationale when ClamAV is unreachable — the
                    button stays disabled and the user otherwise has no
                    explanation of why. */}
                <div className={cn("text-xs", ping?.ok ? "text-ink-mute" : "text-danger")}>
                  {ping?.ok
                    ? t("admin.scans.scanNowBody")
                    : t("admin.scans.scanNowDisabledReason")}
                </div>
              </div>
              <Button
                variant="filled"
                size="sm"
                onClick={scanNow}
                disabled={scanning || !ping?.ok}
                title={!ping?.ok ? t("admin.scans.scanNowDisabledReason") : undefined}
              >
                <PlayCircle className="h-4 w-4" />
                {scanning ? t("admin.scans.scanNowRunning") : t("admin.scans.scanNowAction")}
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* History */}
      <section className="surface p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold tracking-tight text-ink">{t("admin.scans.history")}</h2>
          <label className="inline-flex items-center gap-2 text-xs text-ink-soft">
            <input
              type="checkbox"
              checked={onlyInfected}
              onChange={(e) => setOnlyInfected(e.target.checked)}
            />
            {t("admin.scans.onlyInfected")}
          </label>
        </div>
        {loading ? (
          <p className="text-sm italic text-ink-mute">{t("common.loading")}</p>
        ) : scans.length === 0 ? (
          <p className="rounded-xl border border-dashed border-outline px-4 py-8 text-center italic text-ink-mute">
            {t("admin.scans.empty")}
          </p>
        ) : (
          <ul className="space-y-1">
            {scans.map((s) => (
              <li
                key={s.id}
                className="grid gap-2 rounded-xl border border-outline-soft bg-surface px-3 py-2 text-xs md:grid-cols-[160px_100px_minmax(0,1.4fr)_minmax(0,1fr)]"
              >
                <span className="font-mono text-ink-mute">
                  {s.scanned_at ? formatDate(s.scanned_at) : formatDate(s.created_at)}
                </span>
                <span>
                  {s.status === "clean" && <Badge variant="primary">{t("admin.scans.clean")}</Badge>}
                  {s.status === "infected" && <Badge variant="accent">{t("admin.scans.infected")}</Badge>}
                  {s.status === "error" && <Badge variant="soft">{t("admin.scans.error")}</Badge>}
                  {s.status === "pending" && <Badge variant="soft">{t("admin.scans.pending")}</Badge>}
                </span>
                <span className="min-w-0 truncate text-ink" title={s.package_name || s.apk_id}>
                  {s.app_name ? (
                    <>
                      <span className="font-medium">{s.app_name}</span>
                      {s.version_name && (
                        <span className="ml-1.5 font-mono text-[10px] text-ink-mute">
                          v{s.version_name}{s.version_code != null ? ` (${s.version_code})` : ""}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="font-mono text-ink-mute">{s.apk_id.slice(0, 8)}…</span>
                  )}
                </span>
                <span className="min-w-0 truncate text-ink-soft" title={s.signatures || s.error || ""}>
                  {s.signatures || s.error || "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
