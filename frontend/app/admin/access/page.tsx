"use client";

import { Check, Copy, Globe, KeyRound, Lock, Plus, ShieldCheck, Trash2, UsersRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type InviteCode, type RegistrationPolicy, type RepoConfigInfo } from "@/lib/api";
import { useRepoStore } from "@/lib/repo-store";
import { cn, formatDate } from "@/lib/utils";

export default function AdminAccessPage() {
  const { t } = useTranslation();
  const refreshGlobalRepo = useRepoStore((s) => s.refresh);

  const [repo, setRepo] = useState<RepoConfigInfo | null>(null);
  const [invites, setInvites] = useState<InviteCode[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refreshAll() {
    setErr(null);
    try {
      const [r, list] = await Promise.all([api.admin.repo(), api.admin.invites.list()]);
      setRepo(r);
      setInvites(list);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("admin.access.loadFailed"));
    }
  }
  useEffect(() => { refreshAll(); /* eslint-disable-next-line */ }, []);

  async function patchRepo(patch: Partial<Pick<RepoConfigInfo, "public_mode" | "registration_policy">>) {
    if (!repo) return;
    setErr(null); setMsg(null);
    const next = { ...repo, ...patch };
    setRepo(next);
    try {
      const updated = await api.admin.updateRepo(patch);
      setRepo(updated);
      await refreshGlobalRepo();
      setMsg(t("admin.access.saved"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("admin.access.saveFailed"));
      setRepo(repo);
    }
  }

  if (!repo) {
    return <p className="text-sm text-ink-mute">{t("admin.access.loading")}</p>;
  }

  return (
    <div className="space-y-6">
      <header>
        <div className="eyebrow">{t("admin.access.eyebrow")}</div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">
          {t("admin.access.title")}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-soft">
          {t("admin.access.subtitle")}
        </p>
      </header>

      {msg && <Toast tone="ok">{msg}</Toast>}
      {err && <Toast tone="err">{err}</Toast>}

      {/* ── Public mode ── */}
      <section className="surface p-6">
        <h2 className="mb-1 flex items-center gap-2 text-lg font-bold tracking-tight text-ink">
          <Globe className="h-5 w-5" /> {t("admin.access.publicMode")}
        </h2>
        <p className="mb-5 text-sm text-ink-soft">
          {t("admin.access.publicModeBody")}
        </p>
        <RadioCardGroup<boolean>
          value={repo.public_mode}
          onChange={(v) => patchRepo({ public_mode: v })}
          options={[
            {
              value: true,
              icon: <Globe className="h-5 w-5" />,
              title: t("admin.access.publicOption"),
              subtitle: t("admin.access.publicOptionSubtitle"),
            },
            {
              value: false,
              icon: <Lock className="h-5 w-5" />,
              title: t("admin.access.privateOption"),
              subtitle: t("admin.access.privateOptionSubtitle"),
            },
          ]}
        />
      </section>

      {/* ── Registration ── */}
      <section className="surface p-6">
        <h2 className="mb-1 flex items-center gap-2 text-lg font-bold tracking-tight text-ink">
          <UsersRound className="h-5 w-5" /> {t("admin.access.registration")}
        </h2>
        <p className="mb-5 text-sm text-ink-soft">
          {t("admin.access.registrationBody")}
        </p>
        <RadioCardGroup<RegistrationPolicy>
          value={repo.registration_policy}
          onChange={(v) => patchRepo({ registration_policy: v })}
          options={[
            {
              value: "public",
              icon: <Globe className="h-5 w-5" />,
              title: t("admin.access.policyOpen"),
              subtitle: t("admin.access.policyOpenSubtitle"),
            },
            {
              value: "invite",
              icon: <KeyRound className="h-5 w-5" />,
              title: t("admin.access.policyInvite"),
              subtitle: t("admin.access.policyInviteSubtitle"),
            },
            {
              value: "closed",
              icon: <Lock className="h-5 w-5" />,
              title: t("admin.access.policyClosed"),
              subtitle: t("admin.access.policyClosedSubtitle"),
            },
          ]}
        />
      </section>

      {/* ── Upload limits ── */}
      <section className="surface p-6">
        <h2 className="mb-1 text-lg font-bold tracking-tight text-ink">{t("admin.access.uploadLimits")}</h2>
        <p className="mb-5 text-sm text-ink-soft">
          {t("admin.access.uploadLimitsBody")}
        </p>
        <ApkSizeEditor
          repo={repo}
          onSaved={async (next) => { setRepo(next); await refreshAll(); }}
          setErr={setErr}
          setMsg={setMsg}
        />
      </section>

      {/* ── Invite codes ── */}
      <section
        className={cn(
          "surface p-6",
          repo.registration_policy !== "invite" && "opacity-70",
        )}
      >
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight text-ink">
            <ShieldCheck className="h-5 w-5" /> {t("admin.access.invites")}
          </h2>
          {repo.registration_policy !== "invite" && (
            <Badge variant="outline">{t("admin.access.invitesInactive")}</Badge>
          )}
        </div>
        <p className="mb-5 text-sm text-ink-soft">
          {t("admin.access.invitesBody")}
        </p>
        <InviteCreator onCreated={refreshAll} setErr={setErr} setMsg={setMsg} />
        <InviteList invites={invites} onChange={refreshAll} setErr={setErr} setMsg={setMsg} />
      </section>
    </div>
  );
}

function Toast({ tone, children }: { tone: "ok" | "err"; children: React.ReactNode }) {
  return (
    <p
      className={cn(
        "rounded-xl px-3 py-2 text-sm",
        tone === "ok"
          ? "border border-primary bg-primary-container text-primary-on-container"
          : "border border-danger bg-danger-container text-danger-on-container",
      )}
    >
      {children}
    </p>
  );
}

type RadioCardOption<T> = {
  value: T;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
};

function RadioCardGroup<T extends string | number | boolean>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: RadioCardOption<T>[];
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              "group flex items-start gap-3 rounded-2xl border p-4 text-left transition-colors",
              active
                ? "border-primary bg-primary-container/40 ring-1 ring-primary"
                : "border-outline-soft bg-surface hover:border-outline",
            )}
          >
            <span
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
                active ? "bg-primary text-primary-fg" : "bg-surface-2 text-ink-soft",
              )}
            >
              {opt.icon}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-ink">{opt.title}</div>
              <div className="mt-0.5 text-xs text-ink-mute">{opt.subtitle}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function InviteCreator({
  onCreated,
  setErr,
  setMsg,
}: {
  onCreated: () => void;
  setErr: (s: string | null) => void;
  setMsg: (s: string | null) => void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState("");
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);
  const [justCreated, setJustCreated] = useState<InviteCode | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setMsg(null); setBusy(true);
    try {
      const created = await api.admin.invites.create({
        note: note.trim() || undefined,
        expires_in_days: expires ? Number(expires) : undefined,
      });
      setJustCreated(created);
      setNote(""); setExpires("");
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("admin.access.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-6 rounded-2xl border border-outline-soft bg-surface p-4">
      <form onSubmit={onSubmit} className="grid gap-3 md:grid-cols-[2fr_1fr_auto]">
        <div className="space-y-1.5">
          <Label htmlFor="inv-note" className="text-xs font-medium text-ink-soft">{t("admin.access.noteLabel")}</Label>
          <Input
            id="inv-note"
            placeholder={t("admin.access.notePlaceholder")}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="inv-exp" className="text-xs font-medium text-ink-soft">{t("admin.access.expiresLabel")}</Label>
          <Input
            id="inv-exp"
            type="number"
            min={1}
            max={365}
            placeholder={t("admin.access.expiresPlaceholder")}
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          />
        </div>
        <div className="flex items-end">
          <Button type="submit" variant="filled" className="w-full" disabled={busy}>
            <Plus className="h-4 w-4" /> {t("admin.access.generate")}
          </Button>
        </div>
      </form>

      {justCreated && (
        <InviteHighlight invite={justCreated} onDismiss={() => setJustCreated(null)} />
      )}
    </div>
  );
}

function InviteHighlight({ invite, onDismiss }: { invite: InviteCode; onDismiss: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(invite.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {/* clipboard blocked */}
  }
  return (
    <div className="mt-4 rounded-xl border border-primary bg-primary-container/60 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wider text-primary-on-container/80">
            {t("admin.access.newCode")}
          </div>
          <code className="mt-1 block select-all break-all font-mono text-sm text-primary-on-container">
            {invite.code}
          </code>
        </div>
        <Button variant="tonal" size="icon-sm" onClick={copy} aria-label={t("admin.access.copyCode")}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>{t("admin.access.done")}</Button>
      </div>
    </div>
  );
}

function InviteList({
  invites,
  onChange,
  setErr,
  setMsg,
}: {
  invites: InviteCode[];
  onChange: () => void;
  setErr: (s: string | null) => void;
  setMsg: (s: string | null) => void;
}) {
  const { t } = useTranslation();
  const [revoking, setRevoking] = useState<string | null>(null);
  const sorted = useMemo(() => invites, [invites]);

  async function revoke(id: string) {
    if (!confirm(t("admin.access.revokeConfirm"))) return;
    setRevoking(id); setErr(null);
    try {
      await api.admin.invites.revoke(id);
      setMsg(t("admin.access.revoked"));
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("admin.access.revokeFailed"));
    } finally {
      setRevoking(null);
    }
  }

  if (sorted.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-outline px-4 py-8 text-center italic text-ink-mute">
        {t("admin.access.noInvites")}
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {sorted.map((inv) => {
        const status = inviteStatus(inv, t);
        return (
          <li key={inv.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-outline-soft bg-surface p-3">
            <code className="select-all rounded-pill bg-surface-2 px-3 py-1 font-mono text-xs text-ink">
              {inv.code}
            </code>
            <div className="min-w-0 flex-1">
              {inv.note && (
                <div className="truncate text-sm text-ink">{inv.note}</div>
              )}
              <div className="font-mono text-[11px] text-ink-mute">
                {t("admin.access.created", { date: formatDate(inv.created_at) })}
                {inv.created_by_username && t("admin.access.createdBy", { name: inv.created_by_username })}
                {inv.expires_at && t("admin.access.expires", { date: formatDate(inv.expires_at) })}
                {inv.used_by_username && t("admin.access.usedBy", { name: inv.used_by_username })}
              </div>
            </div>
            <Badge variant={status.tone}>{status.label}</Badge>
            <Button
              size="sm"
              variant="outlined"
              onClick={() => revoke(inv.id)}
              disabled={revoking === inv.id}
            >
              <Trash2 className="h-3.5 w-3.5" /> {t("admin.access.delete")}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function ApkSizeEditor({
  repo,
  onSaved,
  setErr,
  setMsg,
}: {
  repo: RepoConfigInfo;
  onSaved: (next: RepoConfigInfo) => Promise<void> | void;
  setErr: (s: string | null) => void;
  setMsg: (s: string | null) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(String(repo.upload_max_apk_mb));
  const [busy, setBusy] = useState(false);

  useEffect(() => { setValue(String(repo.upload_max_apk_mb)); }, [repo.upload_max_apk_mb]);

  async function save() {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 5 || parsed > 2000) {
      setErr(t("admin.access.apkSizeError"));
      return;
    }
    setErr(null); setMsg(null); setBusy(true);
    try {
      const updated = await api.admin.updateRepo({ upload_max_apk_mb: parsed });
      await onSaved(updated);
      setMsg(t("admin.access.saved"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("admin.access.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
      <div className="space-y-1.5">
        <Label htmlFor="apksize" className="text-xs font-medium text-ink-soft">
          {t("admin.access.maxApkSize")}
        </Label>
        <Input
          id="apksize"
          type="number"
          min={5}
          max={2000}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <Button type="button" variant="filled" onClick={save} disabled={busy}>
        {t("admin.access.save")}
      </Button>
    </div>
  );
}


function inviteStatus(inv: InviteCode, t: (k: string) => string): {
  label: string;
  tone: "primary" | "outline" | "destructive" | "soft";
} {
  if (inv.used_at) return { label: t("admin.access.statusUsed"), tone: "outline" };
  if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now()) {
    return { label: t("admin.access.statusExpired"), tone: "destructive" };
  }
  return { label: t("admin.access.statusPending"), tone: "primary" };
}
