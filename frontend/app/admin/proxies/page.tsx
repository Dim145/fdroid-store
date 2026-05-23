"use client";

import {
  CheckCircle2,
  Plug,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  XCircle,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, type ApkProxyHealthStatus, type ApkProxyRead } from "@/lib/api";
import { toast } from "@/lib/toast-store";
import { cn, formatDate } from "@/lib/utils";

/* ============================================================================
 * /admin/proxies — APK source-proxy registry.
 *
 * Each row is a self-contained service the admin registered (see the
 * protocol at docs/proxy-protocol.md). The page surfaces the live
 * health chip, the count of providers the proxy declares, and a quick
 * "Refresh" action that re-runs /healthz + caches /sources. Adding a
 * proxy is a single inline form at the top — every action lands a
 * toast and re-renders.
 * ============================================================================ */
export default function AdminProxiesPage() {
  const { t } = useTranslation();
  const [proxies, setProxies] = useState<ApkProxyRead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  async function reload() {
    try {
      setProxies(await api.admin.proxies.list());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => { void reload(); }, []);

  return (
    <div className="space-y-8">
      <header>
        <div className="eyebrow">{t("admin.eyebrow")}</div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">
          {t("admin.proxies.title")}
        </h1>
        <p className="mt-2 max-w-3xl text-ink-soft">
          {t("admin.proxies.subtitle")}
        </p>
      </header>

      {/* ── Add proxy ─────────────────────────────────────────────── */}
      <section className="surface p-6">
        <header className="mb-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Plug className="h-5 w-5 text-primary" strokeWidth={2.2} />
            <h2 className="text-lg font-bold tracking-tight text-ink">
              {t("admin.proxies.addTitle")}
            </h2>
          </div>
          <Button
            variant="outlined"
            size="sm"
            onClick={() => setShowAdd((v) => !v)}
          >
            {showAdd ? t("common.close") : (
              <>
                <Plus className="h-3.5 w-3.5" /> {t("admin.proxies.addAction")}
              </>
            )}
          </Button>
        </header>
        <p className="text-sm text-ink-soft">
          {t("admin.proxies.addHint")}
        </p>
        <AnimatePresence>
          {showAdd && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden"
            >
              <AddProxyForm
                onSaved={async () => { setShowAdd(false); await reload(); }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      {/* ── Registry ──────────────────────────────────────────────── */}
      <section>
        <header className="mb-4 flex items-end justify-between gap-3 border-b border-outline-soft pb-3">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-mute">
              {t("admin.proxies.listEyebrow")}
            </div>
            <h2 className="mt-0.5 text-2xl font-bold tracking-tight text-ink">
              {t("admin.proxies.listTitle")}
            </h2>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void reload()}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t("common.refresh")}
          </Button>
        </header>

        {error && (
          <div className="rounded-2xl border border-danger bg-danger-container px-4 py-3 text-sm text-danger-on-container">
            {error}
          </div>
        )}
        {!error && proxies === null && (
          <p className="italic text-ink-mute">{t("common.loading")}</p>
        )}
        {!error && proxies !== null && proxies.length === 0 && (
          <div className="rounded-3xl border border-dashed border-outline px-6 py-10 text-center text-ink-soft">
            <Plug className="mx-auto mb-3 h-8 w-8 text-ink-mute" strokeWidth={1.6} />
            <p>{t("admin.proxies.empty")}</p>
          </div>
        )}
        <div className="space-y-3">
          {proxies?.map((p, i) => (
            <motion.div
              key={p.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 + i * 0.04, duration: 0.3 }}
            >
              <ProxyRow proxy={p} onChange={reload} />
            </motion.div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Add form                                                           */
/* ------------------------------------------------------------------ */

function AddProxyForm({ onSaved }: { onSaved: () => void | Promise<void> }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !baseUrl.trim()) return;
    setBusy(true);
    try {
      await api.admin.proxies.create({
        name: name.trim(),
        base_url: baseUrl.trim(),
        auth_token: token.trim() || null,
      });
      toast.success(t("admin.proxies.addedOk"));
      setName("");
      setBaseUrl("");
      setToken("");
      await onSaved();
    } catch (e) {
      toast.error(
        t("admin.proxies.addFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-[1fr_2fr] sm:gap-x-4 sm:gap-y-3">
      <div>
        <Label htmlFor="proxy-name" className="text-xs text-ink-soft">
          {t("admin.proxies.fields.name")}
        </Label>
        <Input
          id="proxy-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("admin.proxies.fields.namePlaceholder")}
          required
          maxLength={128}
          className="mt-1"
        />
      </div>
      <div>
        <Label htmlFor="proxy-url" className="text-xs text-ink-soft">
          {t("admin.proxies.fields.baseUrl")}
        </Label>
        <Input
          id="proxy-url"
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://proxy-fdroid:8000"
          required
          className="mt-1 font-mono text-xs"
        />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor="proxy-token" className="text-xs text-ink-soft">
          {t("admin.proxies.fields.authToken")}
        </Label>
        <Input
          id="proxy-token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={t("admin.proxies.fields.authTokenPlaceholder")}
          className="mt-1 font-mono text-xs"
        />
        <p className="mt-1 text-[11px] text-ink-mute">
          {t("admin.proxies.fields.authTokenHint")}
        </p>
      </div>
      <div className="sm:col-span-2 flex justify-end">
        <Button type="submit" variant="filled" size="md" disabled={busy}>
          {busy ? t("common.saving") : t("admin.proxies.fields.submit")}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  Row                                                                */
/* ------------------------------------------------------------------ */

function ProxyRow({
  proxy,
  onChange,
}: {
  proxy: ApkProxyRead;
  onChange: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<"refresh" | "delete" | "toggle" | null>(null);
  const providers = proxy.cached_sources_json?.providers ?? [];

  async function refresh() {
    setBusy("refresh");
    try {
      await api.admin.proxies.refresh(proxy.id);
      toast.success(t("admin.proxies.refreshedOk"));
      await onChange();
    } catch (e) {
      toast.error(
        t("admin.proxies.refreshFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setBusy(null);
    }
  }

  async function toggleEnabled(value: boolean) {
    setBusy("toggle");
    try {
      await api.admin.proxies.update(proxy.id, { enabled: value });
      await onChange();
    } catch (e) {
      toast.error(
        t("admin.proxies.saveFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm(t("admin.proxies.confirmDelete", { name: proxy.name }))) {
      return;
    }
    setBusy("delete");
    try {
      await api.admin.proxies.remove(proxy.id);
      toast.success(t("admin.proxies.deletedOk"));
      await onChange();
    } catch (e) {
      toast.error(
        t("admin.proxies.deleteFailed"),
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-lg font-bold tracking-tight text-ink">
              {proxy.name}
            </h3>
            <HealthChip status={proxy.last_health_status} />
            {!proxy.enabled && (
              <Badge variant="soft">{t("admin.proxies.disabled")}</Badge>
            )}
          </div>
          <code className="mt-1 inline-block max-w-full truncate font-mono text-xs text-ink-mute">
            {proxy.base_url}
          </code>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-ink-mute">
            {proxy.has_auth_token ? (
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-primary" />
                {t("admin.proxies.authConfigured")}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <ShieldAlert className="h-3 w-3 text-accent" />
                {t("admin.proxies.authMissing")}
              </span>
            )}
            {proxy.last_health_at && (
              <span>
                {t("admin.proxies.lastCheck", { date: formatDate(proxy.last_health_at) })}
              </span>
            )}
          </div>
          {proxy.last_health_error && (
            <p className="mt-2 rounded-xl border border-danger/40 bg-danger-container/40 px-3 py-1.5 text-xs text-danger-on-container">
              {proxy.last_health_error}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-ink-soft">
            <Switch
              checked={proxy.enabled}
              onCheckedChange={(v) => void toggleEnabled(v)}
              disabled={busy !== null}
            />
            {t("admin.proxies.enabled")}
          </label>
          <Button
            variant="outlined"
            size="sm"
            onClick={refresh}
            disabled={busy !== null}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", busy === "refresh" && "animate-spin")}
            />
            {t("admin.proxies.refreshAction")}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={remove}
            disabled={busy !== null}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("common.delete")}
          </Button>
        </div>
      </div>

      {/* Provider catalogue */}
      <div className="mt-4 border-t border-outline-soft pt-3">
        <div className="mb-2 flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-mute">
          <span>
            {t("admin.proxies.providers", { count: providers.length })}
          </span>
          {proxy.cached_sources_at && (
            <span className="font-normal normal-case tracking-normal text-ink-mute">
              {t("admin.proxies.cachedAt", { date: formatDate(proxy.cached_sources_at) })}
            </span>
          )}
        </div>
        {providers.length === 0 ? (
          <p className="text-xs italic text-ink-mute">
            {t("admin.proxies.noProviders")}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {providers.map((p) => (
              <span
                key={p.id}
                className="inline-flex items-center gap-1.5 rounded-pill border border-outline-soft bg-surface-2 px-2.5 py-1 text-xs text-ink"
                title={p.description ?? undefined}
              >
                {p.icon_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.icon_url}
                    alt=""
                    width={14}
                    height={14}
                    className="rounded-sm"
                  />
                )}
                <span className="font-medium">{p.name}</span>
                <span className="font-mono text-[10px] text-ink-mute">·</span>
                <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                  {p.auth_kind}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Health chip                                                        */
/* ------------------------------------------------------------------ */

function HealthChip({ status }: { status: ApkProxyHealthStatus }) {
  const { t } = useTranslation();
  const tone: Record<ApkProxyHealthStatus, { variant: "primary" | "soft" | "accent" | "outline"; icon: typeof CheckCircle2 }> = {
    healthy: { variant: "primary", icon: CheckCircle2 },
    unknown: { variant: "soft", icon: RefreshCw },
    unreachable: { variant: "accent", icon: XCircle },
    bad_response: { variant: "accent", icon: ShieldAlert },
    auth_failed: { variant: "accent", icon: ShieldAlert },
  };
  const { variant, icon: Icon } = tone[status];
  return (
    <Badge variant={variant}>
      <Icon className="h-3 w-3" />
      {t(`admin.proxies.health.${status}`)}
    </Badge>
  );
}
