"use client";

import { Key, Trash2, User as UserIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { AuthGuard } from "@/components/auth-guard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type ApiKey } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { formatDate } from "@/lib/utils";

function AccountInner() {
  const { user, fetchMe } = useAuth();
  const [fullName, setFullName] = useState(user?.full_name || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [keyName, setKeyName] = useState("");
  const [canDownloadPrivate, setCanDownloadPrivate] = useState(true);
  const [canManageApps, setCanManageApps] = useState(false);
  const [expiresIn, setExpiresIn] = useState("");
  const [newlyCreated, setNewlyCreated] = useState<string | null>(null);

  useEffect(() => setFullName(user?.full_name || ""), [user]);

  async function refreshKeys() {
    try { setKeys(await api.apiKeys.list()); }
    catch (e) { setErr(e instanceof Error ? e.message : "Could not load keys"); }
  }
  useEffect(() => { refreshKeys(); }, []);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null); setErr(null);
    try { await api.updateMe({ full_name: fullName }); await fetchMe(); setMsg("Profile saved."); }
    catch (e) { setErr(e instanceof Error ? e.message : "Save failed"); }
  }
  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null); setErr(null);
    try {
      await api.changePassword({ current_password: currentPassword, new_password: newPassword });
      setCurrentPassword(""); setNewPassword("");
      setMsg("Password changed.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Change failed");
    }
  }
  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null); setErr(null); setNewlyCreated(null);
    try {
      const k = await api.apiKeys.create({
        name: keyName,
        can_download_private: canDownloadPrivate,
        can_manage_apps: canManageApps,
        expires_in_days: expiresIn ? Number(expiresIn) : undefined,
      });
      setNewlyCreated(k.full_key);
      setKeyName("");
      await refreshKeys();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    }
  }
  async function revokeKey(id: string) {
    if (!confirm("Revoke this API key?")) return;
    try { await api.apiKeys.revoke(id); await refreshKeys(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Revoke failed"); }
  }

  if (!user) return null;

  return (
    <div className="space-y-6">
      <header className="surface flex items-center gap-4 p-6">
        <div className="flex h-16 w-16 items-center justify-center rounded-pill bg-primary-container text-primary-on-container">
          <UserIcon className="h-7 w-7" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-ink md:text-4xl">
            {user.full_name || user.username}
          </h1>
          <p className="font-mono text-xs text-ink-mute">{user.email}</p>
        </div>
        <div className="ml-auto">
          <Badge variant={user.role === "admin" ? "primary" : "outline"}>{user.role}</Badge>
        </div>
      </header>

      {msg && <p className="rounded-xl border border-primary bg-primary-container px-3 py-2 text-sm text-primary-on-container">{msg}</p>}
      {err && <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{err}</p>}

      {/* Profile */}
      <Section step="01" title="Profile">
        <form onSubmit={saveProfile} className="grid gap-4 md:grid-cols-2">
          <Field label="Email" htmlFor="em"><Input id="em" value={user.email} disabled /></Field>
          <Field label="Username" htmlFor="un"><Input id="un" value={user.username} disabled /></Field>
          <Field label="Full name" htmlFor="fn" className="md:col-span-2">
            <Input id="fn" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </Field>
          <div className="md:col-span-2"><Button type="submit" variant="filled">Save profile</Button></div>
        </form>
      </Section>

      {/* Password */}
      {user.auth_provider === "local" && (
        <Section step="02" title="Password">
          <form onSubmit={changePassword} className="grid gap-4 md:grid-cols-2">
            <Field label="Current password" htmlFor="cur">
              <Input id="cur" type="password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
            </Field>
            <Field label="New password" htmlFor="new">
              <Input id="new" type="password" minLength={8} required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </Field>
            <div className="md:col-span-2"><Button type="submit" variant="filled">Change password</Button></div>
          </form>
        </Section>
      )}

      {/* API keys */}
      <Section
        step="03"
        title="API keys"
        subtitle="Use them as the Basic-auth password in your F-Droid client to access private apps."
      >
        {newlyCreated && (
          <div className="mb-4 rounded-2xl border border-primary bg-primary-container p-4">
            <div className="text-xs font-semibold uppercase tracking-wider text-primary-on-container/80">
              Copy now — shown once
            </div>
            <code className="mt-2 block break-all rounded-xl border border-outline-soft bg-surface p-3 font-mono text-xs">
              {newlyCreated}
            </code>
          </div>
        )}
        <form onSubmit={createKey} className="grid gap-3 md:grid-cols-[2fr_1fr_auto]">
          <Field label="Label" htmlFor="kn">
            <Input id="kn" required placeholder="e.g. My phone" value={keyName} onChange={(e) => setKeyName(e.target.value)} />
          </Field>
          <Field label="Expires (days)" htmlFor="exp">
            <Input id="exp" type="number" min={1} placeholder="never" value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="filled" className="w-full">
              <Key className="h-4 w-4" /> Create key
            </Button>
          </div>
          <div className="md:col-span-3 flex flex-wrap items-center gap-4 text-sm text-ink-soft">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={canDownloadPrivate} onChange={(e) => setCanDownloadPrivate(e.target.checked)} />
              Can download private apps
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={canManageApps} onChange={(e) => setCanManageApps(e.target.checked)} />
              Can manage apps (API)
            </label>
          </div>
        </form>

        <ul className="mt-6 space-y-2">
          {keys.length === 0 && <li className="rounded-xl border border-dashed border-outline px-4 py-8 text-center italic text-ink-mute">No API keys yet.</li>}
          {keys.map((k) => (
            <li key={k.id} className="surface flex flex-wrap items-center gap-3 p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-pill bg-surface-2">
                <Key className="h-4 w-4 text-ink-soft" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-ink">{k.name}</div>
                <div className="font-mono text-[11px] text-ink-mute">fdr_{k.prefix}_…</div>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {k.can_download_private && <Badge variant="outline">private dl</Badge>}
                {k.can_manage_apps && <Badge variant="outline">manage</Badge>}
                {k.revoked_at
                  ? <Badge variant="destructive">revoked</Badge>
                  : <Badge variant="primary">active</Badge>}
              </div>
              <div className="hidden text-right text-xs text-ink-mute md:block">
                <div>used <span className="font-mono">{formatDate(k.last_used_at)}</span></div>
                <div>expires <span className="font-mono">{formatDate(k.expires_at)}</span></div>
              </div>
              {!k.revoked_at && (
                <Button size="sm" variant="outlined" onClick={() => revokeKey(k.id)}>
                  <Trash2 className="h-3.5 w-3.5" /> Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function Section({
  step,
  title,
  subtitle,
  children,
}: {
  step: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="surface p-6">
      <header className="mb-5 flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-pill bg-primary-container font-mono text-sm font-bold text-primary-on-container">
          {step}
        </span>
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink">{title}</h2>
          {subtitle && <p className="text-sm text-ink-mute">{subtitle}</p>}
        </div>
      </header>
      {children}
    </section>
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

export default function AccountPage() {
  return (
    <AuthGuard>
      <AccountInner />
    </AuthGuard>
  );
}
