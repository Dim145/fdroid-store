"use client";

import { useEffect, useState } from "react";

import { AuthGuard } from "@/components/auth-guard";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/utils";

type DLItem = {
  id: string;
  apk_id: string;
  app_id: string;
  created_at: string;
  bytes_served: number | null;
};

function HistoryInner() {
  const [items, setItems] = useState<DLItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.downloadHistory()
      .then((res) => setItems(res.items))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, []);

  const total = items.reduce((sum, i) => sum + (i.bytes_served || 0), 0);

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow">Library</div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">Download history</h1>
          <p className="mt-1 text-ink-mute">Up to the last 100 APK downloads tied to your account.</p>
        </div>
        <div className="surface px-5 py-3 text-right">
          <div className="text-[10px] uppercase tracking-wider text-ink-mute">Total fetched</div>
          <div className="text-2xl font-bold tracking-tight text-ink">{formatBytes(total)}</div>
        </div>
      </header>

      {error && (
        <p className="mb-4 rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{error}</p>
      )}

      <section className="surface overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>App</TableHead>
              <TableHead>APK</TableHead>
              <TableHead className="text-right">Bytes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-10 text-center italic text-ink-mute">
                  No downloads recorded yet.
                </TableCell>
              </TableRow>
            )}
            {items.map((i) => (
              <TableRow key={i.id}>
                <TableCell className="text-xs text-ink-soft">{formatDate(i.created_at)}</TableCell>
                <TableCell className="font-mono text-[11px]">{i.app_id.slice(0, 8)}…</TableCell>
                <TableCell className="font-mono text-[11px]">{i.apk_id.slice(0, 8)}…</TableCell>
                <TableCell className="text-right font-mono text-xs">{i.bytes_served ? formatBytes(i.bytes_served) : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
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
