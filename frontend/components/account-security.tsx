"use client";

import { Activity, Globe, KeyRound, Monitor, RotateCw, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type QuotaUsage, type TotpStatus, type UserSession } from "@/lib/api";
import { toast } from "@/lib/toast-store";
import { formatBytes, formatDate } from "@/lib/utils";


/* -------------------------------------------------------------------------- */
/*  Active sessions                                                            */
/* -------------------------------------------------------------------------- */

export function SessionsSection() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<UserSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    try {
      setRows(await api.sessions.list());
    } catch (e) {
      toast.error(t("account.sessions.loadFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function revoke(id: string) {
    if (!confirm(t("account.sessions.revokeConfirm"))) return;
    setBusy(id);
    try {
      await api.sessions.revoke(id);
      toast.success(t("account.sessions.revoked"));
      await reload();
    } catch (e) {
      toast.error(t("account.sessions.revokeFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  async function revokeAll() {
    if (!confirm(t("account.sessions.revokeAllConfirm"))) return;
    setBusy("all");
    try {
      await api.sessions.revokeAll();
      toast.success(t("account.sessions.revokedAll"));
      // Browser is now logged out at the next refresh; force a reload so
      // the auth store catches up via /me failure.
      window.location.href = "/login";
    } catch (e) {
      toast.error(t("account.sessions.revokeFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  const active = rows.filter((r) => !r.revoked_at);
  const revoked = rows.filter((r) => r.revoked_at);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-ink-soft">{t("account.sessions.body")}</p>
        <Button variant="outlined" size="sm" onClick={revokeAll} disabled={busy === "all" || active.length === 0}>
          <ShieldOff className="h-3.5 w-3.5" /> {t("account.sessions.revokeAll")}
        </Button>
      </div>
      {loading ? (
        <p className="text-sm italic text-ink-mute">{t("common.loading")}</p>
      ) : active.length === 0 ? (
        <p className="text-sm italic text-ink-mute">{t("account.sessions.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {active.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-3 rounded-2xl border border-outline-soft bg-surface px-4 py-3"
            >
              <Monitor className="h-4 w-4 text-ink-mute" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-ink">
                  {s.user_agent || t("account.sessions.unknownClient")}
                </div>
                <div className="font-mono text-[11px] text-ink-mute">
                  {t("account.sessions.lastSeen", { when: formatDate(s.last_seen_at) })}
                  {s.ip_hash && <> · {s.ip_hash.slice(0, 12)}…</>}
                </div>
              </div>
              <Button variant="outlined" size="sm" onClick={() => revoke(s.id)} disabled={busy === s.id}>
                <Trash2 className="h-3.5 w-3.5" /> {t("account.sessions.revoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {revoked.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs uppercase tracking-wider text-ink-mute hover:text-ink-soft">
            {t("account.sessions.showRevoked", { count: revoked.length })}
          </summary>
          <ul className="mt-2 space-y-1">
            {revoked.map((s) => (
              <li key={s.id} className="rounded-xl bg-surface-2/50 px-3 py-2 text-xs text-ink-mute">
                <span className="font-mono">{s.user_agent || "?"}</span> ·{" "}
                {t("account.sessions.endedAt", { when: formatDate(s.revoked_at!) })}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Quotas                                                                     */
/* -------------------------------------------------------------------------- */

function QuotaBar({ label, used, cap, formatter }: {
  label: string;
  used: number;
  cap: number | null;
  formatter?: (n: number) => string;
}) {
  const fmt = formatter ?? ((n: number) => String(n));
  const pct = cap == null ? 0 : Math.min(100, Math.round((used / Math.max(cap, 1)) * 100));
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-ink-soft">{label}</span>
        <span className="font-mono text-ink-mute">
          {fmt(used)} {cap == null ? "/ ∞" : `/ ${fmt(cap)}`}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        {cap != null && (
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${pct}%` }}
            aria-hidden
          />
        )}
      </div>
    </div>
  );
}

export function QuotaUsageSection() {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<QuotaUsage | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.quotas.usage()
      .then((u) => { if (!cancelled) setUsage(u); })
      .catch(() => { /* non-fatal */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <p className="text-sm italic text-ink-mute">{t("common.loading")}</p>;
  if (!usage) return <p className="text-sm italic text-ink-mute">{t("account.quotas.loadFailed")}</p>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-soft">{t("account.quotas.body")}</p>
      <QuotaBar
        label={t("account.quotas.apps")}
        used={usage.apps.used}
        cap={usage.apps.cap}
      />
      <QuotaBar
        label={t("account.quotas.storage")}
        used={usage.storage_bytes.used}
        cap={usage.storage_bytes.cap}
        formatter={formatBytes}
      />
      <QuotaBar
        label={t("account.quotas.monthly")}
        used={usage.apks_this_month.used}
        cap={usage.apks_this_month.cap}
      />
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  TOTP enrolment                                                             */
/* -------------------------------------------------------------------------- */

export function TotpSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // Enrolment-in-progress UI state. The user clicks "Enable" → we POST
  // /setup, receive the QR + secret, then ask for the 6-digit code.
  const [setup, setSetup] = useState<{ qr_data_uri: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  // After /confirm we show the recovery codes ONCE.
  const [recovery, setRecovery] = useState<string[] | null>(null);

  // Disable flow needs the password.
  const [password, setPassword] = useState("");
  const [showDisable, setShowDisable] = useState(false);

  async function reload() {
    setLoading(true);
    try {
      setStatus(await api.totp.status());
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function startSetup() {
    setBusy(true);
    try {
      const s = await api.totp.setup();
      setSetup({ qr_data_uri: s.qr_data_uri, secret: s.secret });
    } catch (e) {
      toast.error(t("account.totp.setupFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup() {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const { recovery_codes } = await api.totp.confirm(code.trim());
      setRecovery(recovery_codes);
      setSetup(null);
      setCode("");
      await reload();
      toast.success(t("account.totp.enrolled"));
    } catch (e) {
      toast.error(t("account.totp.invalidCode"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!password) return;
    setBusy(true);
    try {
      await api.totp.disable(password);
      setShowDisable(false);
      setPassword("");
      toast.success(t("account.totp.disabled"));
      await reload();
    } catch (e) {
      toast.error(t("account.totp.disableFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="text-sm italic text-ink-mute">{t("common.loading")}</p>;

  // Recovery-codes celebration — once-only view, copy now or never.
  if (recovery) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-ink">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h3 className="text-base font-semibold">{t("account.totp.recoveryHeader")}</h3>
        </div>
        <p className="text-sm text-ink-soft">{t("account.totp.recoveryBody")}</p>
        <ul className="grid gap-2 rounded-2xl bg-surface-2 p-4 font-mono text-sm md:grid-cols-2">
          {recovery.map((c) => (
            <li key={c} className="select-all">{c}</li>
          ))}
        </ul>
        <Button variant="outlined" size="sm" onClick={() => setRecovery(null)}>
          {t("account.totp.recoveryAck")}
        </Button>
      </div>
    );
  }

  if (setup) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-ink-soft">{t("account.totp.setupBody")}</p>
        <div className="flex flex-wrap items-start gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={setup.qr_data_uri}
            alt="TOTP QR"
            className="h-44 w-44 rounded-2xl border border-outline-soft bg-white p-2 shadow-e1"
          />
          <div className="flex-1 space-y-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-ink-mute">
                {t("account.totp.secretLabel")}
              </div>
              <code className="mt-1 block select-all break-all rounded-xl bg-surface-2 px-3 py-2 font-mono text-xs">
                {setup.secret}
              </code>
            </div>
            <Label htmlFor="totp-code" className="text-xs font-medium text-ink-soft">
              {t("account.totp.codeLabel")}
            </Label>
            <Input
              id="totp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              className="max-w-[160px] font-mono tracking-widest"
            />
            <div className="flex gap-2">
              <Button variant="filled" onClick={confirmSetup} disabled={busy || !code.trim()}>
                {busy ? t("common.saving") : t("account.totp.confirm")}
              </Button>
              <Button variant="ghost" onClick={() => { setSetup(null); setCode(""); }}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (status?.enrolled) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Badge variant="primary">
            <ShieldCheck className="h-3 w-3" /> {t("account.totp.enabledBadge")}
          </Badge>
          {status.last_used_at && (
            <span className="text-xs text-ink-mute">
              {t("account.totp.lastUsed", { when: formatDate(status.last_used_at) })}
            </span>
          )}
        </div>
        <p className="text-sm text-ink-soft">{t("account.totp.enabledBody")}</p>
        {!showDisable ? (
          <Button variant="outlined" onClick={() => setShowDisable(true)}>
            {t("account.totp.disable")}
          </Button>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="totp-disable-pw" className="text-xs font-medium text-ink-soft">
              {t("account.totp.disablePasswordLabel")}
            </Label>
            <Input
              id="totp-disable-pw"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="max-w-md"
            />
            <div className="flex gap-2">
              <Button variant="danger" onClick={disable} disabled={busy || !password}>
                {busy ? t("common.saving") : t("account.totp.disableConfirm")}
              </Button>
              <Button variant="ghost" onClick={() => { setShowDisable(false); setPassword(""); }}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Not enrolled (and not in mid-enrolment)
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-soft">{t("account.totp.notEnrolledBody")}</p>
      <Button variant="filled" onClick={startSetup} disabled={busy}>
        <KeyRound className="h-4 w-4" /> {busy ? t("common.loading") : t("account.totp.enable")}
      </Button>
    </div>
  );
}
