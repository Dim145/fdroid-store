"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type AdminStats } from "@/lib/api";

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);

  async function refresh() {
    try {
      setStats(await api.admin.stats());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  }
  useEffect(() => { refresh(); }, []);

  async function reindex() {
    setReindexing(true);
    try {
      await api.admin.reindex();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reindex failed");
    } finally {
      setReindexing(false);
      setTimeout(refresh, 1500);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">Overview of the repository.</p>
        </div>
        <Button onClick={reindex} disabled={reindexing}>
          {reindexing ? "Queuing…" : "Trigger reindex"}
        </Button>
      </header>

      {error && <p className="text-destructive">{error}</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Users" value={stats?.total_users} />
        <StatCard label="Apps" value={stats?.total_apps} hint={stats ? `${stats.published_apps} published` : undefined} />
        <StatCard label="Pending APKs" value={stats?.pending_apks} />
        <StatCard label="Downloads" value={stats?.total_downloads} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent downloads</CardTitle>
          <CardDescription>Last 20 download events.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1 font-mono text-xs">
          {stats?.recent_downloads.length === 0 && (
            <p className="text-muted-foreground">No downloads yet.</p>
          )}
          {stats?.recent_downloads.map((d) => (
            <div key={d.id} className="flex justify-between">
              <span>{new Date(d.created_at).toLocaleString()}</span>
              <span className="text-muted-foreground">
                app {d.app_id.slice(0, 8)} · user {d.user_id?.slice(0, 8) ?? "anon"}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: number | undefined; hint?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl">{value ?? "—"}</CardTitle>
      </CardHeader>
      {hint && <CardContent className="text-xs text-muted-foreground">{hint}</CardContent>}
    </Card>
  );
}
