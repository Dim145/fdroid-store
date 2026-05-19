"use client";

import { ArrowLeft, FileCode2, ShieldAlert, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { AuthGuard } from "@/components/auth-guard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type ApkInspect } from "@/lib/api";
import { formatBytes } from "@/lib/utils";

function NewAppInner() {
  const { t } = useTranslation();
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

  // metadata.yml paste-and-prefill — collapsed by default to keep the
  // page calm; the user expands it from the eyebrow on Step 02.
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [metadataYaml, setMetadataYaml] = useState("");
  const [importing, setImporting] = useState(false);

  async function onImportMetadata() {
    if (!metadataYaml.trim()) return;
    setImporting(true);
    setError(null);
    try {
      const parsed = await api.importMetadata(metadataYaml);
      // Only fill fields the user hasn't already typed into — we don't
      // want to clobber a manual edit because they pasted a YAML after.
      if (parsed.name && !name) setName(parsed.name);
      if (parsed.summary && !summary) setSummary(parsed.summary);
      if (parsed.description && !description) setDescription(parsed.description);
      if (parsed.license && !license) setLicense(parsed.license);
      if (parsed.author_name && !authorName) setAuthorName(parsed.author_name);
      if (parsed.website && !website) setWebsite(parsed.website);
      if (parsed.source_code && !sourceCode) setSourceCode(parsed.source_code);
      if (parsed.issue_tracker && !issueTracker) setIssueTracker(parsed.issue_tracker);
      setMetadataOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("myApps.new.metadataImportFailed"));
    } finally {
      setImporting(false);
    }
  }

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
      setError(e instanceof Error ? e.message : t("myApps.new.parseFailed"));
      setFile(null);
    } finally {
      setInspecting(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !inspect) {
      setError(t("myApps.new.dropApkFirst"));
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
      setError(e instanceof Error ? e.message : t("myApps.new.createFailed"));
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
            <ArrowLeft className="h-4 w-4" /> {t("myApps.new.backLink")}
          </Link>
          <h1 className="text-3xl font-bold tracking-tight text-ink md:text-4xl">{t("myApps.new.title")}</h1>
          <p className="mt-1 text-ink-soft">{t("myApps.new.subtitle")}</p>
        </div>
      </header>

      {error && (
        <p className="mb-4 rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{error}</p>
      )}

      <form onSubmit={onSubmit} className="space-y-6">
        {/* Step 1 — drop zone */}
        <section className="surface p-6">
          <Step num="01" title={t("myApps.new.step1")} />
          <label className="mt-4 block">
            <div className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-outline px-6 py-10 text-center transition-colors hover:border-primary hover:bg-primary/5">
              <div className="flex h-12 w-12 items-center justify-center rounded-pill bg-primary-container text-primary-on-container">
                <Upload className="h-5 w-5" strokeWidth={2.2} />
              </div>
              <div>
                <div className="text-sm font-semibold text-ink">
                  {file ? file.name : t("myApps.new.dropPrompt")}
                </div>
                <div className="text-xs text-ink-mute">
                  {file ? formatBytes(file.size) : t("myApps.new.dropHint")}
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
              {t("myApps.new.parsingManifest")}
            </p>
          )}

          {inspect && (
            <>
              <dl className="mt-5 grid gap-3 rounded-xl bg-surface-2 p-4 md:grid-cols-3">
                <Spec label={t("myApps.new.specPackage")} value={inspect.package_name} mono />
                <Spec label={t("myApps.new.specVersion")} value={`${inspect.version_name} (${inspect.version_code})`} mono />
                <Spec label={t("myApps.new.specSize")} value={formatBytes(inspect.size_bytes)} mono />
                <Spec label={t("myApps.new.specSdk")} value={`${inspect.min_sdk}–${inspect.target_sdk}`} mono />
                <Spec label={t("myApps.new.specAbis")} value={inspect.native_code.join(", ") || "—"} mono />
                <Spec label={t("myApps.new.specPermissions")} value={String(inspect.permissions.length)} mono />
              </dl>
              {/* Heuristic anti-feature suggestion. Each chip is a flag the
                  scanner detected inside the APK; the user can review and
                  toggle them once on the app detail page (the scanner can
                  false-positive on shaded libs). */}
              {Object.keys(inspect.detected_anti_features).length > 0 && (
                <div className="mt-5 rounded-xl border border-accent/40 bg-accent-container/30 p-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-accent-on-container">
                    <ShieldAlert className="h-4 w-4" />
                    {t("myApps.new.detectedHeader")}
                  </div>
                  <p className="mb-3 text-xs text-ink-soft">
                    {t("myApps.new.detectedBody")}
                  </p>
                  <ul className="flex flex-wrap gap-1.5">
                    {Object.entries(inspect.detected_anti_features).flatMap(([flag, labels]) =>
                      labels.map((label) => (
                        <li
                          key={`${flag}:${label}`}
                          className="rounded-pill bg-surface px-2.5 py-1 text-xs"
                          title={label}
                        >
                          <span className="font-mono text-[10px] text-ink-mute">{flag}</span>
                          {" "}
                          <span className="text-ink">{label}</span>
                        </li>
                      ))
                    )}
                  </ul>
                </div>
              )}
            </>
          )}
        </section>

        {/* Step 2 — listing */}
        <section className="surface p-6">
          <div className="flex items-start justify-between gap-3">
            <Step num="02" title={t("myApps.new.step2")} />
            <button
              type="button"
              onClick={() => setMetadataOpen((o) => !o)}
              className="inline-flex items-center gap-1.5 rounded-pill border border-outline-soft bg-surface px-3 py-1.5 text-xs font-medium text-ink-soft hover:border-primary hover:text-primary"
            >
              <FileCode2 className="h-3.5 w-3.5" />
              {t("myApps.new.metadataImportLabel")}
            </button>
          </div>
          {metadataOpen && (
            <div className="mt-4 rounded-2xl border border-outline-soft bg-surface-2/40 p-4">
              <p className="mb-2 text-xs text-ink-soft">
                {t("myApps.new.metadataImportBody")}
              </p>
              <textarea
                value={metadataYaml}
                onChange={(e) => setMetadataYaml(e.target.value)}
                rows={8}
                className="w-full rounded-xl border border-outline bg-surface px-3 py-2 font-mono text-xs focus:border-primary focus:outline-none"
                placeholder={"Name: My Cool App\nSummary: …\nDescription: …\nLicense: GPL-3.0\nWebSite: …"}
              />
              <div className="mt-2 flex gap-2">
                <Button
                  type="button"
                  variant="filled"
                  size="sm"
                  onClick={onImportMetadata}
                  disabled={importing || !metadataYaml.trim()}
                >
                  {importing ? t("common.loading") : t("myApps.new.metadataImportApply")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => { setMetadataOpen(false); setMetadataYaml(""); }}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          )}
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Field label={t("myApps.new.titleLabel")} htmlFor="name">
              <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t("myApps.new.packageNameLabel")} htmlFor="pkg">
              <Input id="pkg" required value={packageName} onChange={(e) => setPackageName(e.target.value)} className="font-mono text-xs" />
            </Field>
            <Field label={t("myApps.new.visibilityLabel")} htmlFor="vis">
              <select
                id="vis"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as "public" | "private")}
                className="h-12 w-full rounded-xl border border-outline bg-surface px-3 text-sm focus:border-primary focus:outline-none"
              >
                <option value="public">{t("myApps.new.visibilityPublic")}</option>
                <option value="private">{t("myApps.new.visibilityPrivate")}</option>
              </select>
            </Field>
            <Field label={t("myApps.new.summaryLabel")} htmlFor="sum">
              <Input id="sum" value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={255} placeholder={t("myApps.new.summaryPlaceholder")} />
            </Field>
            <Field label={t("myApps.new.descriptionLabel")} htmlFor="desc" className="md:col-span-2">
              <textarea
                id="desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={6}
                className="w-full rounded-xl border border-outline bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
                placeholder={t("myApps.new.descriptionPlaceholder")}
              />
            </Field>
          </div>
        </section>

        {/* Step 3 — about */}
        <section className="surface p-6">
          <Step num="03" title={t("myApps.new.step3")} />
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Field label={t("myApps.new.author")} htmlFor="author">
              <Input id="author" value={authorName} onChange={(e) => setAuthorName(e.target.value)} />
            </Field>
            <Field label={t("myApps.new.license")} htmlFor="lic">
              <Input id="lic" value={license} onChange={(e) => setLicense(e.target.value)} placeholder={t("myApps.new.licensePlaceholder")} />
            </Field>
            <Field label={t("myApps.new.website")} htmlFor="web">
              <Input id="web" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </Field>
            <Field label={t("myApps.new.sourceCode")} htmlFor="src">
              <Input id="src" type="url" value={sourceCode} onChange={(e) => setSourceCode(e.target.value)} />
            </Field>
            <Field label={t("myApps.new.issueTracker")} htmlFor="issue" className="md:col-span-2">
              <Input id="issue" type="url" value={issueTracker} onChange={(e) => setIssueTracker(e.target.value)} />
            </Field>
          </div>
        </section>

        <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-2xl border border-outline-soft bg-surface/90 p-3 shadow-e3 backdrop-blur">
          <p className="text-sm text-ink-soft">
            {inspect ? t("myApps.new.ready") : t("myApps.new.pickFirst")}
          </p>
          <div className="flex gap-2">
            <Button asChild variant="text" type="button">
              <Link href="/my-apps">{t("myApps.new.cancel")}</Link>
            </Button>
            <Button type="submit" variant="filled" size="lg" disabled={!inspect || submitting}>
              {submitting ? t("myApps.new.publishing") : t("myApps.new.publish")}
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
