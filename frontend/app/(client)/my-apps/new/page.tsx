"use client";

import { ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, FileCode2, GitBranch, KeyRound, Loader2, Plug, ShieldAlert, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { AuthGuard } from "@/components/auth-guard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  API_URL,
  api,
  type ApkInspect,
  type ApkProxyPublicRead,
  type GithubApkInspect,
  type GithubProvider,
  type ProxyApkInspect,
  type ProxyProviderDescriptor,
} from "@/lib/api";
import { cn, formatBytes, formatDate } from "@/lib/utils";

type SourceMode = "apk" | "github" | "proxy";

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

  // ---------- Proxy path state ----------
  // Catalogue of healthy proxies, loaded on mount when mode flips to
  // ``proxy`` so the page boot doesn't pay the round-trip if the user
  // never picks the third tab. The wizard state mirrors the in-app
  // ProxySourcesSection — three sub-steps inside Step 01.
  const [pxProxies, setPxProxies] = useState<ApkProxyPublicRead[] | null>(null);
  const [pxLoadingProxies, setPxLoadingProxies] = useState(false);
  const [pxStep, setPxStep] = useState<"proxy" | "provider" | "form">("proxy");
  const [pxProxy, setPxProxy] = useState<ApkProxyPublicRead | null>(null);
  const [pxProvider, setPxProvider] = useState<ProxyProviderDescriptor | null>(null);
  const [pxSourceUrl, setPxSourceUrl] = useState("");
  const [pxSecrets, setPxSecrets] = useState<Record<string, string>>({});
  const [pxCredentialId, setPxCredentialId] = useState<string | null>(null);
  const [pxOauthBusy, setPxOauthBusy] = useState(false);
  const [pxValidating, setPxValidating] = useState(false);
  const [pxInspect, setPxInspect] = useState<ProxyApkInspect | null>(null);
  // OAuth state HMAC — ref because it's only read inside the message
  // handler; same recipe as ProxySourcesSection (calling setters inside
  // an updater is a React anti-pattern).
  const pxOauthStateRef = useRef<string | null>(null);
  // Mirror of pxCredentialId for the popup-close watcher.
  const pxCredentialIdRef = useRef<string | null>(null);
  useEffect(() => {
    pxCredentialIdRef.current = pxCredentialId;
  }, [pxCredentialId]);

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

  // ---------- Proxy-mode helpers ----------
  const loadProxies = useCallback(async () => {
    if (pxProxies !== null) return;
    setPxLoadingProxies(true);
    try {
      const list = await api.proxies.listAvailable();
      setPxProxies(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("myApps.new.proxy.loadFailed"));
      setPxProxies([]);
    } finally {
      setPxLoadingProxies(false);
    }
  }, [pxProxies, t]);

  // postMessage listener for the OAuth popup — mounted whenever we're
  // in proxy mode + on the form step + the picked provider is oauth2.
  useEffect(() => {
    if (mode !== "proxy" || pxStep !== "form" || pxProvider?.auth_kind !== "oauth2") {
      return;
    }
    function onMessage(event: MessageEvent) {
      const apiOrigin = API_URL
        ? new URL(API_URL).origin
        : window.location.origin;
      if (event.origin !== window.location.origin && event.origin !== apiOrigin) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        (parsed as { type?: unknown }).type !== "proxy_oauth_done"
      ) {
        return;
      }
      const msg = parsed as { type: string; credential_id?: string; state?: string };
      if (!pxOauthStateRef.current || msg.state !== pxOauthStateRef.current) {
        return;
      }
      setPxCredentialId(msg.credential_id ?? null);
      setPxOauthBusy(false);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [mode, pxStep, pxProvider?.auth_kind]);

  async function pxBeginOAuth() {
    if (!pxProxy || !pxProvider) return;
    // On /my-apps/new the app doesn't exist yet, so we use the
    // ``POST /api/v1/proxies/{id}/oauth-begin`` sibling of the per-app
    // endpoint (which requires an app id). Both mint an HMAC-signed
    // state server-side and return the fully-formed popup URL — the
    // proxy's ``base_url`` therefore never leaks past the admin page.
    setPxOauthBusy(true);
    setPxCredentialId(null);
    try {
      const resp = await api.proxies.beginOAuthNewApp(pxProxy.id, pxProvider.id);
      pxOauthStateRef.current = resp.state;
      const popup = window.open(
        resp.popup_url,
        "proxy-oauth",
        "width=600,height=720,scrollbars=yes,resizable=yes,noopener=no",
      );
      if (!popup) {
        setPxOauthBusy(false);
        setError(t("myApps.edit.proxySources.popupBlocked"));
        return;
      }
      const closeWatcher = window.setInterval(() => {
        if (!popup.closed) return;
        window.clearInterval(closeWatcher);
        if (!pxCredentialIdRef.current) {
          setPxOauthBusy(false);
          setError(t("myApps.edit.proxySources.popupClosed"));
        }
      }, 700);
    } catch (e) {
      setPxOauthBusy(false);
      setError(e instanceof Error ? e.message : t("myApps.edit.proxySources.oauthBeginFailed"));
    }
  }

  async function onValidateProxy() {
    if (!pxProxy || !pxProvider) return;
    if (!pxSourceUrl.trim()) return;
    setError(null);
    setPxInspect(null);
    setPxValidating(true);
    try {
      // Build secrets payload matching the provider's auth_kind.
      let secretsPayload: Record<string, string> = {};
      if (pxProvider.auth_kind === "oauth2") {
        if (!pxCredentialId) {
          setError(t("myApps.new.proxy.oauthFirst"));
          return;
        }
        secretsPayload = { credential_id: pxCredentialId };
      } else if (pxProvider.auth_kind !== "none") {
        for (const f of pxProvider.secret_fields) {
          const v = (pxSecrets[f.key] ?? "").trim();
          if (v) secretsPayload[f.key] = v;
        }
      }
      const info = await api.apps.inspectProxySource({
        proxy_id: pxProxy.id,
        provider: pxProvider.id,
        source_url: pxSourceUrl.trim(),
        secrets: secretsPayload,
      });
      setPxInspect(info);
      // Pre-fill the Listing form with what the parsed APK gave us.
      // Same don't-clobber rule as the GitHub path.
      if (!packageName) setPackageName(info.package_name);
      if (!name && info.app_name) setName(info.app_name);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("myApps.new.proxy.validateFailed"));
    } finally {
      setPxValidating(false);
    }
  }

  // Source has been validated. Drives the submit button.
  const sourceReady =
    mode === "apk"
      ? !!(file && inspect)
      : mode === "github"
        ? !!ghInspect
        : !!pxInspect;

  function switchMode(next: SourceMode) {
    if (next === mode) return;
    setMode(next);
    setError(null);
    // Clearing the inspect state forces the user to re-validate after
    // switching, so the submit button can never be hot for the wrong
    // source. Keeps the three pre-fill paths honest.
    if (next === "apk") {
      setGhInspect(null);
      setPxInspect(null);
    } else if (next === "github") {
      setFile(null);
      setInspect(null);
      setPxInspect(null);
    } else {
      setFile(null);
      setInspect(null);
      setGhInspect(null);
      // Lazy-load the proxy catalogue on first flip.
      void loadProxies();
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
    if (mode === "github") {
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
      return;
    }
    // Proxy mode
    if (!pxInspect || !pxProxy || !pxProvider) {
      setError(t("myApps.new.proxy.validateFirst"));
      return;
    }
    setSubmitting(true);
    try {
      // Re-build the same secrets payload we sent at inspect time so
      // the persistent ApkProxySource row is created with the right
      // credentials. ``oauth2`` → ``credential_id``, ``api_token`` /
      // ``basic`` → the declared secret_fields.
      let secretsPayload: Record<string, string> = {};
      if (pxProvider.auth_kind === "oauth2" && pxCredentialId) {
        secretsPayload = { credential_id: pxCredentialId };
      } else if (pxProvider.auth_kind !== "none") {
        for (const f of pxProvider.secret_fields) {
          const v = (pxSecrets[f.key] ?? "").trim();
          if (v) secretsPayload[f.key] = v;
        }
      }
      const created = await api.apps.createWithProxySource({
        name,
        summary: summary || undefined,
        description: description || undefined,
        license: license || undefined,
        website: website || undefined,
        source_code: sourceCode || undefined,
        issue_tracker: issueTracker || undefined,
        author_name: authorName || undefined,
        visibility,
        proxy_id: pxProxy.id,
        provider: pxProvider.id,
        source_url: pxSourceUrl.trim(),
        secrets: secretsPayload,
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
            <ModeTab
              active={mode === "proxy"}
              onClick={() => switchMode("proxy")}
              icon={<Plug className="h-3.5 w-3.5" />}
              label={t("myApps.new.modeProxy")}
            />
          </div>

          {mode === "apk" && (
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
          )}

          {mode === "github" && (
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

          {mode === "proxy" && (
            <ProxyModeBody
              proxies={pxProxies}
              loadingProxies={pxLoadingProxies}
              step={pxStep}
              setStep={setPxStep}
              pickedProxy={pxProxy}
              setPickedProxy={(p) => {
                setPxProxy(p);
                setPxInspect(null);
              }}
              pickedProvider={pxProvider}
              setPickedProvider={(p) => {
                setPxProvider(p);
                setPxSecrets({});
                setPxCredentialId(null);
                pxOauthStateRef.current = null;
                setPxInspect(null);
              }}
              sourceUrl={pxSourceUrl}
              setSourceUrl={(v) => {
                setPxSourceUrl(v);
                setPxInspect(null);
              }}
              secrets={pxSecrets}
              setSecrets={(s) => {
                setPxSecrets(s);
                setPxInspect(null);
              }}
              credentialId={pxCredentialId}
              oauthBusy={pxOauthBusy}
              onBeginOAuth={pxBeginOAuth}
              validating={pxValidating}
              onValidate={onValidateProxy}
              inspect={pxInspect}
            />
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
      {/* Watermark — rotated, very faint, in the bottom-right corner.
          Reads as a wet-ink stamp on a fresh sheet. Localised so a
          French operator doesn't get a stray ``DRAFT`` next to all the
          other French chrome on the page. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-2 -bottom-3 hidden select-none rotate-[-8deg] font-mono text-7xl font-black uppercase tracking-tighter text-outline opacity-30 md:block"
      >
        {t("myApps.new.draftWatermark")}
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
  else if (!hasSource) {
    if (mode === "github") status = t("myApps.new.github.validateFirst");
    else if (mode === "proxy") status = t("myApps.new.proxy.validateFirst");
    else status = t("myApps.new.pickFirst");
  }
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

/* ============================================================================
 * Proxy mode — inline 3-step wizard (proxy → provider → form) embedded in
 * Step 01 of the New App page. Mirrors ProxySourcesSection's wizard but
 * inline rather than in a Sheet (the page already provides DraftPanel
 * chrome) and finished off with a Validate button that calls
 * /apks/inspect-proxy-source.
 * ============================================================================ */


function ProxyModeBody({
  proxies,
  loadingProxies,
  step,
  setStep,
  pickedProxy,
  setPickedProxy,
  pickedProvider,
  setPickedProvider,
  sourceUrl,
  setSourceUrl,
  secrets,
  setSecrets,
  credentialId,
  oauthBusy,
  onBeginOAuth,
  validating,
  onValidate,
  inspect,
}: {
  proxies: ApkProxyPublicRead[] | null;
  loadingProxies: boolean;
  step: "proxy" | "provider" | "form";
  setStep: (s: "proxy" | "provider" | "form") => void;
  pickedProxy: ApkProxyPublicRead | null;
  setPickedProxy: (p: ApkProxyPublicRead | null) => void;
  pickedProvider: ProxyProviderDescriptor | null;
  setPickedProvider: (p: ProxyProviderDescriptor | null) => void;
  sourceUrl: string;
  setSourceUrl: (v: string) => void;
  secrets: Record<string, string>;
  setSecrets: (s: Record<string, string>) => void;
  credentialId: string | null;
  oauthBusy: boolean;
  onBeginOAuth: () => void;
  validating: boolean;
  onValidate: () => void;
  inspect: ProxyApkInspect | null;
}) {
  const { t } = useTranslation();

  return (
    <div className="mt-5 space-y-4">
      <p className="text-xs leading-relaxed text-ink-soft">
        {t("myApps.new.proxy.intro")}
      </p>

      <ProxyStepBar step={step} />

      {step === "proxy" && (
        <ProxyPickerInline
          proxies={proxies}
          loading={loadingProxies}
          onPick={(p) => {
            setPickedProxy(p);
            setStep("provider");
          }}
        />
      )}

      {step === "provider" && pickedProxy && (
        <>
          <ProviderPickerInline
            proxy={pickedProxy}
            onPick={(p) => {
              setPickedProvider(p);
              setStep("form");
            }}
          />
          <button
            type="button"
            onClick={() => {
              setPickedProxy(null);
              setStep("proxy");
            }}
            className="text-xs font-medium text-ink-mute hover:text-ink"
          >
            ← {t("myApps.new.proxy.backToProxy")}
          </button>
        </>
      )}

      {step === "form" && pickedProxy && pickedProvider && (
        <ProxyFormInline
          proxy={pickedProxy}
          provider={pickedProvider}
          sourceUrl={sourceUrl}
          setSourceUrl={setSourceUrl}
          secrets={secrets}
          setSecrets={setSecrets}
          credentialId={credentialId}
          oauthBusy={oauthBusy}
          onBeginOAuth={onBeginOAuth}
          onBack={() => {
            setPickedProvider(null);
            setStep("provider");
          }}
          validating={validating}
          onValidate={onValidate}
          canValidate={
            sourceUrl.trim().length > 0 &&
            (pickedProvider.auth_kind !== "oauth2" || !!credentialId) &&
            !pickedProvider.secret_fields.some(
              (f) => f.required && !(secrets[f.key] ?? "").trim(),
            )
          }
        />
      )}

      {inspect && <ProxyInspectCard inspect={inspect} />}
    </div>
  );
}


function ProxyStepBar({ step }: { step: "proxy" | "provider" | "form" }) {
  const { t } = useTranslation();
  const steps: { id: "proxy" | "provider" | "form"; label: string }[] = [
    { id: "proxy", label: t("myApps.edit.proxySources.wizard.stepProxy") },
    { id: "provider", label: t("myApps.edit.proxySources.wizard.stepProvider") },
    { id: "form", label: t("myApps.edit.proxySources.wizard.stepForm") },
  ];
  const activeIdx = steps.findIndex((s) => s.id === step);
  return (
    <ol className="flex flex-wrap items-center gap-2">
      {steps.map((s, i) => {
        const done = i < activeIdx;
        const active = i === activeIdx;
        return (
          <li key={s.id} className="flex items-center gap-2">
            <span
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-pill font-mono text-[10px] font-semibold",
                active && "bg-primary text-primary-fg",
                done && "bg-primary-container text-primary-on-container",
                !active && !done && "bg-surface-2 text-ink-mute",
              )}
            >
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className={cn("text-xs font-medium", active ? "text-ink" : "text-ink-mute")}>
              {s.label}
            </span>
            {i < steps.length - 1 && (
              <span aria-hidden className="ml-1 h-px w-6 bg-outline-soft" />
            )}
          </li>
        );
      })}
    </ol>
  );
}


function ProxyPickerInline({
  proxies,
  loading,
  onPick,
}: {
  proxies: ApkProxyPublicRead[] | null;
  loading: boolean;
  onPick: (p: ApkProxyPublicRead) => void;
}) {
  const { t } = useTranslation();
  if (loading || proxies === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-mute">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }
  if (proxies.length === 0) {
    return (
      <div className="rounded-2xl border border-outline-soft bg-surface-2 px-4 py-3 text-sm text-ink-mute">
        {t("myApps.new.proxy.noProxies")}
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {proxies.map((p) => {
        const providerCount = p.cached_sources_json?.providers.length ?? 0;
        return (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onPick(p)}
              className="group flex w-full items-start gap-3 rounded-2xl border border-outline-soft bg-surface px-4 py-3 text-left transition-colors hover:border-primary/50 hover:bg-primary-container/15"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-ink-soft group-hover:bg-primary/15 group-hover:text-primary">
                <Plug className="h-4 w-4" strokeWidth={2.2} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-semibold text-ink">{p.name}</span>
                  <Badge variant="outline">
                    {t("myApps.edit.proxySources.wizard.providersCount", { count: providerCount })}
                  </Badge>
                </div>
                {/* base_url stays admin-only — see /admin/proxies. */}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}


function ProviderPickerInline({
  proxy,
  onPick,
}: {
  proxy: ApkProxyPublicRead;
  onPick: (p: ProxyProviderDescriptor) => void;
}) {
  const { t } = useTranslation();
  const providers = proxy.cached_sources_json?.providers ?? [];
  if (providers.length === 0) {
    return (
      <div className="rounded-2xl border border-outline-soft bg-surface-2 px-4 py-3 text-sm text-ink-mute">
        {t("myApps.edit.proxySources.wizard.providerEmpty")}
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {providers.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            onClick={() => onPick(p)}
            className="group flex w-full items-start gap-3 rounded-2xl border border-outline-soft bg-surface px-4 py-3 text-left transition-colors hover:border-primary/50 hover:bg-primary-container/15"
          >
            {p.icon_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={p.icon_url}
                alt=""
                className="mt-0.5 h-9 w-9 shrink-0 rounded-pill border border-outline-soft bg-surface object-cover"
                loading="lazy"
              />
            ) : (
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-ink-soft">
                <Plug className="h-4 w-4" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-semibold text-ink">{p.name}</span>
                <Badge variant={p.auth_kind === "oauth2" ? "primary" : "outline"}>
                  {t(`myApps.edit.proxySources.authKind.${p.auth_kind}`)}
                </Badge>
              </div>
              {p.description && (
                <p className="mt-0.5 text-xs leading-relaxed text-ink-mute">{p.description}</p>
              )}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}


function ProxyFormInline({
  proxy,
  provider,
  sourceUrl,
  setSourceUrl,
  secrets,
  setSecrets,
  credentialId,
  oauthBusy,
  onBeginOAuth,
  onBack,
  validating,
  onValidate,
  canValidate,
}: {
  proxy: ApkProxyPublicRead;
  provider: ProxyProviderDescriptor;
  sourceUrl: string;
  setSourceUrl: (v: string) => void;
  secrets: Record<string, string>;
  setSecrets: (s: Record<string, string>) => void;
  credentialId: string | null;
  oauthBusy: boolean;
  onBeginOAuth: () => void;
  onBack: () => void;
  validating: boolean;
  onValidate: () => void;
  canValidate: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-outline-soft bg-surface-2/40 p-4">
        <p className="text-sm leading-relaxed text-ink-soft">
          {provider.description ?? t("myApps.edit.proxySources.wizard.formIntro", { name: provider.name })}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="px-url" className="text-sm font-medium text-ink-soft">
          {t("myApps.edit.proxySources.wizard.urlLabel")}
        </Label>
        <Input
          id="px-url"
          type="url"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder={provider.url_hint ?? "https://"}
          className="font-mono"
        />
        {provider.url_pattern && (
          <p className="text-[11px] leading-relaxed text-ink-mute">
            {t("myApps.edit.proxySources.wizard.urlPatternHint", { pattern: provider.url_pattern })}
          </p>
        )}
      </div>

      {provider.auth_kind === "none" && (
        <div className="rounded-2xl border border-outline-soft bg-surface-2 px-3 py-2.5 text-xs text-ink-mute">
          {t("myApps.edit.proxySources.wizard.authNone")}
        </div>
      )}

      {(provider.auth_kind === "api_token" || provider.auth_kind === "basic") && (
        <div className="space-y-3">
          {provider.secret_fields.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label
                htmlFor={`px-secret-${f.key}`}
                className="text-xs font-medium uppercase tracking-wider text-ink-mute"
              >
                {f.label}
                {f.required && <span className="ml-1 text-danger">*</span>}
              </Label>
              <Input
                id={`px-secret-${f.key}`}
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                value={secrets[f.key] ?? ""}
                onChange={(e) => setSecrets({ ...secrets, [f.key]: e.target.value })}
                placeholder={f.placeholder ?? undefined}
                className="font-mono"
              />
            </div>
          ))}
          <p className="text-[11px] leading-relaxed text-ink-mute">
            {t("myApps.edit.proxySources.wizard.secretsHint", { proxy: proxy.name })}
          </p>
        </div>
      )}

      {provider.auth_kind === "oauth2" && (
        <div className="space-y-2">
          {credentialId ? (
            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-primary/30 bg-primary-container/30 px-3 py-2.5">
              <CheckCircle2 className="h-4 w-4 text-primary" />
              <span className="text-xs font-medium text-primary-on-container">
                {t("myApps.edit.proxySources.wizard.oauthConnected")}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onBeginOAuth}
                disabled={oauthBusy}
                className="ml-auto"
              >
                {t("myApps.edit.proxySources.wizard.oauthReconnect")}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outlined"
              onClick={onBeginOAuth}
              disabled={oauthBusy}
            >
              {oauthBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <KeyRound className="h-3.5 w-3.5" />
              )}
              {oauthBusy
                ? t("myApps.edit.proxySources.wizard.oauthWaiting")
                : t("myApps.edit.proxySources.wizard.oauthConnect", { name: provider.name })}
            </Button>
          )}
          <p className="text-[11px] leading-relaxed text-ink-mute">
            {t("myApps.edit.proxySources.wizard.oauthBody", { proxy: proxy.name })}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-outline-soft pt-3">
        <button
          type="button"
          onClick={onBack}
          className="text-xs font-medium text-ink-mute hover:text-ink"
        >
          ← {t("myApps.new.proxy.backToProvider")}
        </button>
        <Button
          type="button"
          variant="filled"
          onClick={onValidate}
          disabled={validating || !canValidate}
        >
          {validating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {validating ? t("myApps.new.proxy.validating") : t("myApps.new.proxy.validate")}
        </Button>
      </div>
    </div>
  );
}


/** Preview card after a successful inspect-proxy-source — shows the
 *  resolved release context above the parsed-APK card (same recipe as
 *  GithubInspectCard). */
function ProxyInspectCard({ inspect }: { inspect: ProxyApkInspect }) {
  const { t } = useTranslation();
  // Adapt the wide ProxyApkInspect shape into the narrower ApkInspect
  // ApkInspectCard expects (the proxy variant doesn't have a staging
  // token — we just stub it as null since the card never reads that
  // field).
  const apk: ApkInspect = {
    package_name: inspect.package_name,
    app_name: inspect.app_name,
    version_code: inspect.version_code,
    version_name: inspect.version_name,
    min_sdk: inspect.min_sdk,
    target_sdk: inspect.target_sdk,
    sha256: inspect.sha256,
    size_bytes: inspect.size_bytes,
    signer_sha256: inspect.signer_sha256,
    permissions: inspect.permissions,
    native_code: inspect.native_code,
    has_icon: inspect.has_icon,
    detected_anti_features: inspect.detected_anti_features,
    staging_token: null,
  };
  return (
    <div className="mt-5 space-y-4">
      <div className="rounded-2xl border border-primary/30 bg-primary-container/30 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary-on-container">
              <Plug className="h-3.5 w-3.5" />
              {t("myApps.new.proxy.resolved")}
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-semibold text-ink">{inspect.provider_name}</span>
              <span className="text-ink-mute">·</span>
              <span className="font-mono text-sm text-primary">{inspect.release_id}</span>
            </div>
            <div className="mt-1 font-mono text-[11px] text-ink-mute">
              {inspect.proxy_name} · {formatBytes(inspect.size_bytes)}
              {inspect.release_published_at ? ` · ${formatDate(inspect.release_published_at)}` : ""}
            </div>
          </div>
        </div>
      </div>
      <ApkInspectCard inspect={apk} />
    </div>
  );
}


export default function NewAppPage() {
  return (
    <AuthGuard requireUploader>
      <NewAppInner />
    </AuthGuard>
  );
}

// silence import-only guard
void Badge;
