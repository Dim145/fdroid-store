"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { AppIcon } from "@/components/app-icon";
import { AppPermissions } from "@/components/app-permissions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, mediaUrl, type AppDetail } from "@/lib/api";
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

  const screenshots = [...app.screenshots].sort((a, b) => a.display_order - b.display_order);
  // Permissions of the most recent published version — that's what a fresh
  // install will request.
  const latestPublished = app.apks
    .filter((a) => a.status === "published")
    .sort((a, b) => b.version_code - a.version_code)[0];

  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <AppIcon iconPath={app.icon_path} name={app.name} size={88} version={app.updated_at} />
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-3xl font-bold tracking-tight">{app.name}</h1>
            <Badge variant={app.visibility === "private" ? "secondary" : "default"}>
              {app.visibility}
            </Badge>
            <Badge variant="outline">{app.status}</Badge>
          </div>
          <p className="font-mono text-sm text-muted-foreground">{app.package_name}</p>
          {app.summary && <p className="text-base">{app.summary}</p>}
        </div>
      </header>

      {latestPublished?.whats_new && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What&apos;s new</CardTitle>
            <CardDescription>
              In version {latestPublished.version_name} ({latestPublished.version_code})
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm">{latestPublished.whats_new}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">About</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
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

      {screenshots.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Screenshots</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3 overflow-x-auto pb-2">
              {screenshots.map((s) => {
                const url = mediaUrl(s.storage_key);
                if (!url) return null;
                return (
                  // eslint-disable-next-line @next/next/no-img-element
                  <a key={s.id} href={url} target="_blank" rel="noopener noreferrer" className="shrink-0">
                    <img
                      src={url}
                      alt={`Screenshot of ${app.name}`}
                      loading="lazy"
                      className="h-72 w-auto rounded border bg-muted object-contain"
                    />
                  </a>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {latestPublished && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Permissions</CardTitle>
            <CardDescription>
              What the app asks Android to grant on install.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AppPermissions
              permissions={latestPublished.permissions}
              versionLabel={`${latestPublished.version_name} (${latestPublished.version_code})`}
            />
          </CardContent>
        </Card>
      )}

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
