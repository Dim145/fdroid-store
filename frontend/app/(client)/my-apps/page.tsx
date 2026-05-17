"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AuthGuard } from "@/components/auth-guard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type AppSummary, type Category } from "@/lib/api";

function MyAppsInner() {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);

  // create
  const [pkg, setPkg] = useState("");
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");

  // upload
  const [uploadFor, setUploadFor] = useState<string | null>(null);

  async function refresh() {
    try {
      const [a, c] = await Promise.all([api.apps.myApps(), api.categories.list()]);
      setApps(a);
      setCategories(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  async function createApp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.apps.create({
        package_name: pkg,
        name,
        summary: summary || undefined,
        visibility,
      });
      setPkg(""); setName(""); setSummary("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    }
  }

  async function uploadApk(appId: string, file: File) {
    setError(null);
    try {
      await api.apps.uploadApk(appId, file);
      setUploadFor(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">My apps</h1>
        <p className="text-muted-foreground">Manage the apps you own and upload new APK versions.</p>
      </header>

      {error && <p className="text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Create app</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={createApp} className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pkg">Package name</Label>
              <Input id="pkg" required placeholder="com.example.myapp" value={pkg} onChange={(e) => setPkg(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="name">Display name</Label>
              <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="sum">Summary</Label>
              <Input id="sum" value={summary} onChange={(e) => setSummary(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vis">Visibility</Label>
              <select
                id="vis"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as "public" | "private")}
              >
                <option value="public">Public — included in the public repo</option>
                <option value="private">Private — only via API-key auth</option>
              </select>
            </div>
            <div className="flex items-end">
              <Button type="submit" className="w-full">Create</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your apps</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Package</TableHead>
                <TableHead>Visibility</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((app) => (
                <TableRow key={app.id}>
                  <TableCell className="font-medium">
                    <Link href={`/apps/${app.package_name}`} className="hover:underline">
                      {app.name}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{app.package_name}</TableCell>
                  <TableCell><Badge variant="outline">{app.visibility}</Badge></TableCell>
                  <TableCell><Badge variant={app.status === "published" ? "success" : "outline"}>{app.status}</Badge></TableCell>
                  <TableCell className="space-x-2 text-right">
                    {uploadFor === app.id ? (
                      <input
                        type="file"
                        accept=".apk,application/vnd.android.package-archive"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) uploadApk(app.id, f);
                        }}
                      />
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => setUploadFor(app.id)}>
                        Upload APK
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {apps.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    You have no apps yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Categories available: {categories.map((c) => c.name).join(", ") || "—"}
      </p>
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
