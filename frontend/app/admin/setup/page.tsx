"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, REPO_URL } from "@/lib/api";
import { useRepoInfo } from "@/lib/repo-store";
import { cn } from "@/lib/utils";

export default function SetupWizardPage() {
  const repo = useRepoInfo();
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  const [repoName, setRepoName] = useState("My F-Droid Repo");
  const [repoDesc, setRepoDesc] = useState("");
  const [repoAddr, setRepoAddr] = useState(REPO_URL);
  const [addrTouched, setAddrTouched] = useState(false);
  const [mode, setMode] = useState<"generate" | "import">("generate");
  const [ksPwd, setKsPwd] = useState("");
  const [keyAlias, setKeyAlias] = useState("repokey");
  const [keyPwd, setKeyPwd] = useState("");
  const [dname, setDname] = useState("CN=fdroid-store, OU=Self-hosted, O=Self, L=City, ST=State, C=US");
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Once the live config arrives, hydrate the form with the current values
  // (admin re-running the wizard expects to see the existing settings).
  useEffect(() => {
    if (!repo.loaded) return;
    if (repo.name) setRepoName((cur) => (cur === "My F-Droid Repo" ? repo.name! : cur));
    if (repo.description) setRepoDesc((cur) => cur || repo.description!);
    if (repo.url && !addrTouched) setRepoAddr(repo.url);
  }, [repo.loaded, repo.name, repo.description, repo.url, addrTouched]);

  async function refresh() {
    try { const s = await api.setup.status(); setSetupComplete(s.setup_complete); }
    catch { setSetupComplete(false); }
  }
  useEffect(() => { refresh(); }, []);

  async function readFileAsBase64(f: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const result = r.result as string;
        const idx = result.indexOf(",");
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      r.onerror = reject;
      r.readAsDataURL(f);
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setMsg(null); setSubmitting(true);
    try {
      let keystoreB64: string | undefined;
      if (mode === "import") {
        if (!file) throw new Error("Please select a keystore file");
        keystoreB64 = await readFileAsBase64(file);
      }
      await api.setup.wizard({
        repo_name: repoName,
        repo_description: repoDesc || undefined,
        repo_address: repoAddr,
        keystore_mode: mode,
        keystore_password: ksPwd || undefined,
        key_alias: keyAlias || undefined,
        key_password: keyPwd || ksPwd || undefined,
        key_dname: mode === "generate" ? dname : undefined,
        keystore_b64: keystoreB64,
      });
      setMsg("Setup complete. The repo index will be generated on the next reindex.");
      // Re-pull both the local setup state and the global repo info so any
      // QR codes / install links elsewhere in the app pick up the new
      // address + fingerprint immediately.
      await Promise.all([refresh(), repo.refresh()]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Setup failed");
    } finally { setSubmitting(false); }
  }

  return (
    <div className="space-y-6">
      <header>
        <div className="eyebrow">Admin</div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">Setup wizard</h1>
        <p className="mt-1 text-ink-soft">
          {setupComplete
            ? "Setup is complete. Re-run to rotate the signing key."
            : "Finish the one-time configuration to start serving the catalogue."}
        </p>
      </header>

      {msg && <p className="rounded-xl border border-primary bg-primary-container px-3 py-2 text-sm text-primary-on-container">{msg}</p>}
      {err && <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{err}</p>}

      <form onSubmit={submit} className="space-y-6">
        <section className="surface p-6">
          <Step num="01" title="Repository" />
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Field label="Repo name" htmlFor="rn" className="md:col-span-2">
              <Input id="rn" required value={repoName} onChange={(e) => setRepoName(e.target.value)} />
            </Field>
            <Field label="Description" htmlFor="rd" className="md:col-span-2">
              <Input id="rd" value={repoDesc} onChange={(e) => setRepoDesc(e.target.value)} />
            </Field>
            <Field label="Public address" htmlFor="ra" className="md:col-span-2">
              <Input
                id="ra"
                required
                value={repoAddr}
                onChange={(e) => { setRepoAddr(e.target.value); setAddrTouched(true); }}
              />
            </Field>
          </div>
        </section>

        <section className="surface p-6">
          <Step num="02" title="Signing key" />
          <div className="mt-4 mb-4 flex gap-2">
            <ModeChip active={mode === "generate"} onClick={() => setMode("generate")}>Generate</ModeChip>
            <ModeChip active={mode === "import"} onClick={() => setMode("import")}>Import existing</ModeChip>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Keystore password" htmlFor="ksp" className="md:col-span-2">
              <Input id="ksp" type="password" required value={ksPwd} onChange={(e) => setKsPwd(e.target.value)} />
            </Field>
            <Field label="Key alias" htmlFor="ka">
              <Input id="ka" value={keyAlias} onChange={(e) => setKeyAlias(e.target.value)} />
            </Field>
            <Field label="Key password (optional)" htmlFor="kp">
              <Input id="kp" type="password" value={keyPwd} onChange={(e) => setKeyPwd(e.target.value)} />
            </Field>
            {mode === "generate" && (
              <Field label="Distinguished name" htmlFor="dn" className="md:col-span-2">
                <Input id="dn" value={dname} onChange={(e) => setDname(e.target.value)} />
              </Field>
            )}
            {mode === "import" && (
              <Field label="Keystore file (.p12 / .jks)" htmlFor="kf" className="md:col-span-2">
                <Input id="kf" type="file" accept=".p12,.jks,.pkcs12" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </Field>
            )}
          </div>
        </section>

        <div className="flex justify-end">
          <Button type="submit" variant="filled" size="xl" disabled={submitting}>
            {submitting ? "Setting up…" : "Run setup"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Step({ num, title }: { num: string; title: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-9 w-9 items-center justify-center rounded-pill bg-primary-container font-mono text-sm font-bold text-primary-on-container">
        {num}
      </span>
      <h2 className="text-xl font-bold tracking-tight text-ink">{title}</h2>
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

function ModeChip({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-9 rounded-pill px-4 text-sm font-semibold transition-colors",
        active
          ? "bg-primary text-primary-fg"
          : "bg-surface-2 text-ink-soft hover:bg-surface-3 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
