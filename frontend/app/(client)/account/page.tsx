"use client";

import { useEffect, useState } from "react";

import { AuthGuard } from "@/components/auth-guard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";

function AccountInner() {
  const { user, fetchMe } = useAuth();
  const [fullName, setFullName] = useState(user?.full_name || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setFullName(user?.full_name || ""), [user]);

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
      setMsg("Password changed.");
      setCurrentPassword("");
      setNewPassword("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Change failed");
    }
  }

  if (!user) return null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Account</h1>
        <p className="text-muted-foreground">Manage your profile and password.</p>
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
                <Input
                  id="cur"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new">New password</Label>
                <Input
                  id="new"
                  type="password"
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
              </div>
              <Button type="submit">Change password</Button>
            </form>
          </CardContent>
        </Card>
      )}
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
