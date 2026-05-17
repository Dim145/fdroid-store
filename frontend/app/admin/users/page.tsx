"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type CurrentUser } from "@/lib/api";

export default function AdminUsersPage() {
  const [users, setUsers] = useState<CurrentUser[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  // create form
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");

  async function refresh() {
    try {
      setUsers(await api.admin.listUsers(q || undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
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

  async function toggleActive(u: CurrentUser) {
    await api.admin.updateUser(u.id, { is_active: !u.is_active });
    await refresh();
  }

  async function toggleRole(u: CurrentUser) {
    await api.admin.updateUser(u.id, { role: u.role === "admin" ? "user" : "admin" });
    await refresh();
  }

  async function remove(u: CurrentUser) {
    if (!confirm(`Delete user ${u.username}? This is irreversible.`)) return;
    await api.admin.deleteUser(u.id);
    await refresh();
  }

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Users</h1>
          <p className="text-muted-foreground">Manage who can sign in and what they can do.</p>
        </div>
        <Input
          placeholder="Search…"
          className="max-w-xs"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </header>

      {error && <p className="text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Create user</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={createUser} className="grid gap-3 md:grid-cols-5">
            <div className="space-y-1.5">
              <Label htmlFor="ce">Email</Label>
              <Input id="ce" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cu">Username</Label>
              <Input id="cu" required value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cp">Password</Label>
              <Input id="cp" type="password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cr">Role</Label>
              <select
                id="cr"
                value={role}
                onChange={(e) => setRole(e.target.value as "user" | "admin")}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="flex items-end">
              <Button type="submit" className="w-full">Create</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All users</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Username</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Last login</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>{u.email}</TableCell>
                  <TableCell className="font-mono text-xs">{u.username}</TableCell>
                  <TableCell><Badge variant={u.role === "admin" ? "default" : "outline"}>{u.role}</Badge></TableCell>
                  <TableCell><Badge variant="outline">{u.auth_provider}</Badge></TableCell>
                  <TableCell className="text-xs">{u.last_login_at ?? "—"}</TableCell>
                  <TableCell className="space-x-2 text-right">
                    <Button size="sm" variant="outline" onClick={() => toggleActive(u)}>
                      {u.is_active ? "Disable" : "Enable"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => toggleRole(u)}>
                      Make {u.role === "admin" ? "user" : "admin"}
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => remove(u)}>
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
