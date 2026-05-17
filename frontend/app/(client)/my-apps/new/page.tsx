"use client";

import { Upload, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { AuthGuard } from "@/components/auth-guard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
      setError("Drop an APK first.");
      return;
    }
    setError(null); setSubmitting(true);
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
    <div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            href="/my-apps"
            className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" /> My apps
          </Link>
          <h1 className="text-3xl font-bold tracking-tight text-ink md:text-4xl">New release</h1>
          <p className="mt-1 text-ink-soft">Drop an APK and we&apos;ll pre-fill what we can.</p>
        </div>
      </header>

      {error && (
        <p className="mb-4 rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{error}</p>
      )}

      <form onSubmit={onSubmit} className="space-y-6">
        {/* Step 1 — drop zone */}
        <section className="surface p-6">
          <Step num="01" title="Pick the APK" />
          <label className="mt-4 block">
            <div className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-outline px-6 py-10 text-center transition-colors hover:border-primary hover:bg-primary/5">
              <div className="flex h-12 w-12 items-center justify-center rounded-pill bg-primary-container text-primary-on-container">
                <Upload className="h-5 w-5" strokeWidth={2.2} />
              </div>
              <div>
                <div className="text-sm font-semibold text-ink">
                  {file ? file.name : "Click to choose an APK"}
                </div>
                <div className="text-xs text-ink-mute">
                  {file ? formatBytes(file.size) : ".apk · drag & drop supported"}
                </div>
              </div>
            </div>
            <input
              type="file"
              accept=".apk,application/vnd.android.package-archive"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onPickFile(f);
              }}
              className="sr-only"
            />
          </label>

          {inspecting && (
            <p className="mt-3 inline-flex items-center gap-2 text-sm text-ink-mute">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-outline-soft border-t-primary" />
              Parsing manifest…
            </p>
          )}

          {inspect && (
            <dl className="mt-5 grid gap-3 rounded-xl bg-surface-2 p-4 md:grid-cols-3">
              <Spec label="Package" value={inspect.package_name} mono />
              <Spec label="Version" value={`${inspect.version_name} (${inspect.version_code})`} mono />
              <Spec label="Size" value={formatBytes(inspect.size_bytes)} mono />
              <Spec label="SDK" value={`${inspect.min_sdk}–${inspect.target_sdk}`} mono />
              <Spec label="ABIs" value={inspect.native_code.join(", ") || "—"} mono />
              <Spec label="Permissions" value={String(inspect.permissions.length)} mono />
            </dl>
          )}
        </section>

        {/* Step 2 — listing */}
        <section className="surface p-6">
          <Step num="02" title="Listing" />
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Field label="Title *" htmlFor="name">
              <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Package name *" htmlFor="pkg">
              <Input id="pkg" required value={packageName} onChange={(e) => setPackageName(e.target.value)} className="font-mono text-xs" />
            </Field>
            <Field label="Visibility" htmlFor="vis">
              <select
                id="vis"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as "public" | "private")}
                className="h-12 w-full rounded-xl border border-outline bg-surface px-3 text-sm focus:border-primary focus:outline-none"
              >
                <option value="public">Public · open catalogue</option>
                <option value="private">Private · API key required</option>
              </select>
            </Field>
            <Field label="Summary" htmlFor="sum">
              <Input id="sum" value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={255} placeholder="One-liner" />
            </Field>
            <Field label="Description" htmlFor="desc" className="md:col-span-2">
              <textarea
                id="desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={6}
                className="w-full rounded-xl border border-outline bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
                placeholder="What does it do? Highlights, screenshots context, etc."
              />
            </Field>
          </div>
        </section>

        {/* Step 3 — about */}
        <section className="surface p-6">
          <Step num="03" title="Links & credits (optional)" />
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Field label="Author" htmlFor="author">
              <Input id="author" value={authorName} onChange={(e) => setAuthorName(e.target.value)} />
            </Field>
            <Field label="License" htmlFor="lic">
              <Input id="lic" value={license} onChange={(e) => setLicense(e.target.value)} placeholder="GPL-3.0-only" />
            </Field>
            <Field label="Website" htmlFor="web">
              <Input id="web" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </Field>
            <Field label="Source code" htmlFor="src">
              <Input id="src" type="url" value={sourceCode} onChange={(e) => setSourceCode(e.target.value)} />
            </Field>
            <Field label="Issue tracker" htmlFor="issue" className="md:col-span-2">
              <Input id="issue" type="url" value={issueTracker} onChange={(e) => setIssueTracker(e.target.value)} />
            </Field>
          </div>
        </section>

        <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-2xl border border-outline-soft bg-surface/90 p-3 shadow-e3 backdrop-blur">
          <p className="text-sm text-ink-soft">
            {inspect ? "Ready when you are." : "Step 1: pick an APK to continue."}
          </p>
          <div className="flex gap-2">
            <Button asChild variant="text" type="button">
              <Link href="/my-apps">Cancel</Link>
            </Button>
            <Button type="submit" variant="filled" size="lg" disabled={!inspect || submitting}>
              {submitting ? "Publishing…" : "Publish release"}
            </Button>
          </div>
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
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-1.5 ${className || ""}`}>
      <Label htmlFor={htmlFor} className="text-sm font-medium text-ink-soft">{label}</Label>
      {children}
    </div>
  );
}

function Spec({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-mute">{label}</div>
      <div className={mono ? "font-mono text-xs text-ink" : "text-sm text-ink"}>{value}</div>
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

// silence import-only guard
void Badge;
