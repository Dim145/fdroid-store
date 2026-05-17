"use client";

import { Image as ImageIcon, KeyRound, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, REPO_URL, type KeystoreInfo, type RepoConfigInfo } from "@/lib/api";
import { useRepoStore } from "@/lib/repo-store";

export default function AdminRepoPage() {
  const refreshGlobalRepo = useRepoStore((s) => s.refresh);
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
      setRepo(r); setKeystore(k);
      setName(r.name); setDesc(r.description || ""); setAddr(r.address);
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
  }
  useEffect(() => { refresh(); }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setMsg(null);
    try {
      await api.admin.updateRepo({ name, description: desc, address: addr });
      setMsg("Saved. Reindex queued.");
      // Propagate to every other page using the live URL (QR codes, footer…).
      await Promise.all([refresh(), refreshGlobalRepo()]);
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
    } catch (e) { setErr(e instanceof Error ? e.message : "Icon upload failed"); }
    finally { setUploadingIcon(false); }
  }
  function iconUrl(): string | null {
    if (!repo?.icon_path) return null;
    const basename = repo.icon_path.split("/").pop();
    if (!basename) return null;
    // Use the configured public address so the preview always reflects what
    // F-Droid clients will fetch. Falls back to the build-time env if the
    // saved address isn't loaded yet.
    const base = (repo.address || REPO_URL).replace(/\/$/, "");
    return `${base}/icons/${basename}?v=${repo.last_index_version}`;
  }

  if (!repo) {
    return <p className="text-sm text-ink-mute">Loading…</p>;
  }

  return (
    <div className="space-y-6">
      <header>
        <div className="eyebrow">Admin</div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">Repository</h1>
      </header>

      {msg && <p className="rounded-xl border border-primary bg-primary-container px-3 py-2 text-sm text-primary-on-container">{msg}</p>}
      {err && <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{err}</p>}

      <section className="surface p-6">
        <h2 className="mb-4 text-lg font-bold tracking-tight text-ink">Public metadata</h2>
        <form onSubmit={save} className="grid gap-4 md:grid-cols-2">
          <Field label="Repo name" htmlFor="rn" className="md:col-span-2">
            <Input id="rn" required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description" htmlFor="rd" className="md:col-span-2">
            <Input id="rd" value={desc} onChange={(e) => setDesc(e.target.value)} />
          </Field>
          <Field label="Public address" htmlFor="ra" className="md:col-span-2">
            <Input id="ra" required value={addr} onChange={(e) => setAddr(e.target.value)} />
            <p className="text-xs text-ink-mute">Must be reachable from Android devices.</p>
          </Field>
          <div className="md:col-span-2 flex justify-end">
            <Button type="submit" variant="filled">Save & reindex</Button>
          </div>
        </form>
      </section>

      <section className="surface p-6">
        <h2 className="mb-4 text-lg font-bold tracking-tight text-ink">Icon</h2>
        <div className="flex flex-wrap items-center gap-5">
          {iconUrl() && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={iconUrl()!} alt="repo icon" className="h-20 w-20 rounded-2xl bg-surface-2 object-cover shadow-e1" />
          )}
          <div className="flex-1">
            <label className="inline-flex">
              <span className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-pill bg-primary-container px-4 text-sm font-semibold text-primary-on-container hover:brightness-[1.04]">
                <ImageIcon className="h-4 w-4" /> Upload icon
              </span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={uploadingIcon}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadIcon(f); e.target.value = ""; }}
                className="sr-only"
              />
            </label>
            <p className="mt-2 font-mono text-[11px] text-ink-mute">{repo.icon_path || "—"}</p>
          </div>
        </div>
      </section>

      <section className="surface p-6">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-bold tracking-tight text-ink">
          <KeyRound className="h-5 w-5" /> Signing key
        </h2>
        {keystore?.present ? (
          <dl className="grid gap-3 md:grid-cols-2">
            <Detail label="Alias" value={keystore.alias} mono />
            <Detail label="Valid until" value={keystore.not_after} />
            <div className="md:col-span-2">
              <div className="text-[10px] uppercase tracking-wider text-ink-mute">Fingerprint SHA-256</div>
              <code className="mt-1 block break-all font-mono text-[11px] text-ink">{keystore.fingerprint_sha256}</code>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-danger">No keystore yet — complete the setup wizard.</p>
        )}
      </section>

      <section className="surface p-6">
        <h2 className="mb-4 text-lg font-bold tracking-tight text-ink">Index state</h2>
        <dl className="grid gap-3 md:grid-cols-2">
          <Detail label="Last index version" value={String(repo.last_index_version)} mono />
          <Detail label="Last indexed" value={repo.last_indexed_at} />
        </dl>
        <div className="mt-4">
          <Button variant="outlined" onClick={() => api.admin.reindex().then(() => setMsg("Reindex queued."))}>
            <RefreshCw className="h-4 w-4" /> Trigger reindex
          </Button>
        </div>
      </section>
    </div>
  );
}

function Field({
  label, htmlFor, className, children,
}: { label: string; htmlFor?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`space-y-1.5 ${className || ""}`}>
      <Label htmlFor={htmlFor} className="text-sm font-medium text-ink-soft">{label}</Label>
      {children}
    </div>
  );
}
function Detail({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-mute">{label}</div>
      <div className={`mt-0.5 text-sm ${mono ? "font-mono" : ""}`}>
        {value || <Badge variant="soft">—</Badge>}
      </div>
    </div>
  );
}
