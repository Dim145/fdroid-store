"use client";

import { ArrowLeft, ChevronDown, ChevronRight, FileCode2, GitBranch, ShieldAlert, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { AuthGuard } from "@/components/auth-guard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, type ApkInspect, type GithubApkInspect, type GithubProvider } from "@/lib/api";
import { cn, formatBytes, formatDate } from "@/lib/utils";

type SourceMode = "apk" | "github";

function NewAppInner() {
  const { t } = useTranslation();
  const router = useRouter();
  const [mode, setMode] = useState<SourceMode>("apk");

  // ---------- APK path state ----------
  const [file, setFile] = useState<File | null>(null);
  const [inspect, setInspect] = useState<ApkInspect | null>(null);
  const [inspecting, setInspecting] = useState(false);

  // ---------- GitHub path state ----------
  const [ghProvider, setGhProvider] = useState<GithubProvider>("github");
  const [ghBaseUrl, setGhBaseUrl] = useState("");
  const [ghRepo, setGhRepo] = useState("");
  const [ghToken, setGhToken] = useState("");
  const [ghPattern, setGhPattern] = useState("");
  const [ghPrereleases, setGhPrereleases] = useState(false);
  const [ghAdvancedOpen, setGhAdvancedOpen] = useState(false);
  const [ghValidating, setGhValidating] = useState(false);
  const [ghInspect, setGhInspect] = useState<GithubApkInspect | null>(null);

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

  async function onValidateGithub() {
    if (!ghRepo.trim()) return;
    setError(null);
    setGhInspect(null);
    setGhValidating(true);
    try {
      const info = await api.apps.inspectGithub({
        repo: ghRepo.trim(),
        provider: ghProvider,
        base_url: ghBaseUrl.trim() || null,
        asset_pattern: ghPattern.trim() || null,
        include_prereleases: ghPrereleases,
        access_token: ghToken.trim() || null,
      });
      setGhInspect(info);
      // Mirror the APK path: prefill the Listing form with values we can
      // derive from the parsed APK. We don't clobber existing user input.
      if (!packageName) setPackageName(info.package_name);
      if (!name && info.app_name) setName(info.app_name);
      // Repo-level metadata enrichments — the GitHub tagline becomes
      // the summary, license/homepage/source/author follow the natural
      // mapping. Skipped when the user already typed something.
      //
      // GitHub allows ~350 chars in its description; our ``summary``
      // column caps at 255. Truncate when seeding so the form submits
      // cleanly. The full text also lands in ``description`` (when
      // empty) so nothing is lost — the operator can re-edit either
      // field before saving.
      if (info.repo_description) {
        if (!summary) {
          const SUMMARY_CAP = 240;
          const raw = info.repo_description.trim();
          setSummary(
            raw.length <= SUMMARY_CAP ? raw : raw.slice(0, SUMMARY_CAP - 1).trimEnd() + "…",
          );
        }
        if (!description) setDescription(info.repo_description.trim());
      }
      if (!license && info.repo_license_spdx) setLicense(info.repo_license_spdx);
      if (!website && info.repo_homepage) setWebsite(info.repo_homepage);
      if (!sourceCode) setSourceCode(info.repo_html_url);
      if (!authorName && info.repo_owner_login) setAuthorName(info.repo_owner_login);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("myApps.new.github.validateFailed"));
    } finally {
      setGhValidating(false);
    }
  }

  // Source has been validated (either an APK is parsed or a repo has
  // a confirmed downloadable release). Drives the submit button.
  const sourceReady = mode === "apk" ? !!(file && inspect) : !!ghInspect;

  function switchMode(next: SourceMode) {
    if (next === mode) return;
    setMode(next);
    setError(null);
    // Clearing the inspect state forces the user to re-validate after
    // switching, so the submit button can never be hot for the wrong
    // source. Keeps both pre-fill paths honest.
    if (next === "apk") {
      setGhInspect(null);
    } else {
      setFile(null);
      setInspect(null);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "apk") {
      if (!file || !inspect) {
        setError(t("myApps.new.dropApkFirst"));
        return;
      }
      setSubmitting(true);
      try {
        // When the inspect step successfully staged the APK, take the
        // fast path: a tiny JSON post that redeems the staging token
        // instead of re-uploading the file. Falls back to the legacy
        // multipart create when staging failed server-side (rare).
        const created = inspect.staging_token
          ? await api.apps.createWithStagedApk({
              staging_token: inspect.staging_token,
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
            })
          : await api.apps.createWithApk({
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
      return;
    }
    // GitHub mode
    if (!ghInspect) {
      setError(t("myApps.new.github.validateFirst"));
      return;
    }
    setSubmitting(true);
    try {
      const created = await api.apps.createWithGithub({
        name,
        summary: summary || undefined,
        description: description || undefined,
        license: license || undefined,
        website: website || undefined,
        source_code: sourceCode || undefined,
        issue_tracker: issueTracker || undefined,
        author_name: authorName || undefined,
        visibility,
        repo: ghInspect.repo,
        provider: ghProvider,
        base_url: ghBaseUrl.trim() || null,
        asset_pattern: ghPattern.trim() || null,
        include_prereleases: ghPrereleases,
        access_token: ghToken.trim() || null,
      });
      router.replace(`/my-apps/${created.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("myApps.new.createFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  // Readiness checks — drive the hero progress dots and the bottom-bar
  // status text. ``hasIdentity`` is the minimal "you can save this" set.
  const hasSource = sourceReady;
  const hasIdentity = name.trim().length > 0 && packageName.trim().length > 0;
  const stepsDone = (hasSource ? 1 : 0) + (hasIdentity ? 1 : 0);

  return (
    <div className="relative pb-12">
      {/* Engineer's dotted grid — the visual signature of this page.
          1 px dots every 14 px at 3 % opacity, fixed so the texture
          doesn't drift while the user scrolls. Distinct from the
          /my-apps/[id] horizontal hairlines so the create/edit pair
          reads as siblings rather than copies. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 opacity-[0.06]"
        style={{
          backgroundImage:
            "radial-gradient(rgb(var(--ink)) 1px, transparent 1px)",
          backgroundSize: "14px 14px",
        }}
      />

      <Hero stepsDone={stepsDone} hasSource={hasSource} hasIdentity={hasIdentity} />

      {error && (
        <p className="mb-4 mt-6 rounded-2xl border border-danger/40 bg-danger-container/40 px-4 py-3 text-sm text-danger-on-container">
          {error}
        </p>
      )}

      <form onSubmit={onSubmit} className="mt-8 space-y-6">
        {/* Step 1 — source */}
        <DraftPanel step="01" total={3} title={t("myApps.new.step1")}>

          {/* Mode switcher — pill row that swaps the body below.
              We never show both forms at once: the user picks one
              source per app, additional APKs can be uploaded after
              creation from the manage page. */}
          <div className="mt-4 inline-flex rounded-pill border border-outline-soft bg-surface-2 p-0.5">
            <ModeTab
              active={mode === "apk"}
              onClick={() => switchMode("apk")}
              icon={<Upload className="h-3.5 w-3.5" />}
              label={t("myApps.new.modeApk")}
            />
            <ModeTab
              active={mode === "github"}
              onClick={() => switchMode("github")}
              icon={<GitBranch className="h-3.5 w-3.5" />}
              label={t("myApps.new.modeGithub")}
            />
          </div>

          {mode === "apk" ? (
            <div className="mt-5">
              <label className="block">
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
                <ApkInspectCard inspect={inspect} />
              )}
            </div>
          ) : (
            <div className="mt-5 space-y-4">
              <p className="text-xs leading-relaxed text-ink-soft">
                <Trans
                  i18nKey="myApps.new.github.intro"
                  components={{ code: <span className="font-mono" /> }}
                />
              </p>

              {/* Forge picker — segmented pills. Selecting a non-GitHub
                  provider reveals the base URL field below. */}
              <div className="space-y-1.5">
                <Label className="text-sm font-medium text-ink-soft">
                  {t("myApps.new.github.providerLabel")}
                </Label>
                <div className="inline-flex rounded-pill border border-outline-soft bg-surface-2 p-0.5">
                  {(["github", "gitlab", "gitea"] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => { setGhProvider(p); setGhInspect(null); }}
                      aria-pressed={ghProvider === p}
                      className={cn(
                        "rounded-pill px-3 py-1 text-xs font-medium transition-colors",
                        ghProvider === p
                          ? "bg-primary text-primary-fg shadow-e1"
                          : "text-ink-soft hover:text-ink",
                      )}
                    >
                      {t(`myApps.new.github.providers.${p}`)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="gh-repo" className="text-sm font-medium text-ink-soft">
                  {t("myApps.new.github.repoLabel")}
                </Label>
                <div className="flex items-center gap-2">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-ink-soft">
                    <GitBranch className="h-4 w-4" />
                  </span>
                  <Input
                    id="gh-repo"
                    value={ghRepo}
                    onChange={(e) => { setGhRepo(e.target.value); setGhInspect(null); }}
                    placeholder={t(`myApps.new.github.repoPlaceholder_${ghProvider}`)}
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="filled"
                    onClick={onValidateGithub}
                    disabled={ghValidating || !ghRepo.trim()}
                  >
                    {ghValidating ? (
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-surface-2 border-t-primary-fg" />
                    ) : null}
                    {ghValidating ? t("myApps.new.github.validating") : t("myApps.new.github.validate")}
                  </Button>
                </div>
              </div>

              {/* Self-hosted base URL — only relevant for GitLab + Gitea
                  variants. Stays hidden for stock GitHub.com. */}
              {ghProvider !== "github" && (
                <div className="space-y-1.5">
                  <Label htmlFor="gh-base-url" className="text-sm font-medium text-ink-soft">
                    {t("myApps.new.github.baseUrlLabel")}
                  </Label>
                  <Input
                    id="gh-base-url"
                    value={ghBaseUrl}
                    onChange={(e) => { setGhBaseUrl(e.target.value); setGhInspect(null); }}
                    placeholder={
                      ghProvider === "gitlab"
                        ? "https://gitlab.com"
                        : "https://codeberg.org"
                    }
                    className="font-mono"
                  />
                  <p className="text-[11px] leading-relaxed text-ink-mute">
                    {t("myApps.new.github.baseUrlHint")}
                  </p>
                </div>
              )}

              {/* Optional PAT — needed to inspect + import from a
                  private repo. Stored encrypted on the source row so
                  subsequent cron scans use the same credential. */}
              <div className="space-y-1.5">
                <Label htmlFor="gh-token" className="text-sm font-medium text-ink-soft">
                  {t("myApps.new.github.tokenLabel")}
                </Label>
                <Input
                  id="gh-token"
                  type="password"
                  autoComplete="off"
                  value={ghToken}
                  onChange={(e) => { setGhToken(e.target.value); setGhInspect(null); }}
                  placeholder={t(`myApps.new.github.tokenPlaceholder_${ghProvider}`)}
                  className="font-mono"
                />
                <p className="text-[11px] leading-relaxed text-ink-mute">
                  {t("myApps.new.github.tokenHint")}
                </p>
              </div>

              {/* Advanced disclosure — pattern + prereleases. Collapsed by
                  default so the common case is a single field + Validate. */}
              <button
                type="button"
                onClick={() => setGhAdvancedOpen((o) => !o)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-mute hover:text-ink"
              >
                {ghAdvancedOpen
                  ? <ChevronDown className="h-3.5 w-3.5" />
                  : <ChevronRight className="h-3.5 w-3.5" />}
                {t("myApps.new.github.advanced")}
              </button>

              {ghAdvancedOpen && (
                <div className="grid gap-3 rounded-2xl border border-outline-soft bg-surface-2/40 p-4 md:grid-cols-[1.4fr_auto] md:items-end">
                  <div className="space-y-1.5">
                    <Label htmlFor="gh-pattern" className="text-xs font-medium uppercase tracking-wider text-ink-mute">
                      {t("myApps.new.github.patternLabel")}
                    </Label>
                    <Input
                      id="gh-pattern"
                      value={ghPattern}
                      onChange={(e) => { setGhPattern(e.target.value); setGhInspect(null); }}
                      placeholder="*.apk"
                      className="font-mono"
                    />
                    <p className="text-[11px] text-ink-mute">
                      {t("myApps.new.github.patternHint")}
                    </p>
                  </div>
                  <label className="flex cursor-pointer items-start justify-between gap-3 rounded-2xl border border-outline-soft bg-surface px-3 py-2.5 transition-colors hover:bg-surface-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-ink">{t("myApps.new.github.includePrereleases")}</div>
                      <div className="mt-0.5 text-[11px] leading-relaxed text-ink-mute">{t("myApps.new.github.includePrereleasesHint")}</div>
                    </div>
                    <Switch
                      checked={ghPrereleases}
                      onCheckedChange={(v) => { setGhPrereleases(v); setGhInspect(null); }}
                      ariaLabel={t("myApps.new.github.includePrereleases")}
                    />
                  </label>
                </div>
              )}

              {ghInspect && <GithubInspectCard inspect={ghInspect} />}
            </div>
          )}
        </DraftPanel>

        {/* Step 2 — listing */}
        <DraftPanel
          step="02"
          total={3}
          title={t("myApps.new.step2")}
          actions={
            <button
              type="button"
              onClick={() => setMetadataOpen((o) => !o)}
              className="inline-flex items-center gap-1.5 rounded-pill border border-outline-soft bg-surface px-3 py-1.5 text-xs font-medium text-ink-soft hover:border-primary hover:text-primary"
            >
              <FileCode2 className="h-3.5 w-3.5" />
              {t("myApps.new.metadataImportLabel")}
            </button>
          }
        >
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
              <Input
                id="pkg"
                required
                value={packageName}
                onChange={(e) => setPackageName(e.target.value)}
                disabled={mode === "github"}
                className="font-mono text-xs"
                title={mode === "github" ? t("myApps.new.github.packageReadOnly") : undefined}
              />
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
        </DraftPanel>

        {/* Step 3 — about */}
        <DraftPanel step="03" total={3} title={t("myApps.new.step3")} subtitle={t("myApps.new.step3Subtitle")}>
          <div className="grid gap-4 md:grid-cols-2">
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
        </DraftPanel>

        <ReadyTray
          hasSource={hasSource}
          hasIdentity={hasIdentity}
          mode={mode}
          submitting={submitting}
        >
          <div className="flex gap-2">
            <Button asChild variant="text" type="button">
              <Link href="/my-apps">{t("myApps.new.cancel")}</Link>
            </Button>
            <Button type="submit" variant="filled" size="lg" disabled={!sourceReady || submitting}>
              {submitting ? t("myApps.new.publishing") : t("myApps.new.publish")}
            </Button>
          </div>
        </ReadyTray>
      </form>
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Drafting-table chrome: Hero, DraftPanel, ReadyTray                         */
/* -------------------------------------------------------------------------- */

function Hero({
  stepsDone,
  hasSource,
  hasIdentity,
}: {
  stepsDone: number;
  hasSource: boolean;
  hasIdentity: boolean;
}) {
  const { t } = useTranslation();
  return (
    <header className="relative overflow-hidden rounded-3xl border border-outline-soft bg-surface px-6 py-7 md:px-10 md:py-9 animate-fade-up">
      {/* Soft primary tint wash from the top-right — the only chromatic
          accent in an otherwise restrained header so the title carries
          the page. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 80% at 100% 0%, rgb(var(--primary) / 0.10), transparent 65%)",
        }}
      />
      {/* "DRAFT" watermark — rotated, very faint, in the bottom-right
          corner. Reads as a wet-ink stamp on a fresh sheet. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-2 -bottom-3 hidden select-none rotate-[-8deg] font-mono text-7xl font-black uppercase tracking-tighter text-outline opacity-30 md:block"
      >
        Draft
      </div>

      <div className="relative">
        <Link
          href="/my-apps"
          className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-ink-mute hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> {t("myApps.new.backLink")}
        </Link>

        <div className="mt-4 flex flex-wrap items-end justify-between gap-6">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-mute">
              {t("myApps.new.eyebrow")}
              <span className="mx-2 text-outline">·</span>
              <span className="tabular-nums">{stepsDone} / 3</span>
            </div>
            <h1 className="mt-2 text-4xl font-bold tracking-tight text-ink md:text-5xl">
              {t("myApps.new.title")}
            </h1>
            <p className="mt-2 max-w-prose text-ink-soft">{t("myApps.new.subtitle")}</p>
          </div>

          {/* Live readiness — two large dots reflect the only mandatory
              steps; the third stays neutral because Step 03 is optional
              by design. The page's bottom tray repeats this signal in
              text form. */}
          <ul className="flex items-center gap-3 text-[10px] uppercase tracking-wider text-ink-mute">
            <ReadinessDot filled={hasSource} label={t("myApps.new.readiness.source")} />
            <span className="h-px w-4 bg-outline" aria-hidden />
            <ReadinessDot filled={hasIdentity} label={t("myApps.new.readiness.identity")} />
            <span className="h-px w-4 bg-outline" aria-hidden />
            <ReadinessDot filled={hasSource && hasIdentity} label={t("myApps.new.readiness.ready")} highlight />
          </ul>
        </div>
      </div>
    </header>
  );
}


function ReadinessDot({
  filled,
  label,
  highlight,
}: {
  filled: boolean;
  label: string;
  highlight?: boolean;
}) {
  return (
    <li className="flex flex-col items-center gap-1.5">
      <span
        aria-hidden
        className={cn(
          "relative flex h-3 w-3 items-center justify-center",
        )}
      >
        {filled && highlight && (
          <span className="absolute inset-[-3px] animate-ping rounded-full bg-primary/40" />
        )}
        <span
          className={cn(
            "relative h-2.5 w-2.5 rounded-full transition-colors",
            filled
              ? highlight
                ? "bg-primary"
                : "bg-primary/70"
              : "border border-outline bg-transparent",
          )}
        />
      </span>
      <span className={cn("font-mono", filled ? "text-ink-soft" : "text-ink-mute")}>{label}</span>
    </li>
  );
}


/** Numbered panel that frames each step like a blueprint specification.
 *  Renders a vertical accent rail on the left, a SECTION 0X / 03
 *  eyebrow + oversized gutter numeral, a title (+ optional subtitle and
 *  right-aligned ``actions``), and a hairline-bordered body below. */
function DraftPanel({
  step,
  total,
  title,
  subtitle,
  actions,
  children,
}: {
  step: string;
  total: number;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="relative overflow-hidden rounded-3xl border border-outline-soft bg-surface p-6 md:p-8">
      {/* Vertical accent rail on the left edge — dashed primary stroke
          so the panel reads as a blueprint specification rather than a
          card. Distinct from /my-apps/[id]'s solid section number. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-0 top-6 bottom-6 w-px"
        style={{
          backgroundImage:
            "repeating-linear-gradient(to bottom, rgb(var(--primary) / 0.6) 0 6px, transparent 6px 12px)",
        }}
      />
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3 border-b border-outline-soft pb-5">
        <div className="flex items-baseline gap-4">
          <span className="hidden font-bold tabular-nums leading-none text-outline md:block md:text-5xl">
            {step}
          </span>
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-mute">
              Section {step} / {String(total).padStart(2, "0")}
            </div>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-ink">{title}</h2>
            {subtitle && (
              <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-soft">{subtitle}</p>
            )}
          </div>
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}


/** Sticky "ready to print" tray at the bottom of the form. Surfaces a
 *  live status line that mirrors the hero's readiness dots, plus the
 *  cancel/submit buttons (passed in as children to keep the existing
 *  submit binding intact). */
function ReadyTray({
  hasSource,
  hasIdentity,
  mode,
  submitting,
  children,
}: {
  hasSource: boolean;
  hasIdentity: boolean;
  mode: SourceMode;
  submitting: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  let status: string;
  if (submitting) status = t("myApps.new.publishing");
  else if (!hasSource)
    status = mode === "github" ? t("myApps.new.github.validateFirst") : t("myApps.new.pickFirst");
  else if (!hasIdentity) status = t("myApps.new.needIdentity");
  else status = t("myApps.new.ready");

  const allReady = hasSource && hasIdentity;
  return (
    <div className="sticky bottom-4 z-10 rounded-2xl border border-outline-soft bg-surface/95 p-3 shadow-e3 backdrop-blur animate-fade-up">
      {/* Dashed top edge — echoes the panel rail, signals "this is the
          end of the draft". */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-3 top-0 h-px"
        style={{
          backgroundImage:
            "repeating-linear-gradient(to right, rgb(var(--outline)) 0 6px, transparent 6px 12px)",
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className={cn(
              "relative flex h-2 w-2",
            )}
          >
            {allReady && (
              <span className="absolute inset-[-3px] animate-ping rounded-full bg-primary/40" />
            )}
            <span
              className={cn(
                "relative h-2 w-2 rounded-full",
                allReady ? "bg-primary" : "bg-ink-mute/50",
              )}
            />
          </span>
          <span className={cn("text-sm", allReady ? "text-ink" : "text-ink-soft")}>{status}</span>
        </div>
        {children}
      </div>
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


function ModeTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-primary text-primary-fg shadow-e1"
          : "text-ink-soft hover:text-ink",
      )}
    >
      {icon}
      {label}
    </button>
  );
}


/** Shared "parsed APK metadata" card used by both source modes — the
 *  GitHub variant wraps this and adds the release context above it. */
function ApkInspectCard({ inspect }: { inspect: ApkInspect }) {
  const { t } = useTranslation();
  return (
    <div className="mt-5">
      <dl className="grid gap-3 rounded-xl bg-surface-2 p-4 md:grid-cols-3">
        <Spec label={t("myApps.new.specPackage")} value={inspect.package_name} mono />
        <Spec label={t("myApps.new.specVersion")} value={`${inspect.version_name} (${inspect.version_code})`} mono />
        <Spec label={t("myApps.new.specSize")} value={formatBytes(inspect.size_bytes)} mono />
        <Spec label={t("myApps.new.specSdk")} value={`${inspect.min_sdk}–${inspect.target_sdk}`} mono />
        <Spec label={t("myApps.new.specAbis")} value={inspect.native_code.join(", ") || "—"} mono />
        <Spec label={t("myApps.new.specPermissions")} value={String(inspect.permissions.length)} mono />
      </dl>
      {Object.keys(inspect.detected_anti_features).length > 0 && (
        <div className="mt-4 rounded-xl border border-accent/40 bg-accent-container/30 p-4">
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
    </div>
  );
}


function GithubInspectCard({ inspect }: { inspect: GithubApkInspect }) {
  const { t } = useTranslation();
  return (
    <div className="mt-5 space-y-4">
      {/* Release context — tag, asset name, prerelease flag. Sits above
          the parsed-APK card so the user sees what we resolved before
          inspecting the manifest details. */}
      <div className="rounded-2xl border border-primary/30 bg-primary-container/30 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary-on-container">
              <GitBranch className="h-3.5 w-3.5" />
              {t("myApps.new.github.resolved")}
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-2">
              <a
                href={`https://github.com/${inspect.repo}/releases/tag/${inspect.release_tag}`}
                target="_blank"
                rel="noreferrer noopener"
                className="font-mono text-sm text-ink hover:text-primary"
              >
                {inspect.repo}
              </a>
              <span className="text-ink-mute">·</span>
              <span className="font-mono text-sm text-primary">{inspect.release_tag}</span>
              {inspect.release_is_prerelease && (
                <Badge variant="accent" className="text-[10px] uppercase tracking-wider">pre-release</Badge>
              )}
            </div>
            <div className="mt-1 font-mono text-[11px] text-ink-mute">
              {inspect.asset_name} · {formatBytes(inspect.size_bytes)} · {formatDate(inspect.release_published_at)}
            </div>
          </div>
        </div>
      </div>

      <ApkInspectCard inspect={inspect} />
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
