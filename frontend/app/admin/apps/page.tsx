"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { AppIcon } from "@/components/app-icon";
import { NsfwTag } from "@/components/nsfw-tag";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type AppSummary } from "@/lib/api";

export default function AdminAppsPage() {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [pendingApks, setPendingApks] = useState<Array<{ appId: string; apkId: string; vc: number; vn: string }>>([]);

  async function refresh() {
    try {
      const data = await api.admin.listApps(filter || undefined);
      setApps(data);
      const pending = data.flatMap((app) =>
        ((app as unknown as { apks?: Array<{ id: string; status: string; version_code: number; version_name: string }> }).apks ?? [])
          .filter((a) => a.status === "pending_review")
          .map((a) => ({ appId: app.id, apkId: a.id, vc: a.version_code, vn: a.version_name })),
      );
      setPendingApks(pending);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  }
  useEffect(() => { refresh(); }, [filter]);

  async function setStatus(id: string, status: string) { await api.admin.updateApp(id, { status }); await refresh(); }
  async function publishApk(apkId: string) { await api.admin.publishApk(apkId); await refresh(); }
  async function rejectApk(apkId: string) {
    const reason = prompt("Reason for rejection?") || "Rejected";
    await api.admin.rejectApk(apkId, reason);
    await refresh();
  }
  async function rescanApp(appId: string, appName: string) {
    setError(null); setMsg(null); setBusyId(appId);
    try {
      const r = await api.admin.rescanApp(appId);
      setMsg(`${appName}: ${r.rescanned_apks} APKs · ${r.icons_refreshed} icon · ${r.failed.length} errors`);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Rescan failed"); }
    finally { setBusyId(null); }
  }
  async function rescanAll() {
    if (!confirm("Rescan every published APK?")) return;
    setError(null); setMsg(null); setBulkBusy(true);
    try {
      const r = await api.admin.rescanAll();
      setMsg(`${r.rescanned_apks} APKs rescanned · ${r.icons_refreshed} icons refreshed`);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Rescan failed"); }
    finally { setBulkBusy(false); }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow">Admin</div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">Apps & APKs</h1>
          <p className="mt-1 text-ink-soft">Moderate listings and publish pressings.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outlined" onClick={rescanAll} disabled={bulkBusy}>
            <RefreshCw className={bulkBusy ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            {bulkBusy ? "Rescanning…" : "Rescan all"}
          </Button>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-10 rounded-pill border border-outline bg-surface px-4 text-sm focus:border-primary focus:outline-none"
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="pending_review">Pending review</option>
            <option value="published">Published</option>
            <option value="rejected">Rejected</option>
            <option value="archived">Archived</option>
          </select>
        </div>
      </header>

      {msg && <p className="rounded-xl border border-primary bg-primary-container px-3 py-2 text-sm text-primary-on-container">{msg}</p>}
      {error && <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{error}</p>}

      {pendingApks.length > 0 && (
        <section className="surface relative overflow-hidden p-5" style={{ boxShadow: "inset 0 0 0 2px rgb(var(--accent) / 0.4)" }}>
          <div className="mb-3 flex items-center gap-2 text-accent-on-container">
            <AlertTriangle className="h-5 w-5" />
            <h2 className="text-lg font-bold tracking-tight">{pendingApks.length} pending pressing{pendingApks.length === 1 ? "" : "s"}</h2>
          </div>
          <ul className="divide-y divide-outline-soft">
            {pendingApks.map((p) => (
              <li key={p.apkId} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                <span>
                  <span className="font-mono text-[11px] text-ink-mute">{p.appId.slice(0, 8)}</span>
                  {" · "}
                  <span className="font-mono">v{p.vn} ({p.vc})</span>
                </span>
                <span className="flex gap-2">
                  <Button size="sm" variant="filled" onClick={() => publishApk(p.apkId)}>Publish</Button>
                  <Button size="sm" variant="danger" onClick={() => rejectApk(p.apkId)}>Reject</Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="surface overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead className="hidden md:table-cell">Package</TableHead>
              <TableHead>Visibility</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden lg:table-cell">Updated</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {apps.map((app) => (
              <TableRow key={app.id}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <div className="relative shrink-0">
                      <AppIcon iconPath={app.icon_path} name={app.name} size={36} version={app.updated_at} />
                      <NsfwTag active={app.is_nsfw} />
                    </div>
                    <Link href={`/apps/${app.package_name}`} className="text-sm font-semibold text-ink hover:underline">
                      {app.name}
                    </Link>
                  </div>
                </TableCell>
                <TableCell className="hidden md:table-cell font-mono text-[11px] text-ink-mute">{app.package_name}</TableCell>
                <TableCell><Badge variant="outline">{app.visibility}</Badge></TableCell>
                <TableCell>
                  <Badge variant={app.status === "published" ? "primary" : "soft"}>
                    {app.status.replace("_", " ")}
                  </Badge>
                </TableCell>
                <TableCell className="hidden lg:table-cell text-xs text-ink-mute">
                  {new Date(app.updated_at).toLocaleDateString()}
                </TableCell>
                <TableCell className="space-x-1 text-right">
                  <Button asChild size="sm" variant="outlined">
                    <Link href={`/my-apps/${app.id}`}>Edit</Link>
                  </Button>
                  <Button size="sm" variant="outlined" onClick={() => rescanApp(app.id, app.name)} disabled={busyId === app.id || bulkBusy}>
                    {busyId === app.id ? "…" : "Rescan"}
                  </Button>
                  {app.status !== "published" && (
                    <Button size="sm" variant="filled" onClick={() => setStatus(app.id, "published")}>Publish</Button>
                  )}
                  {app.status !== "archived" && (
                    <Button size="sm" variant="ghost" onClick={() => setStatus(app.id, "archived")}>Archive</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {apps.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center italic text-ink-mute">
                  No apps match this filter.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
