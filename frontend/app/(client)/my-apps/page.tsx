"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AppIcon } from "@/components/app-icon";
import { AuthGuard } from "@/components/auth-guard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type AppSummary } from "@/lib/api";
import { formatDate } from "@/lib/utils";

function MyAppsInner() {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.apps.myApps()
      .then(setApps)
      .catch((e) => setError(e instanceof Error ? e.message : "Load failed"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">My apps</h1>
          <p className="text-muted-foreground">
            Apps you own. Upload an APK to publish a new version.
          </p>
        </div>
        <Button asChild>
          <Link href="/my-apps/new">+ New app</Link>
        </Button>
      </header>

      {error && <p className="text-destructive">{error}</p>}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <p className="p-6 text-muted-foreground">Loading…</p>
          ) : apps.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">
              You haven&apos;t published anything yet.{" "}
              <Link href="/my-apps/new" className="text-primary hover:underline">
                Create your first app
              </Link>.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Package</TableHead>
                  <TableHead>Visibility</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last update</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apps.map((app) => (
                  <TableRow key={app.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-3">
                        <AppIcon iconPath={app.icon_path} name={app.name} size={32} version={app.updated_at} />
                        {app.name}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{app.package_name}</TableCell>
                    <TableCell><Badge variant="outline">{app.visibility}</Badge></TableCell>
                    <TableCell>
                      <Badge variant={app.status === "published" ? "success" : "outline"}>
                        {app.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatDate(app.last_published_at || app.updated_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/my-apps/${app.id}`}>Manage</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function MyAppsPage() {
  return (
    <AuthGuard>
      <MyAppsInner />
    </AuthGuard>
  );
}
