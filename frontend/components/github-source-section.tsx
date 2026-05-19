"use client";

import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  api,
  type GithubProvider,
  type GithubSource,
  type GithubSourceStatus,
  type ProposedAppField,
} from "@/lib/api";
import { toast } from "@/lib/toast-store";
import { cn, formatDate } from "@/lib/utils";


export function GithubSourceSection({
  appId,
  onImported,
}: {
  appId: string;
  /** Called when a fresh import has just landed so the parent can refresh
   *  its APK list. */
  onImported?: () => void;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState<GithubSource | null>(null);
  const [loading, setLoading] = useState(true);

  // Form state — controlled inputs, reset to source on every refresh so a
  // pending edit gets clobbered by the new server-side state on poll.
  const [repo, setRepo] = useState("");
  const [provider, setProvider] = useState<GithubProvider>("github");
  const [baseUrl, setBaseUrl] = useState("");
  const [assetPattern, setAssetPattern] = useState("");
  const [includePrereleases, setIncludePrereleases] = useState(false);
  const [enabled, setEnabled] = useState(true);
  // Token UX is write-only: we never receive the value from the
  // server. ``tokenInput`` is what the user typed THIS session;
  // ``hasStoredToken`` mirrors the source row's ``has_access_token``
  // so the UI can render the "Token configured · Clear" state.
  const [tokenInput, setTokenInput] = useState("");
  const [hasStoredToken, setHasStoredToken] = useState(false);
  const [tokenAction, setTokenAction] = useState<"keep" | "set" | "clear">("keep");
  const [dirty, setDirty] = useState(false);

  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [removing, setRemoving] = useState(false);

  // After a save returns proposed fields, we surface them as an inline
  // preview card with per-field checkboxes. ``applyingFields`` blocks
  // double-clicks while the PATCH is in flight.
  const [proposed, setProposed] = useState<ProposedAppField[]>([]);
  const [pickedFields, setPickedFields] = useState<Set<string>>(new Set());
  const [applyingFields, setApplyingFields] = useState(false);

  const lastSeenTag = useRef<string | null>(null);
  // Baseline timestamp captured the moment a scan is triggered. Polling
  // stops as soon as the server-side ``last_scanned_at`` advances past
  // this value, so a 3-second import doesn't keep the button spinning
  // for the full polling window.
  const scanBaseline = useRef<string | null>(null);
  const scanStartedAt = useRef<number>(0);
  const [awaitingScan, setAwaitingScan] = useState(false);

  function beginWatching(s: GithubSource | null) {
    scanBaseline.current = s?.last_scanned_at ?? null;
    scanStartedAt.current = Date.now();
    setAwaitingScan(true);
  }

  async function reload() {
    try {
      const next = await api.githubSource.get(appId);
      setSource(next);
      if (next) {
        // Hydrate the form when the user hasn't started editing.
        if (!dirty) {
          setRepo(next.repo);
          setProvider(next.provider);
          setBaseUrl(next.base_url ?? "");
          setAssetPattern(next.asset_pattern ?? "");
          setIncludePrereleases(next.include_prereleases);
          setEnabled(next.enabled);
          setHasStoredToken(next.has_access_token);
          // After a reload we go back to the "keep what's stored"
          // intent so the next save doesn't accidentally overwrite.
          setTokenAction("keep");
          setTokenInput("");
        }
        // Detect a fresh import — if the tag rolls over to a new value
        // while we're polling, ask the parent to refresh the APK list.
        if (
          next.last_status === "imported" &&
          next.last_release_tag &&
          next.last_release_tag !== lastSeenTag.current
        ) {
          if (lastSeenTag.current !== null) {
            // Skip the very first sighting (initial page load).
            onImported?.();
          }
          lastSeenTag.current = next.last_release_tag;
        }
      }
    } catch (e) {
      toast.error(
        t("myApps.edit.githubSource.loadFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  // Poll while a scan is in flight. We poll every 1.5 s for up to 90 s
  // (large APKs over the public-IP GitHub anonymous bucket can take
  // a while), and stop the moment the worker writes a fresher
  // ``last_scanned_at`` than the value we recorded at trigger time.
  useEffect(() => {
    if (!awaitingScan) return;
    const tick = setInterval(async () => {
      const next = await api.githubSource.get(appId).catch(() => undefined);
      if (next === undefined) return; // transient — keep polling
      setSource(next);
      if (next) {
        if (!dirty) {
          setRepo(next.repo);
          setProvider(next.provider);
          setBaseUrl(next.base_url ?? "");
          setAssetPattern(next.asset_pattern ?? "");
          setIncludePrereleases(next.include_prereleases);
          setEnabled(next.enabled);
          setHasStoredToken(next.has_access_token);
          // After a reload we go back to the "keep what's stored"
          // intent so the next save doesn't accidentally overwrite.
          setTokenAction("keep");
          setTokenInput("");
        }
        if (
          next.last_status === "imported" &&
          next.last_release_tag &&
          next.last_release_tag !== lastSeenTag.current
        ) {
          if (lastSeenTag.current !== null) onImported?.();
          lastSeenTag.current = next.last_release_tag;
        }
      }
      const advanced =
        next?.last_scanned_at != null &&
        next.last_scanned_at !== scanBaseline.current;
      const timedOut = Date.now() - scanStartedAt.current > 90_000;
      if (advanced || timedOut) {
        setAwaitingScan(false);
      }
    }, 1500);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingScan, appId, dirty]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!repo.trim()) return;
    setSaving(true);
    try {
      // Three-way token semantics:
      //   keep  → don't include the field at all (server leaves it)
      //   set   → string value
      //   clear → explicit null
      const body: Record<string, unknown> = {
        repo: repo.trim(),
        provider,
        base_url: baseUrl.trim() || null,
        asset_pattern: assetPattern.trim() || null,
        include_prereleases: includePrereleases,
        enabled,
      };
      if (tokenAction === "set" && tokenInput.trim()) {
        body.access_token = tokenInput.trim();
      } else if (tokenAction === "clear") {
        body.access_token = null;
      }
      const resp = await api.githubSource.upsert(appId, body as Parameters<typeof api.githubSource.upsert>[1]);
      setSource(resp.source);
      setDirty(false);
      // Surface the preview card with every proposed field pre-selected
      // so a single Apply click fills them all (which matches the user's
      // most likely intent — they just connected the repo for this).
      setProposed(resp.proposed_app_updates ?? []);
      setPickedFields(new Set((resp.proposed_app_updates ?? []).map((p) => p.field)));
      toast.success(t("myApps.edit.githubSource.saved"));
      // The PUT triggers an immediate scan server-side. We use the
      // pre-save source state as the baseline so any change in
      // ``last_scanned_at`` reflects the new scan landing.
      beginWatching(source);
    } catch (e) {
      toast.error(
        t("myApps.edit.githubSource.saveFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setSaving(false);
    }
  }

  async function applyProposed() {
    const picks = proposed.filter((p) => pickedFields.has(p.field));
    if (picks.length === 0) {
      // Nothing checked — treat as a dismiss.
      setProposed([]);
      setPickedFields(new Set());
      return;
    }
    setApplyingFields(true);
    try {
      const patch: Record<string, string> = {};
      for (const p of picks) patch[p.field] = p.proposed_value;
      await api.apps.update(appId, patch);
      toast.success(t("myApps.edit.githubSource.proposed.applied"));
      setProposed([]);
      setPickedFields(new Set());
      onImported?.(); // parent reloads the App so the new values show up
    } catch (e) {
      toast.error(
        t("myApps.edit.githubSource.proposed.applyFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setApplyingFields(false);
    }
  }

  function dismissProposed() {
    setProposed([]);
    setPickedFields(new Set());
  }

  function togglePicked(field: string) {
    setPickedFields((s) => {
      const n = new Set(s);
      if (n.has(field)) n.delete(field);
      else n.add(field);
      return n;
    });
  }

  async function onScanNow() {
    if (!source) return;
    setScanning(true);
    try {
      beginWatching(source);
      await api.githubSource.scanNow(appId);
      toast.success(t("myApps.edit.githubSource.scanQueued"));
    } catch (e) {
      setAwaitingScan(false);
      toast.error(
        t("myApps.edit.githubSource.scanFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setScanning(false);
    }
  }

  async function onRemove() {
    if (!source) return;
    if (!confirm(t("myApps.edit.githubSource.removeConfirm"))) return;
    setRemoving(true);
    try {
      await api.githubSource.remove(appId);
      setSource(null);
      setRepo("");
      setProvider("github");
      setBaseUrl("");
      setAssetPattern("");
      setIncludePrereleases(false);
      setEnabled(true);
      setDirty(false);
      toast.success(t("myApps.edit.githubSource.removed"));
    } catch (e) {
      toast.error(
        t("myApps.edit.githubSource.removeFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setRemoving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-mute">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Status banner — only present when a source exists */}
      {source && <StatusBanner source={source} scanning={awaitingScan} />}

      {proposed.length > 0 && (
        <ProposedFieldsCard
          proposed={proposed}
          picked={pickedFields}
          onToggle={togglePicked}
          onApply={applyProposed}
          onDismiss={dismissProposed}
          busy={applyingFields}
        />
      )}

      <form onSubmit={onSave} className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          {/* Provider picker — segmented pills. Selecting a non-GitHub
              provider reveals the base URL field below. */}
          <div className="space-y-1.5 md:col-span-2">
            <Label className="text-xs font-medium uppercase tracking-wider text-ink-mute">
              {t("myApps.edit.githubSource.providerLabel")}
            </Label>
            <div className="inline-flex rounded-pill border border-outline-soft bg-surface-2 p-0.5">
              {(["github", "gitlab", "gitea"] as const).map((p) => (
                <ProviderPill
                  key={p}
                  active={provider === p}
                  onClick={() => { setProvider(p); setDirty(true); }}
                  label={t(`myApps.edit.githubSource.providers.${p}`)}
                />
              ))}
            </div>
          </div>

          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="gh-repo" className="text-xs font-medium uppercase tracking-wider text-ink-mute">
              {t("myApps.edit.githubSource.repoLabel")}
            </Label>
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-ink-soft">
                <GitBranch className="h-4 w-4" />
              </span>
              <Input
                id="gh-repo"
                value={repo}
                onChange={(e) => { setRepo(e.target.value); setDirty(true); }}
                placeholder={t(`myApps.edit.githubSource.repoPlaceholder_${provider}`)}
                className="font-mono"
              />
            </div>
            <p className="text-[11px] leading-relaxed text-ink-mute">
              {t("myApps.edit.githubSource.repoHint")}
            </p>
          </div>

          {/* Self-hosted base URL — only relevant for GitLab + Gitea
              variants; for stock GitHub.com it stays empty. */}
          {provider !== "github" && (
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="gh-base-url" className="text-xs font-medium uppercase tracking-wider text-ink-mute">
                {t("myApps.edit.githubSource.baseUrlLabel")}
              </Label>
              <Input
                id="gh-base-url"
                value={baseUrl}
                onChange={(e) => { setBaseUrl(e.target.value); setDirty(true); }}
                placeholder={
                  provider === "gitlab"
                    ? "https://gitlab.com"
                    : "https://codeberg.org"
                }
                className="font-mono"
              />
              <p className="text-[11px] leading-relaxed text-ink-mute">
                {t("myApps.edit.githubSource.baseUrlHint")}
              </p>
            </div>
          )}

          {/* Per-source PAT — write-only. Three visual states:
                * No stored token & action=keep → empty password input
                  + helper text ("optional")
                * Stored token & action=keep → chip "Token configured"
                  with [Replace] / [Clear] buttons, no input
                * action=set → password input (focused), [Cancel] reverts
                * action=clear → message "Token will be cleared on save"
                  with [Undo] button */}
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="gh-token" className="text-xs font-medium uppercase tracking-wider text-ink-mute">
              {t("myApps.edit.githubSource.tokenLabel")}
            </Label>
            {hasStoredToken && tokenAction === "keep" && (
              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-primary/30 bg-primary-container/30 px-3 py-2">
                <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-primary-on-container">
                  <span className="h-1.5 w-1.5 rounded-pill bg-primary" />
                  {t("myApps.edit.githubSource.tokenConfigured")}
                </span>
                <div className="ml-auto flex gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => { setTokenAction("set"); setDirty(true); }}
                  >
                    {t("myApps.edit.githubSource.tokenReplace")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-danger hover:bg-danger-container"
                    onClick={() => { setTokenAction("clear"); setDirty(true); }}
                  >
                    {t("myApps.edit.githubSource.tokenClear")}
                  </Button>
                </div>
              </div>
            )}
            {tokenAction === "set" && (
              <div className="flex items-center gap-2">
                <Input
                  id="gh-token"
                  type="password"
                  autoComplete="off"
                  value={tokenInput}
                  onChange={(e) => { setTokenInput(e.target.value); setDirty(true); }}
                  placeholder={t(`myApps.edit.githubSource.tokenPlaceholder_${provider}`)}
                  className="font-mono"
                />
                {hasStoredToken && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => { setTokenAction("keep"); setTokenInput(""); }}
                  >
                    {t("common.cancel")}
                  </Button>
                )}
              </div>
            )}
            {tokenAction === "clear" && (
              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-danger/40 bg-danger-container/30 px-3 py-2">
                <span className="text-xs text-danger-on-container">
                  {t("myApps.edit.githubSource.tokenWillBeCleared")}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => { setTokenAction("keep"); }}
                >
                  {t("myApps.edit.githubSource.tokenUndoClear")}
                </Button>
              </div>
            )}
            {!hasStoredToken && tokenAction !== "set" && (
              // New source — show the field directly so users can
              // paste a PAT without an extra click.
              <Input
                id="gh-token"
                type="password"
                autoComplete="off"
                value={tokenInput}
                onChange={(e) => {
                  setTokenInput(e.target.value);
                  setTokenAction(e.target.value ? "set" : "keep");
                  setDirty(true);
                }}
                placeholder={t(`myApps.edit.githubSource.tokenPlaceholder_${provider}`)}
                className="font-mono"
              />
            )}
            <p className="text-[11px] leading-relaxed text-ink-mute">
              {t("myApps.edit.githubSource.tokenHint")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gh-pattern" className="text-xs font-medium uppercase tracking-wider text-ink-mute">
              {t("myApps.edit.githubSource.patternLabel")}
            </Label>
            <Input
              id="gh-pattern"
              value={assetPattern}
              onChange={(e) => { setAssetPattern(e.target.value); setDirty(true); }}
              placeholder="*.apk"
              className="font-mono"
            />
            <p className="text-[11px] leading-relaxed text-ink-mute">
              {t("myApps.edit.githubSource.patternHint")}
            </p>
          </div>

          <div className="flex flex-col gap-3 md:items-end md:justify-end">
            <ToggleRow
              label={t("myApps.edit.githubSource.includePrereleases")}
              checked={includePrereleases}
              onChange={(v) => { setIncludePrereleases(v); setDirty(true); }}
            />
            <ToggleRow
              label={t("myApps.edit.githubSource.enabled")}
              hint={t("myApps.edit.githubSource.enabledHint")}
              checked={enabled}
              onChange={(v) => { setEnabled(v); setDirty(true); }}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-outline-soft pt-4">
          <div className="flex flex-wrap items-center gap-2">
            {source && (
              <>
                <Button
                  type="button"
                  variant="outlined"
                  onClick={onScanNow}
                  disabled={scanning || awaitingScan}
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", (scanning || awaitingScan) && "animate-spin")} />
                  {awaitingScan
                    ? t("myApps.edit.githubSource.scanRunning")
                    : t("myApps.edit.githubSource.scanNow")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onRemove}
                  disabled={removing}
                  className="text-danger hover:bg-danger-container"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("myApps.edit.githubSource.remove")}
                </Button>
              </>
            )}
          </div>
          <Button type="submit" variant="filled" disabled={saving || !repo.trim()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitBranch className="h-3.5 w-3.5" />}
            {source ? t("myApps.edit.githubSource.update") : t("myApps.edit.githubSource.connect")}
          </Button>
        </div>
      </form>
    </div>
  );
}


function StatusBanner({
  source,
  scanning,
}: {
  source: GithubSource;
  scanning: boolean;
}) {
  const { t } = useTranslation();
  const tone = toneFor(source.last_status, scanning);
  return (
    <div
      className={cn(
        "rounded-2xl border px-4 py-3",
        tone === "error" && "border-danger/30 bg-danger-container/40",
        tone === "ok" && "border-primary/30 bg-primary-container/30",
        tone === "neutral" && "border-outline-soft bg-surface-2",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <StatusIcon status={source.last_status} scanning={scanning} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusBadge status={source.last_status} scanning={scanning} />
              {source.last_release_tag && (
                <a
                  href={`https://github.com/${source.repo}/releases/tag/${source.last_release_tag}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-xs font-mono text-ink-soft hover:text-primary"
                >
                  {source.last_release_tag}
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            {source.last_error && (
              <p className="mt-1.5 break-words text-xs text-danger">
                {source.last_error}
              </p>
            )}
            <p className="mt-1 text-[11px] text-ink-mute">
              {source.last_scanned_at
                ? t("myApps.edit.githubSource.lastScanned", { date: formatDate(source.last_scanned_at) })
                : t("myApps.edit.githubSource.neverScanned")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}


function StatusIcon({ status, scanning }: { status: GithubSourceStatus; scanning: boolean }) {
  if (scanning) return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />;
  if (status === "error") return <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />;
  if (status === "imported" || status === "up_to_date")
    return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />;
  return <GitBranch className="mt-0.5 h-4 w-4 shrink-0 text-ink-mute" />;
}


function StatusBadge({ status, scanning }: { status: GithubSourceStatus; scanning: boolean }) {
  const { t } = useTranslation();
  if (scanning) {
    return <Badge variant="primary">{t("myApps.edit.githubSource.statusScanning")}</Badge>;
  }
  switch (status) {
    case "idle":
      return <Badge variant="outline">{t("myApps.edit.githubSource.statusIdle")}</Badge>;
    case "up_to_date":
      return <Badge variant="primary">{t("myApps.edit.githubSource.statusUpToDate")}</Badge>;
    case "imported":
      return <Badge variant="primary">{t("myApps.edit.githubSource.statusImported")}</Badge>;
    case "skipped":
      return <Badge variant="outline">{t("myApps.edit.githubSource.statusSkipped")}</Badge>;
    case "error":
      return <Badge variant="destructive">{t("myApps.edit.githubSource.statusError")}</Badge>;
  }
}


function toneFor(status: GithubSourceStatus, scanning: boolean): "ok" | "error" | "neutral" {
  if (scanning) return "neutral";
  if (status === "error") return "error";
  if (status === "imported" || status === "up_to_date") return "ok";
  return "neutral";
}


function ProviderPill({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-pill px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-primary text-primary-fg shadow-e1"
          : "text-ink-soft hover:text-ink",
      )}
    >
      {label}
    </button>
  );
}


function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex w-full cursor-pointer items-start justify-between gap-3 rounded-2xl border border-outline-soft bg-surface px-3 py-2.5 transition-colors hover:bg-surface-2 md:w-72">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-relaxed text-ink-mute">{hint}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} ariaLabel={label} />
    </label>
  );
}


/** Centred modal that surfaces App listing fields the connected GitHub
 *  repo could populate. Each row has a checkbox so the operator picks
 *  which to apply — pre-checked on first appearance because the most
 *  likely intent after wiring a source is "fill everything". Closes on
 *  backdrop click, X button, or Escape. */
function ProposedFieldsCard({
  proposed,
  picked,
  onToggle,
  onApply,
  onDismiss,
  busy,
}: {
  proposed: ProposedAppField[];
  picked: Set<string>;
  onToggle: (field: string) => void;
  onApply: () => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const pickedCount = proposed.filter((p) => picked.has(p.field)).length;
  const applyBtnRef = useRef<HTMLButtonElement>(null);

  // Lock the page scroll + focus the primary action while the modal is
  // open so the user can hit Enter immediately. Escape closes.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onDismiss();
    };
    window.addEventListener("keydown", onKey);
    // Defer focus a tick so the animation doesn't fight with the
    // browser stealing focus mid-frame.
    const focusId = window.setTimeout(() => applyBtnRef.current?.focus(), 40);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(focusId);
    };
  }, [busy, onDismiss]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8">
      {/* Backdrop — single click target so backdrop dismissal is one tap. */}
      <button
        type="button"
        aria-label={t("common.close")}
        onClick={() => { if (!busy) onDismiss(); }}
        className="absolute inset-0 animate-fade-in bg-black/45 backdrop-blur-[3px]"
      />

      {/* Card */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="github-proposed-title"
        className="relative w-full max-w-md animate-modal-pop overflow-hidden rounded-3xl border border-outline-soft bg-surface shadow-e4"
      >
        {/* Primary-tinted wash + trim-marks in the top-right corner,
            echoing the editorial chrome of the parent page. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(70% 100% at 0% 0%, rgb(var(--primary) / 0.16), transparent 60%)",
          }}
        />
        <div aria-hidden className="pointer-events-none absolute right-5 top-5 h-8 w-8">
          <div className="absolute inset-x-0 top-0 h-px bg-outline" />
          <div className="absolute inset-y-0 right-0 w-px bg-outline" />
        </div>

        <div className="relative p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-primary text-primary-fg shadow-e1">
                <Sparkles className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-primary">
                  {t("myApps.edit.githubSource.proposed.eyebrow")}
                </div>
                <h3
                  id="github-proposed-title"
                  className="mt-1 text-lg font-bold leading-tight tracking-tight text-ink"
                >
                  {t("myApps.edit.githubSource.proposed.title")}
                </h3>
              </div>
            </div>
            <button
              type="button"
              onClick={() => { if (!busy) onDismiss(); }}
              aria-label={t("common.close")}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-pill text-ink-mute transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-soft">
            {t("myApps.edit.githubSource.proposed.body")}
          </p>

          <ul className="mt-5 max-h-[55vh] space-y-1.5 overflow-y-auto pr-1">
            {proposed.map((p) => {
              const id = `proposed-${p.field}`;
              const isPicked = picked.has(p.field);
              return (
                <li key={p.field}>
                  <label
                    htmlFor={id}
                    className={cn(
                      "flex cursor-pointer items-start gap-2.5 rounded-2xl border bg-surface px-3 py-2.5 transition-colors",
                      isPicked
                        ? "border-primary/50 bg-primary-container/20"
                        : "border-outline-soft hover:border-outline hover:bg-surface-2",
                    )}
                  >
                    <input
                      id={id}
                      type="checkbox"
                      checked={isPicked}
                      onChange={() => onToggle(p.field)}
                      className="mt-1"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                        {t(`myApps.edit.githubSource.proposed.field.${p.field}`)}
                      </div>
                      <div className="mt-0.5 break-words text-sm text-ink">
                        {p.proposed_value}
                      </div>
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>

          <div className="mt-5 flex items-center justify-end gap-2 border-t border-outline-soft pt-4">
            <Button type="button" variant="ghost" size="sm" onClick={onDismiss} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              ref={applyBtnRef}
              type="button"
              variant="filled"
              size="sm"
              onClick={onApply}
              disabled={busy || pickedCount === 0}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {t("myApps.edit.githubSource.proposed.apply", { count: pickedCount })}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
