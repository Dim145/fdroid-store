"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";

export default function Home() {
  const router = useRouter();
  const { user, loading, fetchMe } = useAuth();
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  const repoUrl =
    process.env.NEXT_PUBLIC_REPO_URL || "http://localhost:8080/fdroid/repo";

  useEffect(() => { fetchMe(); }, [fetchMe]);

  useEffect(() => {
    api.setup.status()
      .then((s) => setSetupComplete(s.setup_complete))
      .catch(() => setSetupComplete(true));
  }, []);

  useEffect(() => {
    if (setupComplete === false && !loading && user?.role === "admin") {
      router.replace("/admin/setup");
    }
  }, [setupComplete, loading, user, router]);

  if (setupComplete === null || loading) {
    return (
      <main className="container flex min-h-screen items-center justify-center text-muted-foreground">
        Loading…
      </main>
    );
  }

  // ─── Setup not complete ────────────────────────────────────────────────
  if (!setupComplete) {
    if (!user) {
      return (
        <main className="container flex min-h-screen flex-col items-center justify-center gap-6 text-center">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight">Welcome to fdroid-store</h1>
            <p className="max-w-md text-muted-foreground">
              This repository has not been set up yet. An administrator must
              sign in to complete the one-time setup.
            </p>
          </div>
          <Button asChild size="lg">
            <Link href="/login?next=/admin/setup">Sign in to continue setup</Link>
          </Button>
        </main>
      );
    }
    if (user.role !== "admin") {
      return (
        <main className="container flex min-h-screen flex-col items-center justify-center gap-4 text-center">
          <h1 className="text-2xl font-bold">Setup required</h1>
          <p className="max-w-md text-muted-foreground">
            The repository is not configured yet. Please ask an administrator
            to complete the setup wizard.
          </p>
        </main>
      );
    }
    // admin gets redirected by the effect above
    return null;
  }

  // ─── Normal homepage ───────────────────────────────────────────────────
  return (
    <main className="container flex min-h-screen flex-col items-center justify-center gap-8 py-16 text-center">
      <div className="space-y-3">
        <span className="rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
          self-hosted F-Droid repository
        </span>
        <h1 className="text-4xl font-bold tracking-tight md:text-6xl">fdroid-store</h1>
        <p className="mx-auto max-w-xl text-balance text-muted-foreground">
          Publish your own Android apps to a private F-Droid repository. Open the
          client area to manage your account, or jump straight into the admin
          dashboard to moderate apps and configure the repo.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button asChild size="lg">
          <Link href="/apps">Browse apps</Link>
        </Button>
        {!user && (
          <Button asChild variant="outline" size="lg">
            <Link href="/login">Sign in</Link>
          </Button>
        )}
        {user?.role === "admin" && (
          <Button asChild variant="ghost" size="lg">
            <Link href="/admin">Admin</Link>
          </Button>
        )}
      </div>

      <div className="rounded-lg border bg-card p-4 text-left text-sm">
        <p className="font-medium">Add this repo to your F-Droid client:</p>
        <code className="mt-2 block break-all rounded bg-muted px-2 py-1 font-mono text-xs">
          {repoUrl}
        </code>
        <p className="mt-2 text-xs text-muted-foreground">
          For private apps, use HTTP Basic auth: any username, password = your
          full API key.
        </p>
      </div>
    </main>
  );
}
