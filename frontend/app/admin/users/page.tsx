"use client";

import { Gauge } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type AdminUpdateUser, type CurrentUser } from "@/lib/api";
import { toast } from "@/lib/toast-store";

export default function AdminUsersPage() {
  const { t } = useTranslation();
  const [users, setUsers] = useState<CurrentUser[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  // Inline quota editor — only one row open at a time so we don't flood
  // the table with input rows.
  const [editingQuotas, setEditingQuotas] = useState<string | null>(null);

  async function refresh() {
    try { setUsers(await api.admin.listUsers(q || undefined)); }
    catch (e) { setError(e instanceof Error ? e.message : t("admin.users.loadFailed")); }
  }
  useEffect(() => {
    const timer = setTimeout(refresh, 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.admin.createUser({ email, username, password, role });
      setEmail(""); setUsername(""); setPassword("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("admin.users.createFailed"));
    }
  }
  async function toggleActive(u: CurrentUser) { await api.admin.updateUser(u.id, { is_active: !u.is_active }); await refresh(); }
  async function toggleRole(u: CurrentUser) { await api.admin.updateUser(u.id, { role: u.role === "admin" ? "user" : "admin" }); await refresh(); }
  async function remove(u: CurrentUser) {
    if (!confirm(t("admin.users.deleteConfirm", { name: u.username }))) return;
    await api.admin.deleteUser(u.id);
    await refresh();
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow">{t("admin.eyebrow")}</div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">{t("admin.users.title")}</h1>
          <p className="mt-1 text-ink-soft">{t("admin.users.subtitle")}</p>
        </div>
        <Input placeholder={t("admin.users.search")} className="max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} />
      </header>

      {error && <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{error}</p>}

      <section className="surface p-6">
        <h2 className="mb-4 text-lg font-bold tracking-tight text-ink">{t("admin.users.addTitle")}</h2>
        <form onSubmit={createUser} className="grid gap-3 md:grid-cols-5">
          <Field label={t("admin.users.fields.email")} htmlFor="ce"><Input id="ce" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label={t("admin.users.fields.username")} htmlFor="cu"><Input id="cu" required value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
          <Field label={t("admin.users.fields.password")} htmlFor="cp"><Input id="cp" type="password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Field label={t("admin.users.fields.role")} htmlFor="cr">
            <select
              id="cr"
              value={role}
              onChange={(e) => setRole(e.target.value as "user" | "admin")}
              className="h-12 w-full rounded-xl border border-outline bg-surface px-3 text-sm focus:border-primary focus:outline-none"
            >
              <option value="user">{t("admin.users.role.user")}</option>
              <option value="admin">{t("admin.users.role.admin")}</option>
            </select>
          </Field>
          <div className="flex items-end"><Button type="submit" variant="filled" className="w-full">{t("admin.users.create")}</Button></div>
        </form>
      </section>

      <section className="surface overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("admin.users.columns2.email")}</TableHead>
              <TableHead>{t("admin.users.columns2.username")}</TableHead>
              <TableHead>{t("admin.users.columns2.role")}</TableHead>
              <TableHead>{t("admin.users.columns2.provider")}</TableHead>
              <TableHead className="hidden md:table-cell">{t("admin.users.columns2.lastLogin")}</TableHead>
              <TableHead className="text-right">{t("admin.users.columns2.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <Fragment key={u.id}>
                <TableRow>
                  <TableCell>
                    <div className="text-sm text-ink">{u.email}</div>
                    {!u.is_active && (
                      <div className="text-[10px] uppercase tracking-wider text-danger">{t("admin.users.disabled")}</div>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-[11px]">{u.username}</TableCell>
                  <TableCell><Badge variant={u.role === "admin" ? "primary" : "outline"}>{u.role}</Badge></TableCell>
                  <TableCell><Badge variant="outline">{u.auth_provider}</Badge></TableCell>
                  <TableCell className="hidden md:table-cell text-xs text-ink-mute">{u.last_login_at ?? "—"}</TableCell>
                  <TableCell className="space-x-1 text-right">
                    <Button size="sm" variant="outlined" onClick={() => toggleActive(u)}>{u.is_active ? t("admin.users.disable") : t("admin.users.enable")}</Button>
                    <Button size="sm" variant="outlined" onClick={() => toggleRole(u)}>
                      {u.role === "admin" ? t("admin.users.makeUser") : t("admin.users.makeAdmin")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outlined"
                      onClick={() => setEditingQuotas(editingQuotas === u.id ? null : u.id)}
                    >
                      <Gauge className="h-3.5 w-3.5" /> {t("admin.users.quotas")}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => remove(u)}>{t("admin.users.delete")}</Button>
                  </TableCell>
                </TableRow>
                {editingQuotas === u.id && (
                  <TableRow>
                    <TableCell colSpan={6} className="bg-surface-2/50 p-4">
                      <QuotaEditor
                        user={u}
                        onClose={() => setEditingQuotas(null)}
                        onSaved={async () => { await refresh(); setEditingQuotas(null); }}
                      />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
            {users.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center italic text-ink-mute">{t("admin.users.emptyUsers")}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-sm font-medium text-ink-soft">{label}</Label>
      {children}
    </div>
  );
}


/* Inline quota editor for one user row. ``null`` in any of the three
 * fields means "fall back to the repo default" — encoded as the empty
 * input below. The Save button only PATCHes the dimensions whose input
 * changed against the original row, so a blank field clears that
 * dimension via ``quota_reset_*`` instead of overwriting with 0. */
function QuotaEditor({
  user,
  onClose,
  onSaved,
}: {
  user: CurrentUser;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [apps, setApps] = useState<string>(user.quota_max_apps?.toString() ?? "");
  const [storageMB, setStorageMB] = useState<string>(
    user.quota_max_storage_bytes != null
      ? Math.floor(user.quota_max_storage_bytes / (1024 * 1024)).toString()
      : "",
  );
  const [monthly, setMonthly] = useState<string>(user.quota_max_apks_per_month?.toString() ?? "");
  const [busy, setBusy] = useState(false);

  function parseOrNull(s: string): number | null {
    const trimmed = s.trim();
    if (!trimmed) return null;
    const n = parseInt(trimmed, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  async function save() {
    setBusy(true);
    const payload: AdminUpdateUser = {};
    const a = parseOrNull(apps);
    if (a == null) payload.quota_reset_apps = true;
    else payload.quota_max_apps = a;

    const s = parseOrNull(storageMB);
    if (s == null) payload.quota_reset_storage_bytes = true;
    else payload.quota_max_storage_bytes = s * 1024 * 1024;

    const m = parseOrNull(monthly);
    if (m == null) payload.quota_reset_apks_per_month = true;
    else payload.quota_max_apks_per_month = m;

    try {
      await api.admin.updateUser(user.id, payload);
      toast.success(t("admin.users.quotaSaved"));
      await onSaved();
    } catch (e) {
      toast.error(t("admin.users.quotaSaveFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-soft">{t("admin.users.quotaBody")}</p>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label={t("admin.users.quotaApps")} htmlFor={`q-apps-${user.id}`}>
          <Input
            id={`q-apps-${user.id}`}
            type="number"
            min={0}
            placeholder={t("admin.users.quotaInherit")}
            value={apps}
            onChange={(e) => setApps(e.target.value)}
          />
        </Field>
        <Field label={t("admin.users.quotaStorage")} htmlFor={`q-storage-${user.id}`}>
          <Input
            id={`q-storage-${user.id}`}
            type="number"
            min={0}
            placeholder={t("admin.users.quotaInherit")}
            value={storageMB}
            onChange={(e) => setStorageMB(e.target.value)}
          />
        </Field>
        <Field label={t("admin.users.quotaMonthly")} htmlFor={`q-monthly-${user.id}`}>
          <Input
            id={`q-monthly-${user.id}`}
            type="number"
            min={0}
            placeholder={t("admin.users.quotaInherit")}
            value={monthly}
            onChange={(e) => setMonthly(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex gap-2">
        <Button variant="filled" size="sm" onClick={save} disabled={busy}>
          {busy ? t("common.saving") : t("common.save")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
      </div>
    </div>
  );
}
