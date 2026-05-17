"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { AuthGuard } from "@/components/auth-guard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type ApkInspect } from "@/lib/api";
import { formatBytes } from "@/lib/utils";

function NewAppInner() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [inspect, setInspect] = useState<ApkInspect | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // form state — pre-filled from APK when available
  const [name, setName] = useState("");
  const [packageName, setPackageName] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [license, setLicense] = useState("");
  const [website, setWebsite] = useState("");
  const [sourceCode, setSourceCode] = useState("");
  const [issueTracker, setIssueTracker] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [submitting, setSubmitting] = useState(false);

  async function onPickFile(picked: File) {
    setError(null);
    setFile(picked);
    setInspect(null);
    setInspecting(true);
    try {
      const info = await api.apps.inspectApk(picked);
      setInspect(info);
      // pre-fill from manifest, but don't overwrite anything the user typed
      if (!packageName) setPackageName(info.package_name);
      if (!name && info.app_name) setName(info.app_name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not parse APK");
      setFile(null);
    } finally {
      setInspecting(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !inspect) {
      setError("Please pick an APK first");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const created = await api.apps.createWithApk({
        file,
        name,
        package_name: packageName || inspect.package_name,
        summary: summary || undefined,
        description: description || undefined,
        license: license || undefined,
        website: website || undefined,
        source_code: sourceCode || undefined,
        issue_tracker: issueTracker || undefined,
        author_name: authorName || undefined,
        visibility,
      });
      router.replace(`/my-apps/${created.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create app");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">New app</h1>
          <p className="text-muted-foreground">
            Pick an APK file — most fields will be filled in for you.
          </p>
        </div>
        <Button asChild variant="ghost">
          <Link href="/my-apps">← Back</Link>
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <form onSubmit={onSubmit} className="space-y-6">
        {/* ----- APK -------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>APK</CardTitle>
            <CardDescription>
              Drop the .apk for the version you want to publish first.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              type="file"
              accept=".apk,application/vnd.android.package-archive"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onPickFile(f);
              }}
            />
            {inspecting && (
              <p className="text-sm text-muted-foreground">Parsing APK…</p>
            )}
            {inspect && (
              <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{inspect.package_name}</Badge>
                  <Badge variant="outline">
                    v{inspect.version_name} ({inspect.version_code})
                  </Badge>
                  <Badge variant="outline">{formatBytes(inspect.size_bytes)}</Badge>
                  <Badge variant="outline">
                    SDK {inspect.min_sdk}–{inspect.target_sdk}
                  </Badge>
                </div>
                <div className="font-mono text-[10px] text-muted-foreground">
                  signer: {inspect.signer_sha256}
                </div>
                <div className="text-xs text-muted-foreground">
                  {inspect.permissions.length} permission{inspect.permissions.length === 1 ? "" : "s"} ·{" "}
                  {inspect.native_code.join(", ") || "no native code"}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ----- Required fields ------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>Listing</CardTitle>
            <CardDescription>What users see in the store.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My great app"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pkg">Package name *</Label>
              <Input
                id="pkg"
                required
                value={packageName}
                onChange={(e) => setPackageName(e.target.value)}
                placeholder="com.example.myapp"
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Must match the APK manifest. Pre-filled.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vis">Visibility</Label>
              <select
                id="vis"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as "public" | "private")}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="public">Public — in the public repo</option>
                <option value="private">Private — only via API key</option>
              </select>
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="sum">Summary</Label>
              <Input
                id="sum"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="Brief one-liner"
                maxLength={255}
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="desc">Description</Label>
              <textarea
                id="desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={6}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                placeholder="Markdown supported by the F-Droid client."
              />
            </div>
          </CardContent>
        </Card>

        {/* ----- About (optional) ------------------------------------ */}
        <Card>
          <CardHeader>
            <CardTitle>About (optional)</CardTitle>
            <CardDescription>Links and author information.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="author">Author</Label>
              <Input id="author" value={authorName} onChange={(e) => setAuthorName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lic">License</Label>
              <Input id="lic" value={license} onChange={(e) => setLicense(e.target.value)} placeholder="GPL-3.0-only" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="web">Website</Label>
              <Input id="web" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="src">Source code</Label>
              <Input id="src" type="url" value={sourceCode} onChange={(e) => setSourceCode(e.target.value)} />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="issue">Issue tracker</Label>
              <Input id="issue" type="url" value={issueTracker} onChange={(e) => setIssueTracker(e.target.value)} />
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-2">
          <Button asChild variant="ghost" type="button">
            <Link href="/my-apps">Cancel</Link>
          </Button>
          <Button type="submit" disabled={!inspect || submitting}>
            {submitting ? "Creating…" : "Create app"}
          </Button>
        </div>
      </form>
    </div>
  );
}

export default function NewAppPage() {
  return (
    <AuthGuard>
      <NewAppInner />
    </AuthGuard>
  );
}
