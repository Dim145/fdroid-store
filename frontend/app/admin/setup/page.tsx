"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

export default function SetupWizardPage() {
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  const [repoName, setRepoName] = useState("My F-Droid Repo");
  const [repoDesc, setRepoDesc] = useState("");
  const [repoAddr, setRepoAddr] = useState(
    process.env.NEXT_PUBLIC_REPO_URL || "http://localhost:8080/fdroid/repo"
  );
  const [mode, setMode] = useState<"generate" | "import">("generate");
  const [ksPwd, setKsPwd] = useState("");
  const [keyAlias, setKeyAlias] = useState("repokey");
  const [keyPwd, setKeyPwd] = useState("");
  const [dname, setDname] = useState("CN=fdroid-store, OU=Self-hosted, O=Self, L=City, ST=State, C=US");
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function refresh() {
    try {
      const s = await api.setup.status();
      setSetupComplete(s.setup_complete);
    } catch {
      setSetupComplete(false);
    }
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
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Setup failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Setup wizard</h1>
        <p className="text-muted-foreground">
          {setupComplete
            ? "Setup is already complete. You can re-run the wizard to rotate the signing key."
            : "Finish the one-time setup of your F-Droid repository."}
        </p>
      </header>

      {msg && <p className="text-sm text-emerald-600">{msg}</p>}
      {err && <p className="text-sm text-destructive">{err}</p>}

      <form onSubmit={submit} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Repository</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="rn">Repo name</Label>
              <Input id="rn" required value={repoName} onChange={(e) => setRepoName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rd">Description</Label>
              <Input id="rd" value={repoDesc} onChange={(e) => setRepoDesc(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ra">Public address</Label>
              <Input id="ra" required value={repoAddr} onChange={(e) => setRepoAddr(e.target.value)} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Signing key</CardTitle>
            <CardDescription>
              Generate a new keystore, or import an existing PKCS#12 / JKS file.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" checked={mode === "generate"} onChange={() => setMode("generate")} />
                Generate
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" checked={mode === "import"} onChange={() => setMode("import")} />
                Import existing
              </label>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ksp">Keystore password</Label>
              <Input id="ksp" type="password" required value={ksPwd} onChange={(e) => setKsPwd(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ka">Key alias</Label>
              <Input id="ka" value={keyAlias} onChange={(e) => setKeyAlias(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kp">Key password (optional, defaults to keystore password)</Label>
              <Input id="kp" type="password" value={keyPwd} onChange={(e) => setKeyPwd(e.target.value)} />
            </div>

            {mode === "generate" && (
              <div className="space-y-1.5">
                <Label htmlFor="dn">Distinguished name</Label>
                <Input id="dn" value={dname} onChange={(e) => setDname(e.target.value)} />
              </div>
            )}
            {mode === "import" && (
              <div className="space-y-1.5">
                <Label htmlFor="kf">Keystore file (.p12 / .jks)</Label>
                <Input id="kf" type="file" accept=".p12,.jks,.pkcs12" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Setting up…" : "Run setup"}
          </Button>
        </div>
      </form>
    </div>
  );
}
