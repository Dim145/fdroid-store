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
import { formatDate } from "@/lib/utils";

function ApiKeysInner() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [error, setError] = useState<string | null>(null);

  // create-form state
  const [name, setName] = useState("");
  const [canDownloadPrivate, setCanDownloadPrivate] = useState(true);
  const [canManageApps, setCanManageApps] = useState(false);
  const [expiresIn, setExpiresIn] = useState<string>("");
  const [newlyCreated, setNewlyCreated] = useState<string | null>(null);

  async function refresh() {
    try {
      setKeys(await api.apiKeys.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => { refresh(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNewlyCreated(null);
    try {
      const k = await api.apiKeys.create({
        name,
        can_download_private: canDownloadPrivate,
        can_manage_apps: canManageApps,
        expires_in_days: expiresIn ? Number(expiresIn) : undefined,
      });
      setNewlyCreated(k.full_key);
      setName("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this API key? F-Droid clients using it will stop working.")) return;
    await api.apiKeys.revoke(id);
    await refresh();
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">API keys</h1>
        <p className="text-muted-foreground">
          Use these as HTTP Basic auth passwords in your F-Droid client to access private apps.
        </p>
      </header>

      {error && <p className="text-destructive">{error}</p>}

      {newlyCreated && (
        <Card className="border-primary">
          <CardHeader>
            <CardTitle className="text-base">Copy your key now</CardTitle>
            <CardDescription>It will never be shown again.</CardDescription>
          </CardHeader>
          <CardContent>
            <code className="block break-all rounded bg-muted p-3 font-mono text-xs">{newlyCreated}</code>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>New key</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="kname">Label</Label>
              <Input
                id="kname"
                placeholder="e.g. My phone"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exp">Expires (days)</Label>
              <Input
                id="exp"
                type="number"
                min={1}
                value={expiresIn}
                onChange={(e) => setExpiresIn(e.target.value)}
                placeholder="never"
              />
            </div>
            <div className="flex items-end">
              <Button type="submit" className="w-full">Create key</Button>
            </div>
            <div className="md:col-span-4 flex items-center gap-4 text-sm">
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Existing keys</CardTitle>
        </CardHeader>
        <CardContent>
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
                    {k.revoked_at ? <Badge variant="destructive">revoked</Badge> : <Badge variant="success">active</Badge>}
                  </TableCell>
                  <TableCell className="text-right">
                    {!k.revoked_at && (
                      <Button size="sm" variant="outline" onClick={() => revoke(k.id)}>
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

export default function ApiKeysPage() {
  return (
    <AuthGuard>
      <ApiKeysInner />
    </AuthGuard>
  );
}
