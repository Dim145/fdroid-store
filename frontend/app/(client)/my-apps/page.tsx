"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { AppIcon } from "@/components/app-icon";
import { AuthGuard } from "@/components/auth-guard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, type AppSummary } from "@/lib/api";
import { formatDate } from "@/lib/utils";

function MyAppsInner() {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.apps.myApps()
      .then(setApps)
      .catch((e) => setError(e instanceof Error ? e.message : "Load failed"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      {/* Header */}
      <header className="mb-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow">Developer</div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">My apps</h1>
          <p className="mt-1 text-ink-soft">Manage releases, versions and metadata.</p>
        </div>
        <Button asChild variant="filled" size="lg">
          <Link href="/my-apps/new">
            <Plus className="h-4 w-4" strokeWidth={2.4} />
            New release
          </Link>
        </Button>
      </header>

      {error && (
        <p className="mb-4 rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{error}</p>
      )}

      {loading ? (
        <div className="surface flex h-32 items-center justify-center">
          <Spinner />
        </div>
      ) : apps.length === 0 ? (
        <div className="surface flex flex-col items-center gap-3 py-16 text-center">
          <div className="text-2xl font-bold tracking-tight text-ink">Nothing published yet</div>
          <p className="max-w-sm text-ink-soft">
            Start by uploading your first APK — we extract metadata for you.
          </p>
          <Button asChild variant="filled" size="lg" className="mt-2">
            <Link href="/my-apps/new">
              <Plus className="h-4 w-4" /> Create your first app
            </Link>
          </Button>
        </div>
      ) : (
        <ul className="grid gap-2 md:grid-cols-2">
          {apps.map((app, i) => (
            <li
              key={app.id}
              className="surface surface-interactive group flex items-center gap-4 p-4 animate-fade-up"
              style={{ animationDelay: `${Math.min(i * 30, 240)}ms` }}
            >
              <AppIcon iconPath={app.icon_path} name={app.name} size={64} version={app.updated_at} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Link
                    href={`/my-apps/${app.id}`}
                    className="text-base font-semibold text-ink hover:underline underline-offset-4"
                  >
                    {app.name}
                  </Link>
                  {app.visibility === "private" && <Badge variant="accent">private</Badge>}
                  <Badge variant={app.status === "published" ? "primary" : "soft"}>
                    {app.status.replace("_", " ")}
                  </Badge>
                </div>
                <p className="mt-0.5 truncate font-mono text-[11px] text-ink-mute">{app.package_name}</p>
                <div className="mt-1 flex items-center gap-3 text-xs text-ink-mute">
                  {app.suggested_version_name && (
                    <span className="font-mono">v{app.suggested_version_name}</span>
                  )}
                  <span>Updated {formatDate(app.last_published_at || app.updated_at)}</span>
                </div>
              </div>
              <Button asChild variant="outlined" size="md" className="shrink-0">
                <Link href={`/my-apps/${app.id}`}>Manage</Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <div className="h-6 w-6 animate-spin rounded-full border-2 border-outline-soft border-t-primary" role="status" aria-label="Loading" />
  );
}

export default function MyAppsPage() {
  return (
    <AuthGuard>
      <MyAppsInner />
    </AuthGuard>
  );
}
