"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Fragment, useEffect, useState } from "react";

import { AppIcon } from "@/components/app-icon";
import { AppPermissions } from "@/components/app-permissions";
import { AuthGuard } from "@/components/auth-guard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, mediaUrl, type Apk, type AppDetail } from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/utils";

function ManageAppInner() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [app, setApp] = useState<AppDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // form
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [license, setLicense] = useState("");
  const [website, setWebsite] = useState("");
  const [sourceCode, setSourceCode] = useState("");
  const [issueTracker, setIssueTracker] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  async function load() {
    try {
      const detail = await api.apps.get(id);
      setApp(detail);
      setName(detail.name);
      setSummary(detail.summary || "");
      setDescription(detail.description || "");
      setLicense(detail.license || "");
      setWebsite(detail.website || "");
      setSourceCode(detail.source_code || "");
      setIssueTracker(detail.issue_tracker || "");
      setAuthorName(detail.author_name || "");
      setVisibility(detail.visibility);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load app");
    }
  }
  useEffect(() => { if (id) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!app) return;
    setSaving(true); setError(null); setMsg(null);
    try {
      await api.apps.update(app.id, {
        name,
        summary: summary || undefined,
        description: description || undefined,
        license: license || undefined,
        website: website || undefined,
        source_code: sourceCode || undefined,
        issue_tracker: issueTracker || undefined,
        author_name: authorName || undefined,
        visibility,
      });
      setMsg("Saved.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function uploadVersion(file: File) {
    if (!app) return;
    setUploading(true); setError(null); setMsg(null);
    try {
      await api.apps.uploadApk(app.id, file);
      setMsg("New version uploaded.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function deleteApk(apk: Apk) {
    if (!confirm(`Delete version ${apk.version_name} (${apk.version_code})? The file will be removed and the repo reindexed.`)) return;
    try {
      await api.apps.deleteApk(apk.id);
      setMsg("Version deleted.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function deleteApp() {
    if (!app) return;
    if (!confirm(`Delete the entire app ${app.name} and all its versions? This cannot be undone.`)) return;
    try {
      await api.apps.remove(app.id);
      router.replace("/my-apps");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  // Inline-edit state for per-version changelogs.
  const [editingChangelog, setEditingChangelog] = useState<{
    apkId: string;
    text: string;
  } | null>(null);
  const [savingChangelog, setSavingChangelog] = useState(false);

  function startChangelogEdit(apk: Apk) {
    setEditingChangelog({ apkId: apk.id, text: apk.whats_new ?? "" });
  }

  async function saveChangelog() {
    if (!editingChangelog) return;
    setError(null); setMsg(null); setSavingChangelog(true);
    try {
      // Empty string clears the changelog on the backend (mapped to NULL).
      await api.apps.updateApk(editingChangelog.apkId, {
        whats_new: editingChangelog.text || null,
      });
      setMsg("Changelog saved.");
      setEditingChangelog(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingChangelog(false);
    }
  }

  async function uploadCustomIcon(file: File) {
    if (!app) return;
    setError(null); setMsg(null);
    try {
      await api.apps.uploadIcon(app.id, file);
      setMsg("Custom icon uploaded.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Icon upload failed");
    }
  }

  async function revertIcon() {
    if (!app) return;
    if (!confirm("Revert to the icon extracted from the latest APK?")) return;
    setError(null); setMsg(null);
    try {
      await api.apps.revertIcon(app.id);
      setMsg("Icon reverted to auto.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Revert failed");
    }
  }

  async function uploadScreenshots(files: FileList | null) {
    if (!app || !files || files.length === 0) return;
    setError(null); setMsg(null);
    try {
      await api.apps.uploadScreenshots(app.id, Array.from(files));
      setMsg(`${files.length} screenshot${files.length === 1 ? "" : "s"} uploaded.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Screenshot upload failed");
    }
  }

  async function deleteScreenshot(screenshotId: string) {
    if (!app) return;
    if (!confirm("Delete this screenshot?")) return;
    try {
      await api.apps.deleteScreenshot(app.id, screenshotId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  if (!app && !error) return <p className="text-muted-foreground">Loading…</p>;
  if (!app) return <p className="text-destructive">{error}</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <AppIcon iconPath={app.icon_path} name={app.name} size={64} version={app.updated_at} />
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-bold tracking-tight">{app.name}</h1>
              <Badge variant={app.visibility === "private" ? "secondary" : "default"}>{app.visibility}</Badge>
              <Badge variant="outline">{app.status}</Badge>
            </div>
            <p className="font-mono text-sm text-muted-foreground">{app.package_name}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="ghost"><Link href={`/apps/${app.package_name}`}>View public page</Link></Button>
          <Button asChild variant="ghost"><Link href="/my-apps">← Back</Link></Button>
        </div>
      </div>

      {msg && <p className="text-sm text-emerald-600">{msg}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* ----- Metadata ------------------------------------------------ */}
      <form onSubmit={save} className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Listing</CardTitle>
            <CardDescription>
              Package name is immutable — it is locked to the signer of your APKs.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pkg">Package name (locked)</Label>
              <Input id="pkg" disabled value={app.package_name} className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vis">Visibility</Label>
              <select
                id="vis"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as "public" | "private")}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="public">Public</option>
                <option value="private">Private</option>
              </select>
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="sum">Summary</Label>
              <Input id="sum" value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={255} />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="desc">Description</Label>
              <textarea id="desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={6}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>About</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="author">Author</Label>
              <Input id="author" value={authorName} onChange={(e) => setAuthorName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lic">License</Label>
              <Input id="lic" value={license} onChange={(e) => setLicense(e.target.value)} />
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

        <div className="flex justify-end">
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
        </div>
      </form>

      {/* ----- Icon ---------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Icon</CardTitle>
          <CardDescription>
            By default the icon is extracted from the latest published APK.
            Upload a custom one to override it permanently for this app.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-4">
            <AppIcon iconPath={app.icon_path} name={app.name} size={96} version={app.updated_at} />
            <div className="space-y-1 text-sm">
              <div>
                Source: <Badge variant={app.icon_is_custom ? "default" : "outline"}>
                  {app.icon_is_custom ? "custom" : "auto from APK"}
                </Badge>
              </div>
              {app.icon_path && (
                <div className="text-xs text-muted-foreground">
                  Storage: <code className="font-mono">{app.icon_path}</code>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadCustomIcon(f);
                e.target.value = "";
              }}
              className="max-w-md"
            />
            {app.icon_is_custom && (
              <Button type="button" variant="outline" onClick={revertIcon}>
                Revert to auto
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ----- Screenshots --------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Screenshots</CardTitle>
          <CardDescription>
            Displayed below the description in the store and in F-Droid
            clients. PNG/JPEG/WebP, up to 1080×1920.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              uploadScreenshots(e.target.files);
              e.target.value = "";
            }}
            className="max-w-md"
          />
          {app.screenshots.length === 0 ? (
            <p className="text-sm text-muted-foreground">No screenshots yet.</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {[...app.screenshots].sort((a, b) => a.display_order - b.display_order).map((s) => {
                const url = mediaUrl(s.storage_key);
                if (!url) return null;
                return (
                  <div key={s.id} className="group relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt="screenshot"
                      className="h-40 w-auto rounded border bg-muted object-contain"
                    />
                    <button
                      type="button"
                      onClick={() => deleteScreenshot(s.id)}
                      className="absolute right-1 top-1 rounded bg-destructive px-1.5 py-0.5 text-[10px] text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      Delete
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ----- Permissions --------------------------------------------- */}
      {(() => {
        const latest = [...app.apks]
          .filter((a) => a.status === "published")
          .sort((a, b) => b.version_code - a.version_code)[0];
        if (!latest) return null;
        return (
          <Card>
            <CardHeader>
              <CardTitle>Permissions</CardTitle>
              <CardDescription>
                Declared by the latest published APK. Updates automatically when
                you publish a new version.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AppPermissions
                permissions={latest.permissions}
                versionLabel={`${latest.version_name} (${latest.version_code})`}
              />
            </CardContent>
          </Card>
        );
      })()}

      {/* ----- Versions ------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle>Versions</CardTitle>
          <CardDescription>
            Upload a new APK to publish a new version. The signer must match
            previously published versions.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Input
              type="file"
              accept=".apk,application/vnd.android.package-archive"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadVersion(f);
                e.target.value = "";
              }}
              disabled={uploading}
            />
            {uploading && <span className="text-sm text-muted-foreground">Uploading…</span>}
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>SDK</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Changelog</TableHead>
                <TableHead>Added</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {app.apks.map((apk) => {
                const isEditing = editingChangelog?.apkId === apk.id;
                return (
                  <Fragment key={apk.id}>
                    <TableRow>
                      <TableCell className="font-medium">{apk.version_name}</TableCell>
                      <TableCell className="font-mono text-xs">{apk.version_code}</TableCell>
                      <TableCell>{apk.min_sdk}–{apk.target_sdk}</TableCell>
                      <TableCell>{formatBytes(apk.size_bytes)}</TableCell>
                      <TableCell>
                        <Badge variant={apk.status === "published" ? "success" : "outline"}>{apk.status}</Badge>
                      </TableCell>
                      <TableCell>
                        {apk.whats_new ? (
                          <span title={apk.whats_new} className="block max-w-[14rem] truncate text-xs text-muted-foreground">
                            {apk.whats_new}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{formatDate(apk.published_at || apk.created_at)}</TableCell>
                      <TableCell className="space-x-2 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => (isEditing ? setEditingChangelog(null) : startChangelogEdit(apk))}
                        >
                          {isEditing ? "Close" : apk.whats_new ? "Edit changelog" : "Add changelog"}
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => deleteApk(apk)}>Delete</Button>
                      </TableCell>
                    </TableRow>
                    {isEditing && (
                      <TableRow>
                        <TableCell colSpan={8} className="bg-muted/30">
                          <div className="space-y-2 p-2">
                            <Label className="text-xs">
                              Release notes for v{apk.version_name} ({apk.version_code})
                            </Label>
                            <textarea
                              rows={5}
                              value={editingChangelog!.text}
                              onChange={(e) =>
                                setEditingChangelog({ apkId: apk.id, text: e.target.value })
                              }
                              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                              placeholder="• Bug fixes&#10;• New feature&#10;…"
                            />
                            <div className="flex gap-2">
                              <Button size="sm" onClick={saveChangelog} disabled={savingChangelog}>
                                {savingChangelog ? "Saving…" : "Save"}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditingChangelog(null)}
                              >
                                Cancel
                              </Button>
                              {apk.whats_new && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="ml-auto text-destructive"
                                  onClick={async () => {
                                    setEditingChangelog({ apkId: apk.id, text: "" });
                                    // Empty string → backend clears it
                                    setSavingChangelog(true);
                                    try {
                                      await api.apps.updateApk(apk.id, { whats_new: null });
                                      setMsg("Changelog cleared.");
                                      setEditingChangelog(null);
                                      await load();
                                    } catch (e) {
                                      setError(e instanceof Error ? e.message : "Clear failed");
                                    } finally {
                                      setSavingChangelog(false);
                                    }
                                  }}
                                >
                                  Clear
                                </Button>
                              )}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
              {app.apks.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    No versions yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ----- Danger zone -------------------------------------------- */}
      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
          <CardDescription>Deleting the app removes all versions from storage and unpublishes from the repo.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={deleteApp}>Delete this app</Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default function ManageAppPage() {
  return (
    <AuthGuard>
      <ManageAppInner />
    </AuthGuard>
  );
}
