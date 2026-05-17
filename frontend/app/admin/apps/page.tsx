"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
        // The admin list endpoint includes the apks array via eager-loading.
        // We surface ones in pending_review here so the admin can act quickly.
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

  async function setStatus(id: string, status: string) {
    await api.admin.updateApp(id, { status });
    await refresh();
  }

  async function publishApk(apkId: string) {
    await api.admin.publishApk(apkId);
    await refresh();
  }
  async function rejectApk(apkId: string) {
    const reason = prompt("Reason for rejection?") || "Rejected";
    await api.admin.rejectApk(apkId, reason);
    await refresh();
  }

  async function rescanApp(appId: string, appName: string) {
    setError(null); setMsg(null); setBusyId(appId);
    try {
      const r = await api.admin.rescanApp(appId);
      const msgs = [`${appName}: ${r.rescanned_apks} APK rescanned, ${r.icons_refreshed} icon refreshed`];
      if (r.failed.length) msgs.push(`${r.failed.length} error(s): ${r.failed.join(", ")}`);
      setMsg(msgs.join(" — "));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rescan failed");
    } finally {
      setBusyId(null);
    }
  }

  async function rescanAll() {
    if (!confirm("Rescan every published APK? Can take a while on a large repo.")) return;
    setError(null); setMsg(null); setBulkBusy(true);
    try {
      const r = await api.admin.rescanAll();
      const msgs = [`${r.rescanned_apks} APK rescanned, ${r.icons_refreshed} icon refreshed`];
      if (r.failed.length) msgs.push(`${r.failed.length} error(s): ${r.failed.join(", ")}`);
      setMsg(msgs.join(" — "));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rescan failed");
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Apps & APKs</h1>
          <p className="text-muted-foreground">Moderate and publish.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={rescanAll} disabled={bulkBusy}>
            {bulkBusy ? "Rescanning…" : "Rescan all"}
          </Button>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
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

      {msg && <p className="text-sm text-emerald-600">{msg}</p>}
      {error && <p className="text-destructive">{error}</p>}

      {pendingApks.length > 0 && (
        <Card className="border-amber-500">
          <CardHeader>
            <CardTitle className="text-base">APKs awaiting review</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>App ID</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingApks.map((p) => (
                  <TableRow key={p.apkId}>
                    <TableCell className="font-mono text-xs">{p.appId.slice(0, 8)}…</TableCell>
                    <TableCell>{p.vn} ({p.vc})</TableCell>
                    <TableCell className="space-x-2 text-right">
                      <Button size="sm" onClick={() => publishApk(p.apkId)}>Publish</Button>
                      <Button size="sm" variant="destructive" onClick={() => rejectApk(p.apkId)}>Reject</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>All apps</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Package</TableHead>
                <TableHead>Visibility</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((app) => (
                <TableRow key={app.id}>
                  <TableCell className="font-medium">
                    <Link href={`/apps/${app.package_name}`} className="hover:underline">{app.name}</Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{app.package_name}</TableCell>
                  <TableCell><Badge variant="outline">{app.visibility}</Badge></TableCell>
                  <TableCell><Badge variant={app.status === "published" ? "success" : "outline"}>{app.status}</Badge></TableCell>
                  <TableCell className="text-xs">{new Date(app.updated_at).toLocaleString()}</TableCell>
                  <TableCell className="space-x-2 text-right">
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/my-apps/${app.id}`}>Edit</Link>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => rescanApp(app.id, app.name)}
                      disabled={busyId === app.id || bulkBusy}
                      title="Re-parse APKs and re-extract icon"
                    >
                      {busyId === app.id ? "…" : "Rescan"}
                    </Button>
                    {app.status !== "published" && (
                      <Button size="sm" onClick={() => setStatus(app.id, "published")}>Publish</Button>
                    )}
                    {app.status !== "archived" && (
                      <Button size="sm" variant="outline" onClick={() => setStatus(app.id, "archived")}>Archive</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
