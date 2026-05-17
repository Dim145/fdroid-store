"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type CurrentUser } from "@/lib/api";

export default function AdminUsersPage() {
  const [users, setUsers] = useState<CurrentUser[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");

  async function refresh() {
    try { setUsers(await api.admin.listUsers(q || undefined)); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed"); }
  }
  useEffect(() => {
    const t = setTimeout(refresh, 200);
    return () => clearTimeout(t);
  }, [q]);

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.admin.createUser({ email, username, password, role });
      setEmail(""); setUsername(""); setPassword("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    }
  }
  async function toggleActive(u: CurrentUser) { await api.admin.updateUser(u.id, { is_active: !u.is_active }); await refresh(); }
  async function toggleRole(u: CurrentUser) { await api.admin.updateUser(u.id, { role: u.role === "admin" ? "user" : "admin" }); await refresh(); }
  async function remove(u: CurrentUser) {
    if (!confirm(`Delete user ${u.username}?`)) return;
    await api.admin.deleteUser(u.id);
    await refresh();
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow">Admin</div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">Users</h1>
          <p className="mt-1 text-ink-soft">Manage who can sign in and what they can do.</p>
        </div>
        <Input placeholder="Search…" className="max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} />
      </header>

      {error && <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{error}</p>}

      <section className="surface p-6">
        <h2 className="mb-4 text-lg font-bold tracking-tight text-ink">Add a user</h2>
        <form onSubmit={createUser} className="grid gap-3 md:grid-cols-5">
          <Field label="Email" htmlFor="ce"><Input id="ce" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Username" htmlFor="cu"><Input id="cu" required value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
          <Field label="Password" htmlFor="cp"><Input id="cp" type="password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Field label="Role" htmlFor="cr">
            <select
              id="cr"
              value={role}
              onChange={(e) => setRole(e.target.value as "user" | "admin")}
              className="h-12 w-full rounded-xl border border-outline bg-surface px-3 text-sm focus:border-primary focus:outline-none"
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          <div className="flex items-end"><Button type="submit" variant="filled" className="w-full">Create</Button></div>
        </form>
      </section>

      <section className="surface overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Username</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead className="hidden md:table-cell">Last login</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell>
                  <div className="text-sm text-ink">{u.email}</div>
                  {!u.is_active && (
                    <div className="text-[10px] uppercase tracking-wider text-danger">Disabled</div>
                  )}
                </TableCell>
                <TableCell className="font-mono text-[11px]">{u.username}</TableCell>
                <TableCell><Badge variant={u.role === "admin" ? "primary" : "outline"}>{u.role}</Badge></TableCell>
                <TableCell><Badge variant="outline">{u.auth_provider}</Badge></TableCell>
                <TableCell className="hidden md:table-cell text-xs text-ink-mute">{u.last_login_at ?? "—"}</TableCell>
                <TableCell className="space-x-1 text-right">
                  <Button size="sm" variant="outlined" onClick={() => toggleActive(u)}>{u.is_active ? "Disable" : "Enable"}</Button>
                  <Button size="sm" variant="outlined" onClick={() => toggleRole(u)}>
                    Make {u.role === "admin" ? "user" : "admin"}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => remove(u)}>Delete</Button>
                </TableCell>
              </TableRow>
            ))}
            {users.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center italic text-ink-mute">No users.</TableCell>
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
