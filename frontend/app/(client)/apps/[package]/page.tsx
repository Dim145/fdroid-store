"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type AppDetail } from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/utils";

export default function AppDetailPage() {
  const { package: pkg } = useParams<{ package: string }>();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pkg) return;
    api
      .apps.get(decodeURIComponent(pkg))
      .then(setApp)
      .catch((e) => setError(e instanceof Error ? e.message : "Not found"));
  }, [pkg]);

  if (error) return <p className="text-destructive">{error}</p>;
  if (!app) return <p className="text-muted-foreground">Loading…</p>;

  const apkUrl = (filename: string) => {
    const repo = process.env.NEXT_PUBLIC_REPO_URL || "http://localhost:8080/fdroid/repo";
    return `${repo}/${filename}`;
  };

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight">{app.name}</h1>
          <Badge variant={app.visibility === "private" ? "secondary" : "default"}>
            {app.visibility}
          </Badge>
          <Badge variant="outline">{app.status}</Badge>
        </div>
        <p className="font-mono text-sm text-muted-foreground">{app.package_name}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">About</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>{app.summary}</p>
          {app.description && <p className="whitespace-pre-wrap text-muted-foreground">{app.description}</p>}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">License</dt>
            <dd>{app.license || "—"}</dd>
            <dt className="text-muted-foreground">Author</dt>
            <dd>{app.author_name || "—"}</dd>
            <dt className="text-muted-foreground">Source</dt>
            <dd className="truncate">
              {app.source_code ? <a className="text-primary underline" href={app.source_code}>{app.source_code}</a> : "—"}
            </dd>
            <dt className="text-muted-foreground">Website</dt>
            <dd className="truncate">
              {app.website ? <a className="text-primary underline" href={app.website}>{app.website}</a> : "—"}
            </dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">APKs</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>SDK</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Published</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {app.apks.filter((a) => a.status === "published").map((apk) => (
                <TableRow key={apk.id}>
                  <TableCell className="font-medium">{apk.version_name}</TableCell>
                  <TableCell>{apk.version_code}</TableCell>
                  <TableCell>
                    {apk.min_sdk}–{apk.target_sdk}
                  </TableCell>
                  <TableCell>{formatBytes(apk.size_bytes)}</TableCell>
                  <TableCell>{formatDate(apk.published_at)}</TableCell>
                  <TableCell className="text-right">
                    <Button asChild size="sm" variant="outline">
                      <a href={apkUrl(apk.file_name)} download>
                        Download
                      </a>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {app.apks.filter((a) => a.status === "published").length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No published APKs yet.
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
