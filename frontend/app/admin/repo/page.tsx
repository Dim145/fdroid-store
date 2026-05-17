"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type KeystoreInfo, type RepoConfigInfo } from "@/lib/api";

const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL || "http://localhost:8080/fdroid/repo";

export default function AdminRepoPage() {
  const [repo, setRepo] = useState<RepoConfigInfo | null>(null);
  const [keystore, setKeystore] = useState<KeystoreInfo | null>(null);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [addr, setAddr] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [uploadingIcon, setUploadingIcon] = useState(false);

  async function refresh() {
    try {
      const [r, k] = await Promise.all([api.admin.repo(), api.setup.keystoreInfo()]);
      setRepo(r);
      setKeystore(k);
      setName(r.name);
      setDesc(r.description || "");
      setAddr(r.address);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    }
  }
  useEffect(() => { refresh(); }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setMsg(null);
    try {
      await api.admin.updateRepo({ name, description: desc, address: addr });
      setMsg("Saved. A reindex has been queued.");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function uploadIcon(file: File) {
    setErr(null); setMsg(null); setUploadingIcon(true);
    try {
      await api.admin.uploadRepoIcon(file);
      setMsg("Icon uploaded. Reindex queued.");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Icon upload failed");
    } finally {
      setUploadingIcon(false);
    }
  }

  function iconUrl(): string | null {
    if (!repo?.icon_path) return null;
    const basename = repo.icon_path.split("/").pop();
    if (!basename) return null;
    return `${REPO_URL}/icons/${basename}?v=${repo.last_index_version}`;
  }

  if (!repo) return <p className="text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Repo configuration</h1>
        <p className="text-muted-foreground">Edit the public metadata of the F-Droid repository.</p>
      </header>

      {msg && <p className="text-emerald-600 text-sm">{msg}</p>}
      {err && <p className="text-destructive text-sm">{err}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Repository</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={save} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="rn">Name</Label>
              <Input id="rn" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rd">Description</Label>
              <Input id="rd" value={desc} onChange={(e) => setDesc(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ra">Public address</Label>
              <Input id="ra" required value={addr} onChange={(e) => setAddr(e.target.value)} />
              <p className="text-xs text-muted-foreground">Must be reachable from Android devices.</p>
            </div>
            <div className="flex justify-end">
              <Button type="submit">Save</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Repository icon</CardTitle>
          <CardDescription>
            Shown by F-Droid clients. PNG, JPEG or WebP, resized to 512×512 max.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-4">
            {iconUrl() && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={iconUrl()!} alt="repo icon" className="h-16 w-16 rounded border bg-muted" />
            )}
            <div className="flex-1">
              <Input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={uploadingIcon}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadIcon(f);
                  e.target.value = "";
                }}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Current key: <code className="font-mono">{repo.icon_path || "—"}</code>
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Signing key</CardTitle>
          <CardDescription>
            Used to sign the F-Droid index. Re-running the setup wizard rotates it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {keystore?.present ? (
            <>
              <div><span className="text-muted-foreground">Alias:</span> {keystore.alias}</div>
              <div className="font-mono break-all"><span className="text-muted-foreground font-sans">Fingerprint (SHA-256):</span> {keystore.fingerprint_sha256}</div>
              <div><span className="text-muted-foreground">Valid:</span> {keystore.not_before} → {keystore.not_after}</div>
            </>
          ) : (
            <p className="text-amber-600">No keystore yet — finish the setup wizard.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Index state</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <div><span className="text-muted-foreground">Last index version:</span> {repo.last_index_version}</div>
          <div><span className="text-muted-foreground">Last indexed:</span> {repo.last_indexed_at ?? "—"}</div>
          <Button className="mt-2" onClick={() => api.admin.reindex().then(() => setMsg("Reindex queued."))}>
            Trigger reindex now
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
