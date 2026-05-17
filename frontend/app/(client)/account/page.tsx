"use client";

import { useEffect, useState } from "react";

import { AuthGuard } from "@/components/auth-guard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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

  // ── API keys section ───────────────────────────────────────────────────
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
    try {
      await api.updateMe({ full_name: fullName });
      await fetchMe();
      setMsg("Profile saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    }
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
    if (!confirm("Revoke this API key? F-Droid clients using it will stop working.")) return;
    try { await api.apiKeys.revoke(id); await refreshKeys(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Revoke failed"); }
  }

  if (!user) return null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Account</h1>
        <p className="text-muted-foreground">Profile, password and API keys.</p>
      </header>

      {msg && <p className="text-sm text-emerald-600">{msg}</p>}
      {err && <p className="text-sm text-destructive">{err}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Public identification used in API responses.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveProfile} className="space-y-3">
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input value={user.email} disabled />
            </div>
            <div className="space-y-1.5">
              <Label>Username</Label>
              <Input value={user.username} disabled />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fullname">Full name</Label>
              <Input id="fullname" value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>
            <Button type="submit">Save</Button>
          </form>
        </CardContent>
      </Card>

      {user.auth_provider === "local" && (
        <Card>
          <CardHeader>
            <CardTitle>Password</CardTitle>
            <CardDescription>Change your sign-in password.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={changePassword} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="cur">Current password</Label>
                <Input id="cur" type="password" required
                  value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new">New password</Label>
                <Input id="new" type="password" minLength={8} required
                  value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              </div>
              <Button type="submit">Change password</Button>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            Use as Basic-auth password in F-Droid clients to access private
            apps. The full key is shown only once at creation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {newlyCreated && (
            <div className="rounded-md border border-primary bg-primary/5 p-3">
              <p className="mb-1 text-sm font-medium">Copy your key now — it will never be shown again:</p>
              <code className="block break-all rounded bg-muted p-2 font-mono text-xs">{newlyCreated}</code>
            </div>
          )}
          <form onSubmit={createKey} className="grid gap-3 md:grid-cols-4">
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="kname">Label</Label>
              <Input id="kname" required placeholder="e.g. My phone"
                value={keyName} onChange={(e) => setKeyName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exp">Expires (days)</Label>
              <Input id="exp" type="number" min={1} placeholder="never"
                value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)} />
            </div>
            <div className="flex items-end">
              <Button type="submit" className="w-full">Create</Button>
            </div>
            <div className="md:col-span-4 flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={canDownloadPrivate}
                  onChange={(e) => setCanDownloadPrivate(e.target.checked)} />
                can download private apps
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={canManageApps}
                  onChange={(e) => setCanManageApps(e.target.checked)} />
                can manage apps (API)
              </label>
            </div>
          </form>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Permissions</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k) => (
                <TableRow key={k.id}>
                  <TableCell className="font-medium">{k.name}</TableCell>
                  <TableCell className="font-mono text-xs">fdr_{k.prefix}_…</TableCell>
                  <TableCell className="space-x-1">
                    {k.can_download_private && <Badge variant="outline">private dl</Badge>}
                    {k.can_manage_apps && <Badge variant="outline">manage</Badge>}
                  </TableCell>
                  <TableCell>{formatDate(k.last_used_at)}</TableCell>
                  <TableCell>{formatDate(k.expires_at)}</TableCell>
                  <TableCell>
                    {k.revoked_at
                      ? <Badge variant="destructive">revoked</Badge>
                      : <Badge variant="success">active</Badge>}
                  </TableCell>
                  <TableCell className="text-right">
                    {!k.revoked_at && (
                      <Button size="sm" variant="outline" onClick={() => revokeKey(k.id)}>
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {keys.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    No API keys yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
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
