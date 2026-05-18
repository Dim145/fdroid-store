"use client";

import { ArrowUpRight, Calendar, Download, History as HistoryIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { AppIcon } from "@/components/app-icon";
import { AuthGuard } from "@/components/auth-guard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, type DownloadHistoryItem } from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/utils";

function HistoryInner() {
  const [items, setItems] = useState<DownloadHistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.downloadHistory()
      .then((res) => { if (!cancelled) { setItems(res.items); setLoaded(true); } })
      .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : "Failed"); setLoaded(true); } });
    return () => { cancelled = true; };
  }, []);

  const totalBytes = useMemo(
    () => items.reduce((sum, i) => sum + i.bytes_total, 0),
    [items],
  );
  const totalDownloads = useMemo(
    () => items.reduce((sum, i) => sum + i.download_count, 0),
    [items],
  );
  const updatableCount = useMemo(
    () => items.filter((i) => i.has_update_available).length,
    [items],
  );

  return (
    <div>
      <header className="mb-6">
        <div className="eyebrow">Library</div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">
          Download history
        </h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Every app you've grabbed from this repo, grouped by package. F-Droid
          clients don't report back installation status, so this is the
          closest the repo can come to a "what do I have installed?" view —
          downloaded ≠ installed, but the version comparison lets you spot
          out-of-date copies on your devices.
        </p>
      </header>

      {/* Stats strip */}
      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat icon={<HistoryIcon className="h-5 w-5" />} label="Apps" value={String(items.length)} />
        <Stat icon={<Download className="h-5 w-5" />} label="Downloads" value={String(totalDownloads)} />
        <Stat icon={<ArrowUpRight className="h-5 w-5" />} label="Updates available" value={String(updatableCount)} highlight={updatableCount > 0} />
        <Stat icon={<Calendar className="h-5 w-5" />} label="Total fetched" value={formatBytes(totalBytes)} mono />
      </section>

      {error && (
        <p className="mb-4 rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">
          {error}
        </p>
      )}

      <section className="surface overflow-hidden">
        {!loaded ? (
          <div className="flex h-40 items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-outline-soft border-t-primary" role="status" />
          </div>
        ) : items.length === 0 ? (
          <div className="px-6 py-12 text-center italic text-ink-mute">
            You haven&apos;t downloaded anything from this repo yet.
          </div>
        ) : (
          <ul>
            {items.map((it, i) => (
              <li
                key={it.app_id}
                className={
                  "flex flex-wrap items-center gap-4 px-5 py-4 " +
                  (i !== items.length - 1 ? "border-b border-outline-soft" : "")
                }
              >
                <AppIcon
                  iconPath={it.icon_path}
                  name={it.app_name}
                  size={56}
                  className="shadow-e1"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Link
                      href={`/apps/${encodeURIComponent(it.package_name)}`}
                      className="truncate text-base font-semibold text-ink hover:text-primary"
                    >
                      {it.app_name}
                    </Link>
                    {it.has_update_available && (
                      <Badge variant="primary">update available</Badge>
                    )}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-ink-mute truncate">
                    {it.package_name}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-soft">
                    <span>
                      You downloaded{" "}
                      <span className="font-semibold text-ink">
                        v{it.last_apk_version_name ?? "?"}
                      </span>
                      {it.last_apk_version_code != null && (
                        <span className="font-mono text-ink-mute"> ({it.last_apk_version_code})</span>
                      )}
                    </span>
                    {it.has_update_available && (
                      <span>
                        latest is{" "}
                        <span className="font-semibold text-primary">
                          v{it.latest_apk_version_name ?? "?"}
                        </span>
                      </span>
                    )}
                    <span>·</span>
                    <span>{it.download_count} download{it.download_count === 1 ? "" : "s"}</span>
                    <span>·</span>
                    <span className="font-mono">{formatBytes(it.bytes_total)}</span>
                  </div>
                  {it.last_downloaded_at && (
                    <div className="mt-1 font-mono text-[10px] text-ink-mute">
                      last fetched {formatDate(it.last_downloaded_at)}
                    </div>
                  )}
                </div>
                <Button asChild variant={it.has_update_available ? "filled" : "outlined"} size="sm">
                  <Link href={`/apps/${encodeURIComponent(it.package_name)}`}>
                    {it.has_update_available ? "Update" : "View"}
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-6 max-w-2xl text-xs text-ink-mute">
        <strong>Why no "installed" indicator?</strong> The F-Droid Android
        client doesn't broadcast install status to the repository, so we
        can't truly know if an APK is still on your device. We show the
        latest version you downloaded plus whether a newer one is available
        — the closest approximation a server-side view can offer.
      </p>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
  mono,
  highlight,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className={"surface p-4 " + (highlight ? "ring-2 ring-primary" : "")}>
      <div className="flex items-center gap-2 text-ink-mute">
        {icon}
        <span className="text-[10px] uppercase tracking-wider">{label}</span>
      </div>
      <div className={"mt-2 text-2xl font-bold tracking-tight text-ink " + (mono ? "font-mono text-xl" : "")}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-mute">{hint}</div>}
    </div>
  );
}

export default function HistoryPage() {
  return (
    <AuthGuard>
      <HistoryInner />
    </AuthGuard>
  );
}
