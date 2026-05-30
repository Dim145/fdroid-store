"use client";

import {
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Globe2,
  KeyRound,
  Loader2,
  Plug,
  Plus,
  PlusCircle,
  Power,
  RefreshCw,
  ShieldQuestion,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet } from "@/components/ui/sheet";
import {
  API_URL,
  api,
  type ApkProxyPublicRead,
  type ApkProxySourceRead,
  type ProxyProviderDescriptor,
} from "@/lib/api";
import { toast } from "@/lib/toast-store";
import { cn, formatDate } from "@/lib/utils";


/* ============================================================================
 * ProxySourcesSection — per-app proxy-driven release sources.
 *
 * The companion to ``GithubSourceSection`` for anything that isn't a Git forge:
 * a user picks one of the admin-registered proxies, then one of that proxy's
 * declared providers (F-Droid mirror, Patreon, private artefact registry, …),
 * pastes the upstream URL, and fills whatever auth the provider asks for
 * (nothing, API token, OAuth popup, …). The worker then polls /resolve on a
 * daily cron and imports new releases the same way it does GitHub ones.
 *
 * Unlike GitHub source which is a singleton per app, an app can hold multiple
 * proxy sources (one per provider) — e.g. an F-Droid mirror + a Patreon
 * early-access feed both pointing at the same package.
 * ============================================================================ */


export function ProxySourcesSection({
  appId,
  onImported,
}: {
  appId: string;
  /** Fired when a fresh import lands so the parent can reload the APK list. */
  onImported?: () => void;
}) {
  const { t } = useTranslation();
  const [sources, setSources] = useState<ApkProxySourceRead[]>([]);
  const [proxies, setProxies] = useState<ApkProxyPublicRead[]>([]);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);

  // Track release_ids we've already reported as "imported" so we only fire
  // onImported once per fresh release_id per source. Without this, a poll
  // landing while last_status=imported would notify the parent every tick.
  const seenReleases = useRef<Map<string, string>>(new Map());

  // The parent passes a fresh inline ``onImported`` lambda each render. Route
  // it through a ref so the polling effect below doesn't list it as a dep —
  // otherwise the 4s interval is torn down and recreated on every parent
  // re-render (frequent during a scan), making the tick fire late or stall.
  const onImportedRef = useRef(onImported);
  useEffect(() => { onImportedRef.current = onImported; }, [onImported]);

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([
        api.proxySources.list(appId),
        api.proxies.listAvailable().catch(() => []),
      ]);
      setSources(s);
      setProxies(p);
      // First load: prime ``seenReleases`` from server state so we don't
      // fire onImported on initial mount.
      for (const src of s) {
        if (src.last_release_id) {
          const prev = seenReleases.current.get(src.id);
          if (!prev) seenReleases.current.set(src.id, src.last_release_id);
        }
      }
    } catch (e) {
      toast.error(
        t("myApps.edit.proxySources.loadFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setLoading(false);
    }
  }, [appId, t]);

  useEffect(() => { void load(); }, [load]);

  // Poll while any source is mid-scan (suspended_until in the future doesn't
  // count — it's a passive cooldown, not active work). We poll on a soft
  // 4-second tick and stop when no source is "in flight" anymore. This
  // matches the GitHub-source UX: kick a scan, the row updates within a
  // few seconds without a manual refresh.
  const anyScanning = useMemo(
    () => sources.some((s) => isScanInFlight(s)),
    [sources],
  );
  useEffect(() => {
    if (!anyScanning) return;
    const tick = window.setInterval(async () => {
      const next = await api.proxySources.list(appId).catch(() => undefined);
      if (!next) return;
      setSources(next);
      // Detect fresh imports — any source whose last_release_id rolled to
      // a value we haven't seen yet.
      for (const src of next) {
        if (
          src.last_status === "imported" &&
          src.last_release_id &&
          src.last_release_id !== seenReleases.current.get(src.id)
        ) {
          seenReleases.current.set(src.id, src.last_release_id);
          onImportedRef.current?.();
        }
      }
    }, 4000);
    return () => window.clearInterval(tick);
  }, [anyScanning, appId]);

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
      {/* Headline + add-source CTA. The CTA is always present even when there
          are zero sources so the empty state stays a single-click flow. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm leading-relaxed text-ink-soft">
            {t("myApps.edit.proxySources.intro")}
          </p>
        </div>
        <Button
          type="button"
          variant="filled"
          size="sm"
          onClick={() => setWizardOpen(true)}
          disabled={proxies.length === 0}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("myApps.edit.proxySources.add")}
        </Button>
      </div>

      {/* No proxies registered at all → cannot add a source. We render a
          subdued notice with the admin path for the operator who hasn't
          set anything up yet — non-admins just see "ask your admin". */}
      {proxies.length === 0 && (
        <NoProxiesNotice />
      )}

      {/* Existing sources, sorted by created_at asc (oldest first). */}
      {sources.length > 0 ? (
        <ul className="space-y-3">
          {sources.map((src) => {
            const proxy = proxies.find((p) => p.id === src.proxy_id);
            return (
              <li key={src.id}>
                <SourceRow
                  source={src}
                  proxy={proxy}
                  appId={appId}
                  onChanged={load}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        proxies.length > 0 && (
          <div className="rounded-2xl border border-dashed border-outline-soft bg-surface-2/60 px-5 py-6 text-center">
            <Plug className="mx-auto mb-2 h-5 w-5 text-ink-mute" />
            <p className="text-sm text-ink-soft">
              {t("myApps.edit.proxySources.empty")}
            </p>
          </div>
        )
      )}

      {/* Add-source wizard. Mounted always so the entrance animation works
          even on the first click; ``open`` flips the sheet. */}
      <AddSourceSheet
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        appId={appId}
        proxies={proxies}
        existingProviders={new Set(sources.map((s) => `${s.proxy_id}:${s.provider}`))}
        onCreated={async () => {
          setWizardOpen(false);
          await load();
        }}
      />
    </div>
  );
}


/** A scan is "in flight" if it was triggered recently and the worker hasn't
 *  written back yet. We approximate that with a fresh ``last_scanned_at``
 *  ≤ 8 seconds ago — long enough to cover the round-trip from arq pick-up,
 *  short enough that a stale row doesn't keep us polling forever. The
 *  per-source ``scanNow`` button also flips a local boolean for instant
 *  feedback; this is the cross-tab fallback. */
function isScanInFlight(src: ApkProxySourceRead): boolean {
  if (!src.last_scanned_at) return false;
  const last = Date.parse(src.last_scanned_at);
  return Number.isFinite(last) && Date.now() - last < 8000;
}


function NoProxiesNotice() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-2xl border border-outline-soft bg-surface-2 px-4 py-3">
      <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-ink-mute" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">
          {t("myApps.edit.proxySources.noProxiesTitle")}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-ink-mute">
          {t("myApps.edit.proxySources.noProxiesBody")}
        </p>
      </div>
    </div>
  );
}


/* ============================================================================
 * Source row — one existing proxy source attached to the app.
 * ============================================================================ */


function SourceRow({
  source,
  proxy,
  appId,
  onChanged,
}: {
  source: ApkProxySourceRead;
  proxy: ApkProxyPublicRead | undefined;
  appId: string;
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [scanning, setScanning] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [togglingEnabled, setTogglingEnabled] = useState(false);

  const provider = useMemo(() => {
    const cat = proxy?.cached_sources_json;
    if (!cat) return null;
    return cat.providers.find((p) => p.id === source.provider) ?? null;
  }, [proxy, source.provider]);

  async function onScan() {
    setScanning(true);
    try {
      await api.proxySources.scanNow(appId, source.id);
      toast.success(t("myApps.edit.proxySources.scanQueued"));
      // The polling effect in the parent picks up the row's fresh
      // ``last_scanned_at`` and renders the spinner. Reload now to
      // catch the immediate state transition.
      await onChanged();
    } catch (e) {
      toast.error(
        t("myApps.edit.proxySources.scanFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setScanning(false);
    }
  }

  async function onToggleEnabled() {
    setTogglingEnabled(true);
    try {
      await api.proxySources.update(appId, source.id, { enabled: !source.enabled });
      toast.success(
        source.enabled
          ? t("myApps.edit.proxySources.disabledOk")
          : t("myApps.edit.proxySources.enabledOk"),
      );
      await onChanged();
    } catch (e) {
      toast.error(
        t("myApps.edit.proxySources.updateFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setTogglingEnabled(false);
    }
  }

  async function onRemove() {
    if (!confirm(t("myApps.edit.proxySources.removeConfirm"))) return;
    setRemoving(true);
    try {
      await api.proxySources.remove(appId, source.id);
      toast.success(t("myApps.edit.proxySources.removed"));
      await onChanged();
    } catch (e) {
      toast.error(
        t("myApps.edit.proxySources.removeFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setRemoving(false);
    }
  }

  const tone = toneFor(source);
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border bg-surface",
        tone === "error" && "border-danger/30",
        tone === "ok" && "border-primary/30",
        tone === "neutral" && "border-outline-soft",
      )}
    >
      {/* Top band — subtle tinted wash matches tone */}
      <div
        className={cn(
          "px-4 py-3",
          tone === "error" && "bg-danger-container/30",
          tone === "ok" && "bg-primary-container/20",
          tone === "neutral" && "bg-surface-2",
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <StatusIcon source={source} scanning={scanning || isScanInFlight(source)} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-semibold text-ink">
                  {provider?.name ?? source.provider}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                  · {proxy?.name ?? t("myApps.edit.proxySources.unknownProxy")}
                </span>
                <StatusBadge source={source} scanning={scanning || isScanInFlight(source)} />
              </div>
              <a
                href={source.source_url}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-0.5 inline-flex items-center gap-1 break-all text-xs text-ink-soft hover:text-primary"
              >
                <span className="font-mono">{source.source_url}</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
              {source.last_error && (
                <p className="mt-1.5 break-words text-xs text-danger">
                  {source.last_error}
                </p>
              )}
              {source.suspended_until && (
                <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-ink-mute">
                  <Clock className="h-3 w-3" />
                  {t("myApps.edit.proxySources.suspendedUntil", {
                    date: formatDate(source.suspended_until),
                  })}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Body — meta rows + action strip */}
      <div className="space-y-2 px-4 pb-3 pt-2 text-xs text-ink-mute">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider">
              {t("myApps.edit.proxySources.lastRelease")}
            </span>
            {source.last_release_id ? (
              <span className="font-mono text-ink">{source.last_release_id}</span>
            ) : (
              <span className="italic">{t("myApps.edit.proxySources.never")}</span>
            )}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider">
              {t("myApps.edit.proxySources.lastScan")}
            </span>
            {source.last_scanned_at ? (
              <span className="text-ink">{formatDate(source.last_scanned_at)}</span>
            ) : (
              <span className="italic">{t("myApps.edit.proxySources.never")}</span>
            )}
          </span>
          {source.has_secrets && (
            <span className="inline-flex items-center gap-1">
              <KeyRound className="h-3 w-3" />
              {t("myApps.edit.proxySources.secretsConfigured")}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-outline-soft pt-2">
          <Button
            type="button"
            variant="outlined"
            size="sm"
            onClick={onScan}
            disabled={scanning || !source.enabled}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", scanning && "animate-spin")} />
            {scanning
              ? t("myApps.edit.proxySources.scanRunning")
              : t("myApps.edit.proxySources.scanNow")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onToggleEnabled}
            disabled={togglingEnabled}
          >
            <Power className="h-3.5 w-3.5" />
            {source.enabled
              ? t("myApps.edit.proxySources.disable")
              : t("myApps.edit.proxySources.enable")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRemove}
            disabled={removing}
            className="ml-auto text-danger hover:bg-danger-container"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("myApps.edit.proxySources.remove")}
          </Button>
        </div>
      </div>
    </div>
  );
}


function StatusIcon({
  source,
  scanning,
}: {
  source: ApkProxySourceRead;
  scanning: boolean;
}) {
  if (scanning) {
    return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />;
  }
  if (source.last_status === "error" || source.last_status === "auth_required") {
    return <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />;
  }
  if (source.last_status === "imported" || source.last_status === "up_to_date") {
    return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />;
  }
  return <Globe2 className="mt-0.5 h-4 w-4 shrink-0 text-ink-mute" />;
}


function StatusBadge({
  source,
  scanning,
}: {
  source: ApkProxySourceRead;
  scanning: boolean;
}) {
  const { t } = useTranslation();
  if (scanning) {
    return <Badge variant="primary">{t("myApps.edit.proxySources.statusScanning")}</Badge>;
  }
  if (!source.enabled) {
    return <Badge variant="outline">{t("myApps.edit.proxySources.statusDisabled")}</Badge>;
  }
  switch (source.last_status) {
    case "idle":
      return <Badge variant="outline">{t("myApps.edit.proxySources.statusIdle")}</Badge>;
    case "up_to_date":
      return <Badge variant="primary">{t("myApps.edit.proxySources.statusUpToDate")}</Badge>;
    case "imported":
      return <Badge variant="primary">{t("myApps.edit.proxySources.statusImported")}</Badge>;
    case "skipped":
      return <Badge variant="outline">{t("myApps.edit.proxySources.statusSkipped")}</Badge>;
    case "auth_required":
      return <Badge variant="destructive">{t("myApps.edit.proxySources.statusAuthRequired")}</Badge>;
    case "rate_limited":
      return <Badge variant="destructive">{t("myApps.edit.proxySources.statusRateLimited")}</Badge>;
    case "error":
      return <Badge variant="destructive">{t("myApps.edit.proxySources.statusError")}</Badge>;
  }
}


function toneFor(source: ApkProxySourceRead): "ok" | "error" | "neutral" {
  if (!source.enabled) return "neutral";
  if (
    source.last_status === "error" ||
    source.last_status === "auth_required" ||
    source.last_status === "rate_limited"
  ) {
    return "error";
  }
  if (source.last_status === "imported" || source.last_status === "up_to_date") {
    return "ok";
  }
  return "neutral";
}


/* ============================================================================
 * Add-source wizard (right-edge Sheet)
 *
 * Three steps in a single panel — pick proxy → pick provider → fill form.
 * Mid-step changes (going back) reset the downstream selections so a stale
 * provider from a previous proxy can never end up in the submit payload.
 * ============================================================================ */


type WizardStep = "proxy" | "provider" | "form";


function AddSourceSheet({
  open,
  onClose,
  appId,
  proxies,
  existingProviders,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  appId: string;
  proxies: ApkProxyPublicRead[];
  /** Set of ``"<proxy_id>:<provider>"`` keys that are already attached so
   *  the wizard greys those provider tiles out (the backend will refuse
   *  with 409 anyway, but a frontend hint is friendlier). */
  existingProviders: Set<string>;
  onCreated: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStep>("proxy");
  const [pickedProxy, setPickedProxy] = useState<ApkProxyPublicRead | null>(null);
  const [pickedProvider, setPickedProvider] = useState<ProxyProviderDescriptor | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // The HMAC-signed state we sent to the proxy at oauth-begin time. Kept in
  // a ref (not state) because it's only read inside the message handler —
  // calling setters from an updater is a React anti-pattern.
  const oauthStateRef = useRef<string | null>(null);
  // Mirror of ``credentialId`` for the popup-close watcher. The interval
  // fires on the timer cadence and needs the LATEST value at fire time;
  // closing over the state binding would freeze it at popup-open.
  const credentialIdRef = useRef<string | null>(null);
  useEffect(() => {
    credentialIdRef.current = credentialId;
  }, [credentialId]);
  // Live id of the popup-close watcher so we can clear it on unmount or
  // when the sheet closes — otherwise a user that abandons OAuth and
  // navigates away leaves a 700 ms interval firing setState forever.
  const watcherRef = useRef<number | null>(null);

  // Reset everything when the sheet re-opens. Without this, picking a
  // proxy → opening the sheet again would keep the previous selection.
  useEffect(() => {
    if (!open) {
      if (watcherRef.current !== null) {
        window.clearInterval(watcherRef.current);
        watcherRef.current = null;
      }
      return;
    }
    setStep("proxy");
    setPickedProxy(null);
    setPickedProvider(null);
    setSourceUrl("");
    setSecrets({});
    setCredentialId(null);
    oauthStateRef.current = null;
    setOauthBusy(false);
    setSubmitting(false);
  }, [open]);

  // Unmount-safety net. If the parent unmounts this whole sub-tree while
  // an OAuth flow is in flight, the interval above wouldn't be cleared
  // by the ``open=false`` branch (the cleanup runs but ``open`` was true
  // up to that moment). This cleanup catches the unmount path.
  useEffect(() => {
    return () => {
      if (watcherRef.current !== null) {
        window.clearInterval(watcherRef.current);
        watcherRef.current = null;
      }
    };
  }, []);

  // postMessage listener for the OAuth popup. We mount it ONCE per sheet
  // open and tear it down on close. The state guard is what protects us
  // against a stale popup from a previous wizard run.
  useEffect(() => {
    if (!open) return;
    function onMessage(event: MessageEvent) {
      // The popup runs on the API origin and posts to settings.public_app_url
      // (the SPA's own origin). When deployed single-origin the API and SPA
      // share an origin, in which case event.origin === window.location.origin.
      // For split-origin deployments, event.origin is the API origin — we
      // accept either.
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
      const msg = parsed as {
        type: string;
        credential_id?: string;
        state?: string;
      };
      // State guard — the popup carries back the exact state we sent.
      // Any mismatch (stale popup, unrelated message, tampering) is silently
      // ignored.
      if (!oauthStateRef.current || msg.state !== oauthStateRef.current) {
        return;
      }
      setCredentialId(msg.credential_id ?? null);
      setOauthBusy(false);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open]);

  async function beginOAuth() {
    if (!pickedProxy || !pickedProvider) return;
    setOauthBusy(true);
    setCredentialId(null);
    try {
      const resp = await api.proxySources.oauthBegin(appId, {
        proxy_id: pickedProxy.id,
        provider: pickedProvider.id,
      });
      oauthStateRef.current = resp.state;
      // ``popup_url`` comes from the API (built from an admin-registered
      // proxy base_url). Refuse anything that isn't http(s) so a hostile /
      // mis-registered proxy can't smuggle a ``javascript:`` URL that would
      // execute in this origin via window.open. Matches the guard on the
      // APK-download links.
      if (!/^https?:\/\//i.test(resp.popup_url)) {
        setOauthBusy(false);
        toast.error(t("myApps.edit.proxySources.popupBlocked"));
        return;
      }
      // Open the popup. Width/height match a typical OAuth provider window
      // (Google, Patreon, …) — generous enough for the consent screen
      // without dominating the page.
      const popup = window.open(
        resp.popup_url,
        "proxy-oauth",
        "width=600,height=720,scrollbars=yes,resizable=yes,noopener=no",
      );
      if (!popup) {
        setOauthBusy(false);
        toast.error(t("myApps.edit.proxySources.popupBlocked"));
        return;
      }
      // Clear any prior watcher (the user can rapidly retry by clicking
      // Connect again before closing the previous popup).
      if (watcherRef.current !== null) {
        window.clearInterval(watcherRef.current);
      }
      // Watch the popup's ``closed`` flag so an abandoned dance doesn't
      // hang the spinner forever. The credential-id ref carries the
      // latest message-handler result; closing over state would freeze
      // it at popup-open.
      watcherRef.current = window.setInterval(() => {
        if (!popup.closed) return;
        if (watcherRef.current !== null) {
          window.clearInterval(watcherRef.current);
          watcherRef.current = null;
        }
        if (!credentialIdRef.current) {
          setOauthBusy(false);
          toast.error(t("myApps.edit.proxySources.popupClosed"));
        }
      }, 700);
    } catch (e) {
      setOauthBusy(false);
      toast.error(
        t("myApps.edit.proxySources.oauthBeginFailed"),
        e instanceof Error ? e.message : undefined,
      );
    }
  }

  async function onSubmit() {
    if (!pickedProxy || !pickedProvider) return;
    if (!sourceUrl.trim()) return;
    // Build the secrets payload depending on auth_kind.
    let secretsPayload: Record<string, string> = {};
    if (pickedProvider.auth_kind === "oauth2") {
      if (!credentialId) return;
      secretsPayload = { credential_id: credentialId };
    } else if (pickedProvider.auth_kind !== "none") {
      // Drop empty optionals so the proxy doesn't get blank strings.
      for (const f of pickedProvider.secret_fields) {
        const v = (secrets[f.key] ?? "").trim();
        if (v) secretsPayload[f.key] = v;
      }
    }
    setSubmitting(true);
    try {
      await api.proxySources.create(appId, {
        proxy_id: pickedProxy.id,
        provider: pickedProvider.id,
        source_url: sourceUrl.trim(),
        secrets: secretsPayload,
      });
      toast.success(t("myApps.edit.proxySources.createdOk"));
      await onCreated();
    } catch (e) {
      toast.error(
        t("myApps.edit.proxySources.createFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setSubmitting(false);
    }
  }

  // Compute the submit gate. The "form" step is the only one that submits.
  const canSubmit = (() => {
    if (step !== "form" || !pickedProxy || !pickedProvider) return false;
    if (!sourceUrl.trim()) return false;
    if (pickedProvider.auth_kind === "oauth2" && !credentialId) return false;
    if (pickedProvider.auth_kind === "api_token" || pickedProvider.auth_kind === "basic") {
      for (const f of pickedProvider.secret_fields) {
        if (f.required && !(secrets[f.key] ?? "").trim()) return false;
      }
    }
    return true;
  })();

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("myApps.edit.proxySources.wizard.title")}
      eyebrow={
        <>
          <span>{t("myApps.edit.proxySources.wizard.eyebrow")}</span>
          {step !== "proxy" && pickedProxy && (
            <>
              <span aria-hidden>·</span>
              <span className="normal-case">{pickedProxy.name}</span>
            </>
          )}
          {step === "form" && pickedProvider && (
            <>
              <span aria-hidden>·</span>
              <span className="normal-case">{pickedProvider.name}</span>
            </>
          )}
        </>
      }
      size="default"
      footer={
        <>
          {step !== "proxy" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (step === "provider") {
                  setStep("proxy");
                  setPickedProvider(null);
                } else if (step === "form") {
                  setStep("provider");
                  setSourceUrl("");
                  setSecrets({});
                  setCredentialId(null);
                  oauthStateRef.current = null;
                }
              }}
              disabled={submitting || oauthBusy}
            >
              {t("common.back")}
            </Button>
          )}
          {step === "form" && (
            <Button
              type="button"
              variant="filled"
              size="sm"
              onClick={onSubmit}
              disabled={!canSubmit || submitting}
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PlusCircle className="h-3.5 w-3.5" />
              )}
              {t("myApps.edit.proxySources.wizard.create")}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-5">
        <StepBar step={step} />

        {step === "proxy" && (
          <ProxyPickerStep
            proxies={proxies}
            onPick={(p) => {
              setPickedProxy(p);
              setStep("provider");
            }}
          />
        )}

        {step === "provider" && pickedProxy && (
          <ProviderPickerStep
            proxy={pickedProxy}
            existingProviders={existingProviders}
            onPick={(p) => {
              setPickedProvider(p);
              setSecrets({});
              setCredentialId(null);
              oauthStateRef.current = null;
              // Prefill url_hint placeholder semantically by leaving the
              // input empty — the placeholder is set on the Input below
              // from the picked provider's url_hint.
              setStep("form");
            }}
          />
        )}

        {step === "form" && pickedProxy && pickedProvider && (
          <FormStep
            proxy={pickedProxy}
            provider={pickedProvider}
            sourceUrl={sourceUrl}
            setSourceUrl={setSourceUrl}
            secrets={secrets}
            setSecrets={setSecrets}
            credentialId={credentialId}
            oauthBusy={oauthBusy}
            onBeginOAuth={beginOAuth}
          />
        )}
      </div>
    </Sheet>
  );
}


function StepBar({ step }: { step: WizardStep }) {
  const { t } = useTranslation();
  const steps: { id: WizardStep; label: string }[] = [
    { id: "proxy", label: t("myApps.edit.proxySources.wizard.stepProxy") },
    { id: "provider", label: t("myApps.edit.proxySources.wizard.stepProvider") },
    { id: "form", label: t("myApps.edit.proxySources.wizard.stepForm") },
  ];
  const activeIdx = steps.findIndex((s) => s.id === step);
  return (
    <ol className="flex items-center gap-2">
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
            <span
              className={cn(
                "text-xs font-medium",
                active && "text-ink",
                !active && "text-ink-mute",
              )}
            >
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


function ProxyPickerStep({
  proxies,
  onPick,
}: {
  proxies: ApkProxyPublicRead[];
  onPick: (p: ApkProxyPublicRead) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-soft">
        {t("myApps.edit.proxySources.wizard.proxyHint")}
      </p>
      <ul className="space-y-2">
        {proxies.map((p) => {
          const providerCount = p.cached_sources_json?.providers.length ?? 0;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onPick(p)}
                className={cn(
                  "group flex w-full items-start gap-3 rounded-2xl border border-outline-soft bg-surface px-4 py-3 text-left transition-colors",
                  "hover:border-primary/50 hover:bg-primary-container/15",
                )}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-ink-soft group-hover:bg-primary/15 group-hover:text-primary">
                  <Plug className="h-4 w-4" strokeWidth={2.2} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold text-ink">{p.name}</span>
                    <Badge variant="outline">
                      {t("myApps.edit.proxySources.wizard.providersCount", {
                        count: providerCount,
                      })}
                    </Badge>
                  </div>
                  {/* base_url is admin-only — not surfaced here. The cached
                      catalogue + provider list below is enough for the user
                      to recognise which proxy is which. */}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}


function ProviderPickerStep({
  proxy,
  existingProviders,
  onPick,
}: {
  proxy: ApkProxyPublicRead;
  existingProviders: Set<string>;
  onPick: (p: ProxyProviderDescriptor) => void;
}) {
  const { t } = useTranslation();
  const providers = proxy.cached_sources_json?.providers ?? [];
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-soft">
        {t("myApps.edit.proxySources.wizard.providerHint", { proxy: proxy.name })}
      </p>
      {providers.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-outline-soft bg-surface-2 px-4 py-5 text-center text-sm text-ink-mute">
          {t("myApps.edit.proxySources.wizard.providerEmpty")}
        </div>
      ) : (
        <ul className="space-y-2">
          {providers.map((p) => {
            const taken = existingProviders.has(`${proxy.id}:${p.id}`);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => { if (!taken) onPick(p); }}
                  disabled={taken}
                  className={cn(
                    "group flex w-full items-start gap-3 rounded-2xl border bg-surface px-4 py-3 text-left transition-colors",
                    taken
                      ? "border-outline-soft opacity-60 cursor-not-allowed"
                      : "border-outline-soft hover:border-primary/50 hover:bg-primary-container/15",
                  )}
                >
                  <ProviderIcon descriptor={p} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-semibold text-ink">{p.name}</span>
                      <AuthKindBadge kind={p.auth_kind} />
                      {taken && (
                        <Badge variant="outline">
                          {t("myApps.edit.proxySources.wizard.alreadyAttached")}
                        </Badge>
                      )}
                    </div>
                    {p.description && (
                      <p className="mt-0.5 text-xs leading-relaxed text-ink-mute">
                        {p.description}
                      </p>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}


function ProviderIcon({ descriptor }: { descriptor: ProxyProviderDescriptor }) {
  // Use the proxy-supplied icon_url when present — we trust the admin's
  // proxy choice. Falls back to a generic globe glyph otherwise.
  if (descriptor.icon_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={descriptor.icon_url}
        alt=""
        className="mt-0.5 h-9 w-9 shrink-0 rounded-pill border border-outline-soft bg-surface object-cover"
        loading="lazy"
      />
    );
  }
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-ink-soft">
      <Globe2 className="h-4 w-4" />
    </span>
  );
}


function AuthKindBadge({ kind }: { kind: ProxyProviderDescriptor["auth_kind"] }) {
  const { t } = useTranslation();
  const label = t(`myApps.edit.proxySources.authKind.${kind}`);
  if (kind === "oauth2") return <Badge variant="primary">{label}</Badge>;
  if (kind === "none") return <Badge variant="outline">{label}</Badge>;
  return <Badge variant="outline">{label}</Badge>;
}


function FormStep({
  proxy,
  provider,
  sourceUrl,
  setSourceUrl,
  secrets,
  setSecrets,
  credentialId,
  oauthBusy,
  onBeginOAuth,
}: {
  proxy: ApkProxyPublicRead;
  provider: ProxyProviderDescriptor;
  sourceUrl: string;
  setSourceUrl: (v: string) => void;
  secrets: Record<string, string>;
  setSecrets: (next: Record<string, string>) => void;
  credentialId: string | null;
  oauthBusy: boolean;
  onBeginOAuth: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-ink-soft">
        {provider.description ?? t("myApps.edit.proxySources.wizard.formIntro", { name: provider.name })}
      </p>

      {/* Source URL field. ``url_hint`` becomes the placeholder; ``url_pattern``
          is rendered as a sub-label so the user knows the shape we expect. */}
      <div className="space-y-1.5">
        <Label htmlFor="psrc-url" className="text-xs font-medium uppercase tracking-wider text-ink-mute">
          {t("myApps.edit.proxySources.wizard.urlLabel")}
        </Label>
        <Input
          id="psrc-url"
          type="url"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder={provider.url_hint ?? "https://"}
          className="font-mono"
          autoFocus
        />
        {provider.url_pattern && (
          <p className="text-[11px] leading-relaxed text-ink-mute">
            {t("myApps.edit.proxySources.wizard.urlPatternHint", {
              pattern: provider.url_pattern,
            })}
          </p>
        )}
      </div>

      {/* Auth: render only what the provider's auth_kind asks for. */}
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
                htmlFor={`psrc-secret-${f.key}`}
                className="text-xs font-medium uppercase tracking-wider text-ink-mute"
              >
                {f.label}
                {f.required && <span className="ml-1 text-danger">*</span>}
              </Label>
              <Input
                id={`psrc-secret-${f.key}`}
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
          {provider.auth_oauth?.scopes_hint && provider.auth_oauth.scopes_hint.length > 0 && (
            <p className="text-[11px] leading-relaxed text-ink-mute">
              {t("myApps.edit.proxySources.wizard.scopesHint", {
                scopes: provider.auth_oauth.scopes_hint.join(", "),
              })}
            </p>
          )}
          <p className="text-[11px] leading-relaxed text-ink-mute">
            {t("myApps.edit.proxySources.wizard.oauthBody", { proxy: proxy.name })}
          </p>
        </div>
      )}

      {/* No explicit "enabled" toggle here — new sources default to true
          (matches the GitHub-source wizard); the row's "Disable" button
          covers the "stage now, scan later" case after creation. */}
    </div>
  );
}
