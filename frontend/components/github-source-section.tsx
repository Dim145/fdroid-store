"use client";

import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, type GithubSource, type GithubSourceStatus } from "@/lib/api";
import { toast } from "@/lib/toast-store";
import { cn, formatDate } from "@/lib/utils";


export function GithubSourceSection({
  appId,
  onImported,
}: {
  appId: string;
  /** Called when a fresh import has just landed so the parent can refresh
   *  its APK list. */
  onImported?: () => void;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState<GithubSource | null>(null);
  const [loading, setLoading] = useState(true);

  // Form state — controlled inputs, reset to source on every refresh so a
  // pending edit gets clobbered by the new server-side state on poll.
  const [repo, setRepo] = useState("");
  const [assetPattern, setAssetPattern] = useState("");
  const [includePrereleases, setIncludePrereleases] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [dirty, setDirty] = useState(false);

  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [removing, setRemoving] = useState(false);

  const lastSeenTag = useRef<string | null>(null);
  // Baseline timestamp captured the moment a scan is triggered. Polling
  // stops as soon as the server-side ``last_scanned_at`` advances past
  // this value, so a 3-second import doesn't keep the button spinning
  // for the full polling window.
  const scanBaseline = useRef<string | null>(null);
  const scanStartedAt = useRef<number>(0);
  const [awaitingScan, setAwaitingScan] = useState(false);

  function beginWatching(s: GithubSource | null) {
    scanBaseline.current = s?.last_scanned_at ?? null;
    scanStartedAt.current = Date.now();
    setAwaitingScan(true);
  }

  async function reload() {
    try {
      const next = await api.githubSource.get(appId);
      setSource(next);
      if (next) {
        // Hydrate the form when the user hasn't started editing.
        if (!dirty) {
          setRepo(next.repo);
          setAssetPattern(next.asset_pattern ?? "");
          setIncludePrereleases(next.include_prereleases);
          setEnabled(next.enabled);
        }
        // Detect a fresh import — if the tag rolls over to a new value
        // while we're polling, ask the parent to refresh the APK list.
        if (
          next.last_status === "imported" &&
          next.last_release_tag &&
          next.last_release_tag !== lastSeenTag.current
        ) {
          if (lastSeenTag.current !== null) {
            // Skip the very first sighting (initial page load).
            onImported?.();
          }
          lastSeenTag.current = next.last_release_tag;
        }
      }
    } catch (e) {
      toast.error(
        t("myApps.edit.githubSource.loadFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  // Poll while a scan is in flight. We poll every 1.5 s for up to 90 s
  // (large APKs over the public-IP GitHub anonymous bucket can take
  // a while), and stop the moment the worker writes a fresher
  // ``last_scanned_at`` than the value we recorded at trigger time.
  useEffect(() => {
    if (!awaitingScan) return;
    const tick = setInterval(async () => {
      const next = await api.githubSource.get(appId).catch(() => undefined);
      if (next === undefined) return; // transient — keep polling
      setSource(next);
      if (next) {
        if (!dirty) {
          setRepo(next.repo);
          setAssetPattern(next.asset_pattern ?? "");
          setIncludePrereleases(next.include_prereleases);
          setEnabled(next.enabled);
        }
        if (
          next.last_status === "imported" &&
          next.last_release_tag &&
          next.last_release_tag !== lastSeenTag.current
        ) {
          if (lastSeenTag.current !== null) onImported?.();
          lastSeenTag.current = next.last_release_tag;
        }
      }
      const advanced =
        next?.last_scanned_at != null &&
        next.last_scanned_at !== scanBaseline.current;
      const timedOut = Date.now() - scanStartedAt.current > 90_000;
      if (advanced || timedOut) {
        setAwaitingScan(false);
      }
    }, 1500);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingScan, appId, dirty]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!repo.trim()) return;
    setSaving(true);
    try {
      const saved = await api.githubSource.upsert(appId, {
        repo: repo.trim(),
        asset_pattern: assetPattern.trim() || null,
        include_prereleases: includePrereleases,
        enabled,
      });
      setSource(saved);
      setDirty(false);
      toast.success(t("myApps.edit.githubSource.saved"));
      // The PUT triggers an immediate scan server-side. We use the
      // pre-save source state as the baseline so any change in
      // ``last_scanned_at`` reflects the new scan landing.
      beginWatching(source);
    } catch (e) {
      toast.error(
        t("myApps.edit.githubSource.saveFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setSaving(false);
    }
  }

  async function onScanNow() {
    if (!source) return;
    setScanning(true);
    try {
      beginWatching(source);
      await api.githubSource.scanNow(appId);
      toast.success(t("myApps.edit.githubSource.scanQueued"));
    } catch (e) {
      setAwaitingScan(false);
      toast.error(
        t("myApps.edit.githubSource.scanFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setScanning(false);
    }
  }

  async function onRemove() {
    if (!source) return;
    if (!confirm(t("myApps.edit.githubSource.removeConfirm"))) return;
    setRemoving(true);
    try {
      await api.githubSource.remove(appId);
      setSource(null);
      setRepo("");
      setAssetPattern("");
      setIncludePrereleases(false);
      setEnabled(true);
      setDirty(false);
      toast.success(t("myApps.edit.githubSource.removed"));
    } catch (e) {
      toast.error(
        t("myApps.edit.githubSource.removeFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setRemoving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-mute">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Status banner — only present when a source exists */}
      {source && <StatusBanner source={source} scanning={awaitingScan} />}

      <form onSubmit={onSave} className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="gh-repo" className="text-xs font-medium uppercase tracking-wider text-ink-mute">
              {t("myApps.edit.githubSource.repoLabel")}
            </Label>
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-ink-soft">
                <GitBranch className="h-4 w-4" />
              </span>
              <Input
                id="gh-repo"
                value={repo}
                onChange={(e) => { setRepo(e.target.value); setDirty(true); }}
                placeholder={t("myApps.edit.githubSource.repoPlaceholder")}
                className="font-mono"
              />
            </div>
            <p className="text-[11px] leading-relaxed text-ink-mute">
              {t("myApps.edit.githubSource.repoHint")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gh-pattern" className="text-xs font-medium uppercase tracking-wider text-ink-mute">
              {t("myApps.edit.githubSource.patternLabel")}
            </Label>
            <Input
              id="gh-pattern"
              value={assetPattern}
              onChange={(e) => { setAssetPattern(e.target.value); setDirty(true); }}
              placeholder="*.apk"
              className="font-mono"
            />
            <p className="text-[11px] leading-relaxed text-ink-mute">
              {t("myApps.edit.githubSource.patternHint")}
            </p>
          </div>

          <div className="flex flex-col gap-3 md:items-end md:justify-end">
            <ToggleRow
              label={t("myApps.edit.githubSource.includePrereleases")}
              checked={includePrereleases}
              onChange={(v) => { setIncludePrereleases(v); setDirty(true); }}
            />
            <ToggleRow
              label={t("myApps.edit.githubSource.enabled")}
              hint={t("myApps.edit.githubSource.enabledHint")}
              checked={enabled}
              onChange={(v) => { setEnabled(v); setDirty(true); }}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-outline-soft pt-4">
          <div className="flex flex-wrap items-center gap-2">
            {source && (
              <>
                <Button
                  type="button"
                  variant="outlined"
                  onClick={onScanNow}
                  disabled={scanning || awaitingScan}
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", (scanning || awaitingScan) && "animate-spin")} />
                  {awaitingScan
                    ? t("myApps.edit.githubSource.scanRunning")
                    : t("myApps.edit.githubSource.scanNow")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onRemove}
                  disabled={removing}
                  className="text-danger hover:bg-danger-container"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("myApps.edit.githubSource.remove")}
                </Button>
              </>
            )}
          </div>
          <Button type="submit" variant="filled" disabled={saving || !repo.trim()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitBranch className="h-3.5 w-3.5" />}
            {source ? t("myApps.edit.githubSource.update") : t("myApps.edit.githubSource.connect")}
          </Button>
        </div>
      </form>
    </div>
  );
}


function StatusBanner({
  source,
  scanning,
}: {
  source: GithubSource;
  scanning: boolean;
}) {
  const { t } = useTranslation();
  const tone = toneFor(source.last_status, scanning);
  return (
    <div
      className={cn(
        "rounded-2xl border px-4 py-3",
        tone === "error" && "border-danger/30 bg-danger-container/40",
        tone === "ok" && "border-primary/30 bg-primary-container/30",
        tone === "neutral" && "border-outline-soft bg-surface-2",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <StatusIcon status={source.last_status} scanning={scanning} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusBadge status={source.last_status} scanning={scanning} />
              {source.last_release_tag && (
                <a
                  href={`https://github.com/${source.repo}/releases/tag/${source.last_release_tag}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-xs font-mono text-ink-soft hover:text-primary"
                >
                  {source.last_release_tag}
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            {source.last_error && (
              <p className="mt-1.5 break-words text-xs text-danger">
                {source.last_error}
              </p>
            )}
            <p className="mt-1 text-[11px] text-ink-mute">
              {source.last_scanned_at
                ? t("myApps.edit.githubSource.lastScanned", { date: formatDate(source.last_scanned_at) })
                : t("myApps.edit.githubSource.neverScanned")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}


function StatusIcon({ status, scanning }: { status: GithubSourceStatus; scanning: boolean }) {
  if (scanning) return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />;
  if (status === "error") return <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />;
  if (status === "imported" || status === "up_to_date")
    return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />;
  return <GitBranch className="mt-0.5 h-4 w-4 shrink-0 text-ink-mute" />;
}


function StatusBadge({ status, scanning }: { status: GithubSourceStatus; scanning: boolean }) {
  const { t } = useTranslation();
  if (scanning) {
    return <Badge variant="primary">{t("myApps.edit.githubSource.statusScanning")}</Badge>;
  }
  switch (status) {
    case "idle":
      return <Badge variant="outline">{t("myApps.edit.githubSource.statusIdle")}</Badge>;
    case "up_to_date":
      return <Badge variant="primary">{t("myApps.edit.githubSource.statusUpToDate")}</Badge>;
    case "imported":
      return <Badge variant="primary">{t("myApps.edit.githubSource.statusImported")}</Badge>;
    case "skipped":
      return <Badge variant="outline">{t("myApps.edit.githubSource.statusSkipped")}</Badge>;
    case "error":
      return <Badge variant="destructive">{t("myApps.edit.githubSource.statusError")}</Badge>;
  }
}


function toneFor(status: GithubSourceStatus, scanning: boolean): "ok" | "error" | "neutral" {
  if (scanning) return "neutral";
  if (status === "error") return "error";
  if (status === "imported" || status === "up_to_date") return "ok";
  return "neutral";
}


function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex w-full cursor-pointer items-start justify-between gap-3 rounded-2xl border border-outline-soft bg-surface px-3 py-2.5 transition-colors hover:bg-surface-2 md:w-72">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-relaxed text-ink-mute">{hint}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} ariaLabel={label} />
    </label>
  );
}
