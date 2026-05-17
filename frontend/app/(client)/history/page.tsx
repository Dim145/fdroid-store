"use client";

import { useEffect, useState } from "react";

import { AuthGuard } from "@/components/auth-guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    api
      .downloadHistory()
      .then((res) => setItems(res.items))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Download history</h1>
        <p className="text-muted-foreground">Last 100 APK downloads made with your account.</p>
      </header>

      {error && <p className="text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Recent</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>App ID</TableHead>
                <TableHead>APK ID</TableHead>
                <TableHead>Bytes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>{formatDate(i.created_at)}</TableCell>
                  <TableCell className="font-mono text-xs">{i.app_id.slice(0, 8)}…</TableCell>
                  <TableCell className="font-mono text-xs">{i.apk_id.slice(0, 8)}…</TableCell>
                  <TableCell>{i.bytes_served ? formatBytes(i.bytes_served) : "—"}</TableCell>
                </TableRow>
              ))}
              {items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    No downloads recorded yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
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
