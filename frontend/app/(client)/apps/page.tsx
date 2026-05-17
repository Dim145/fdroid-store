"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, type AppSummary } from "@/lib/api";

export default function AppsBrowsePage() {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      api
        .apps.list(q || undefined)
        .then((res) => !cancelled && setApps(res))
        .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Failed"))
        .finally(() => !cancelled && setLoading(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Browse apps</h1>
          <p className="text-muted-foreground">
            Public published apps. Sign in to see private ones you have access to.
          </p>
        </div>
        <Input
          placeholder="Search package or name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-xs"
        />
      </div>

      {error && <p className="text-destructive">{error}</p>}

      {loading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : apps.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No apps published yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {apps.map((app) => (
            <Link key={app.id} href={`/apps/${app.package_name}`}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle>{app.name}</CardTitle>
                      <CardDescription className="font-mono text-xs">
                        {app.package_name}
                      </CardDescription>
                    </div>
                    {app.visibility === "private" && (
                      <Badge variant="secondary">private</Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {app.summary || "—"}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {app.categories.slice(0, 3).map((c) => (
                      <Badge key={c.id} variant="outline" className="text-[10px]">
                        {c.name}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
