"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { AppIcon } from "@/components/app-icon";
import { Badge } from "@/components/ui/badge";
import { type AppSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

type Variant = "list" | "tile" | "feature" | "mini";

type Props = {
  app: AppSummary;
  variant?: Variant;
  /** Optional rank, displayed as "1." on list rows for chart layouts. */
  rank?: number;
  className?: string;
};

/* App card variants — each maps to a Play Store layout pattern:
 *   list    – horizontal row used inside rails and search results
 *   tile    – vertical grid card with centered content
 *   feature – wide banner-style card with a tinted backdrop
 *   mini    – tight 2-line card for sidebar lists and admin tables
 */
export function AppCard({ app, variant = "list", rank, className }: Props) {
  if (variant === "tile") return <Tile app={app} className={className} />;
  if (variant === "feature") return <Feature app={app} className={className} />;
  if (variant === "mini") return <Mini app={app} className={className} />;
  return <ListItem app={app} rank={rank} className={className} />;
}

/* -------------------------------------------------------------------------- */
function ListItem({
  app,
  rank,
  className,
}: {
  app: AppSummary;
  rank?: number;
  className?: string;
}) {
  return (
    <Link
      href={`/apps/${app.package_name}`}
      className={cn(
        "group flex w-full min-w-0 items-center gap-3 rounded-xl p-2.5 transition-colors duration-150",
        "hover:bg-surface-2 active:bg-surface-3",
        className,
      )}
    >
      {rank !== undefined && (
        <span className="num shrink-0 w-6 text-center text-lg font-semibold tabular-nums text-ink-mute">
          {rank}
        </span>
      )}
      <AppIcon iconPath={app.icon_path} name={app.name} size={56} shape="rounded" version={app.updated_at} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-ink">{app.name}</div>
        <div className="truncate text-xs text-ink-mute">
          {app.author_name || app.categories[0]?.name || "Self-hosted"}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-mute">
          {app.suggested_version_name && (
            <span className="font-mono">v{app.suggested_version_name}</span>
          )}
          {app.visibility === "private" && (
            <Badge variant="accent" className="px-1.5 py-0 text-[9px]">private</Badge>
          )}
        </div>
      </div>
      <ArrowRight
        className="h-4 w-4 text-ink-mute transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-ink"
        strokeWidth={2.2}
      />
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
function Tile({ app, className }: { app: AppSummary; className?: string }) {
  return (
    <Link
      href={`/apps/${app.package_name}`}
      className={cn(
        "group flex w-[148px] shrink-0 flex-col items-start gap-3 rounded-xl p-2",
        "transition-colors duration-150 hover:bg-surface-2",
        className,
      )}
    >
      <AppIcon
        iconPath={app.icon_path}
        name={app.name}
        size={120}
        shape="rounded"
        version={app.updated_at}
        className="shadow-e1 transition-transform duration-200 group-hover:scale-[1.02]"
      />
      <div className="w-full min-w-0">
        <div className="truncate text-sm font-semibold text-ink">{app.name}</div>
        <div className="truncate text-xs text-ink-mute">
          {app.categories[0]?.name || "Self-hosted"}
        </div>
      </div>
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
function Feature({ app, className }: { app: AppSummary; className?: string }) {
  // Soft tinted backdrop derived from the app name — gives each hero card a
  // distinct color without baking real palette extraction into the build.
  let h = 0;
  for (let i = 0; i < app.name.length; i++) h = (h * 31 + app.name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  const tint = `hsl(${hue} 70% 50%)`;

  return (
    <Link
      href={`/apps/${app.package_name}`}
      className={cn(
        "surface surface-interactive group relative block w-[320px] shrink-0 overflow-hidden md:w-[420px]",
        className,
      )}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.12]"
        style={{
          background: `radial-gradient(120% 80% at 80% 0%, ${tint}, transparent 60%)`,
        }}
      />
      <div className="relative flex flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <Badge variant="primary" className="uppercase tracking-wider">
            Featured
          </Badge>
          {app.visibility === "private" && <Badge variant="accent">private</Badge>}
        </div>
        <AppIcon
          iconPath={app.icon_path}
          name={app.name}
          size={88}
          shape="rounded"
          version={app.updated_at}
          className="shadow-e2"
        />
        <div className="min-w-0">
          <div className="text-xl font-bold tracking-tight text-ink">{app.name}</div>
          <div className="truncate text-sm text-ink-mute">
            {app.author_name || app.categories[0]?.name || "Self-hosted"}
          </div>
          <p className="mt-2 text-sm text-ink-soft line-clamp-2">
            {app.summary || "—"}
          </p>
        </div>
      </div>
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
function Mini({ app, className }: { app: AppSummary; className?: string }) {
  return (
    <Link
      href={`/apps/${app.package_name}`}
      className={cn(
        "flex items-center gap-2.5 rounded-lg p-1.5 transition-colors hover:bg-surface-2",
        className,
      )}
    >
      <AppIcon iconPath={app.icon_path} name={app.name} size={32} shape="rounded" version={app.updated_at} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-ink">{app.name}</div>
        <div className="truncate text-[10px] text-ink-mute font-mono">
          {app.suggested_version_name ? `v${app.suggested_version_name}` : app.package_name}
        </div>
      </div>
    </Link>
  );
}
