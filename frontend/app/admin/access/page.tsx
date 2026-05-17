"use client";

import { Check, Copy, Globe, KeyRound, Lock, Plus, ShieldCheck, Trash2, UsersRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type InviteCode, type RegistrationPolicy, type RepoConfigInfo } from "@/lib/api";
import { useRepoStore } from "@/lib/repo-store";
import { cn, formatDate } from "@/lib/utils";

/* ============================================================================
 * Access & registration admin page.
 *
 * Two settings drive every door into the repo:
 *   1. public_mode — anonymous browse + F-Droid sync on/off
 *   2. registration_policy — who can create an account
 *
 * Plus a small CRUD on invite codes when the policy is "invite".
 * Settings persist on RepoConfig; toggling them never requires a re-index
 * (the backend skips reindex for these patches).
 * ============================================================================ */
export default function AdminAccessPage() {
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
      setErr(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => { refreshAll(); }, []);

  // Optimistic, single-field patches — admins toggle radios + switches
  // quickly and we don't want every click to feel like a save.
  async function patchRepo(patch: Partial<Pick<RepoConfigInfo, "public_mode" | "registration_policy">>) {
    if (!repo) return;
    setErr(null); setMsg(null);
    const next = { ...repo, ...patch };
    setRepo(next);
    try {
      const updated = await api.admin.updateRepo(patch);
      setRepo(updated);
      // Auth-methods + login UI consume this too, so propagate.
      await refreshGlobalRepo();
      setMsg("Saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
      // Roll back the optimistic value so the UI stays truthful.
      setRepo(repo);
    }
  }

  if (!repo) {
    return <p className="text-sm text-ink-mute">Loading…</p>;
  }

  return (
    <div className="space-y-6">
      <header>
        <div className="eyebrow">Admin · access</div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">
          Access &amp; registration
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-soft">
          Choose who can browse the catalogue, sync the F-Droid index, and create
          new accounts. Changes apply instantly.
        </p>
      </header>

      {msg && <Toast tone="ok">{msg}</Toast>}
      {err && <Toast tone="err">{err}</Toast>}

      {/* ── Public mode ── */}
      <section className="surface p-6">
        <h2 className="mb-1 flex items-center gap-2 text-lg font-bold tracking-tight text-ink">
          <Globe className="h-5 w-5" /> Public mode
        </h2>
        <p className="mb-5 text-sm text-ink-soft">
          When public, anyone can browse public apps on the website and any
          F-Droid client can sync the public repo without credentials. Private
          apps are still gated by API keys, regardless of this setting.
        </p>
        <RadioCardGroup<boolean>
          value={repo.public_mode}
          onChange={(v) => patchRepo({ public_mode: v })}
          options={[
            {
              value: true,
              icon: <Globe className="h-5 w-5" />,
              title: "Public",
              subtitle: "Open browsing + public F-Droid sync",
            },
            {
              value: false,
              icon: <Lock className="h-5 w-5" />,
              title: "Private",
              subtitle: "Login or API key required everywhere",
            },
          ]}
        />
      </section>

      {/* ── Registration ── */}
      <section className="surface p-6">
        <h2 className="mb-1 flex items-center gap-2 text-lg font-bold tracking-tight text-ink">
          <UsersRound className="h-5 w-5" /> Registration
        </h2>
        <p className="mb-5 text-sm text-ink-soft">
          Controls who can create an account. OIDC follows the same rule —
          existing users always log in, but a new SSO account needs the same
          permission as a local signup.
        </p>
        <RadioCardGroup<RegistrationPolicy>
          value={repo.registration_policy}
          onChange={(v) => patchRepo({ registration_policy: v })}
          options={[
            {
              value: "public",
              icon: <Globe className="h-5 w-5" />,
              title: "Open",
              subtitle: "Anyone can sign up",
            },
            {
              value: "invite",
              icon: <KeyRound className="h-5 w-5" />,
              title: "By invitation",
              subtitle: "Invite code required",
            },
            {
              value: "closed",
              icon: <Lock className="h-5 w-5" />,
              title: "Closed",
              subtitle: "Admins create accounts manually",
            },
          ]}
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
            <ShieldCheck className="h-5 w-5" /> Invite codes
          </h2>
          {repo.registration_policy !== "invite" && (
            <Badge variant="outline">inactive · policy not set to “invite”</Badge>
          )}
        </div>
        <p className="mb-5 text-sm text-ink-soft">
          Single-use codes. Share each one with the person you're inviting; it
          burns out after their first successful signup.
        </p>
        <InviteCreator onCreated={refreshAll} setErr={setErr} setMsg={setMsg} />
        <InviteList invites={invites} onChange={refreshAll} setErr={setErr} setMsg={setMsg} />
      </section>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────────── */

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
      setErr(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-6 rounded-2xl border border-outline-soft bg-surface p-4">
      <form onSubmit={onSubmit} className="grid gap-3 md:grid-cols-[2fr_1fr_auto]">
        <div className="space-y-1.5">
          <Label htmlFor="inv-note" className="text-xs font-medium text-ink-soft">Note (optional)</Label>
          <Input
            id="inv-note"
            placeholder="e.g. for Alice"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="inv-exp" className="text-xs font-medium text-ink-soft">Expires (days)</Label>
          <Input
            id="inv-exp"
            type="number"
            min={1}
            max={365}
            placeholder="never"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          />
        </div>
        <div className="flex items-end">
          <Button type="submit" variant="filled" className="w-full" disabled={busy}>
            <Plus className="h-4 w-4" /> Generate
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
            New invite code — copy it now
          </div>
          <code className="mt-1 block select-all break-all font-mono text-sm text-primary-on-container">
            {invite.code}
          </code>
        </div>
        <Button variant="tonal" size="icon-sm" onClick={copy} aria-label="Copy code">
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>Done</Button>
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
  const [revoking, setRevoking] = useState<string | null>(null);
  const sorted = useMemo(() => invites, [invites]);

  async function revoke(id: string) {
    if (!confirm("Revoke this invite code?")) return;
    setRevoking(id); setErr(null);
    try {
      await api.admin.invites.revoke(id);
      setMsg("Invite revoked.");
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Revoke failed");
    } finally {
      setRevoking(null);
    }
  }

  if (sorted.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-outline px-4 py-8 text-center italic text-ink-mute">
        No invite codes yet.
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {sorted.map((inv) => {
        const status = inviteStatus(inv);
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
                created {formatDate(inv.created_at)}
                {inv.created_by_username && ` by ${inv.created_by_username}`}
                {inv.expires_at && ` · expires ${formatDate(inv.expires_at)}`}
                {inv.used_by_username && ` · used by ${inv.used_by_username}`}
              </div>
            </div>
            <Badge variant={status.tone}>{status.label}</Badge>
            <Button
              size="sm"
              variant="outlined"
              onClick={() => revoke(inv.id)}
              disabled={revoking === inv.id}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function inviteStatus(inv: InviteCode): {
  label: string;
  tone: "primary" | "outline" | "destructive" | "soft";
} {
  if (inv.used_at) return { label: "used", tone: "outline" };
  if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now()) {
    return { label: "expired", tone: "destructive" };
  }
  return { label: "pending", tone: "primary" };
}
