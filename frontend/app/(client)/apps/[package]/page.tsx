"use client";

import { ArrowLeft, ChevronDown, ChevronUp, ExternalLink, Globe, GitBranch, Bug, Calendar } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppIcon } from "@/components/app-icon";
import { AppPermissions } from "@/components/app-permissions";
import { InstallPill } from "@/components/install-pill";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, mediaUrl, REPO_URL, type AppDetail } from "@/lib/api";
import { cn, formatBytes, formatDate } from "@/lib/utils";

/* ============================================================================
 * App detail — the conversion page. Hero with the big Install pill at top,
 * screenshots gallery, expandable description, "What's new", permissions,
 * versions list, repo info footer.
 * ============================================================================ */
export default function AppDetailPage() {
  const { package: pkg } = useParams<{ package: string }>();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandDesc, setExpandDesc] = useState(false);

  useEffect(() => {
    if (!pkg) return;
    api.apps.get(decodeURIComponent(pkg))
      .then(setApp)
      .catch((e) => setError(e instanceof Error ? e.message : "Not found"));
  }, [pkg]);

  const published = useMemo(
    () =>
      app
        ? [...app.apks]
            .filter((a) => a.status === "published")
            .sort((a, b) => b.version_code - a.version_code)
        : [],
    [app],
  );
  const latest = published[0];
  const screenshots = useMemo(
    () =>
      app ? [...app.screenshots].sort((a, b) => a.display_order - b.display_order) : [],
    [app],
  );

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <div className="text-3xl font-bold tracking-tight">App not found</div>
        <p className="text-ink-soft">{error}</p>
        <Button asChild variant="filled" className="mt-4">
          <Link href="/apps">
            <ArrowLeft className="h-4 w-4" /> Back to catalogue
          </Link>
        </Button>
      </div>
    );
  }
  if (!app) {
    return (
      <div className="flex justify-center py-24">
        <Spinner />
      </div>
    );
  }

  let h = 0;
  for (let i = 0; i < app.name.length; i++) h = (h * 31 + app.name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;

  return (
    <article className="animate-fade-in">
      {/* ──── Hero ──── */}
      <section
        className="surface relative overflow-hidden p-6 md:p-10"
        style={{
          backgroundImage: `radial-gradient(80% 60% at 100% 0%, hsl(${hue} 70% 50% / 0.14), transparent 60%)`,
        }}
      >
        <Link
          href="/apps"
          className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" /> Back to apps
        </Link>

        <div className="grid items-start gap-6 md:grid-cols-[auto_1fr_auto] md:gap-10">
          <AppIcon
            iconPath={app.icon_path}
            name={app.name}
            size={140}
            shape="rounded"
            version={app.updated_at}
            className="shadow-e3"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {app.visibility === "private" && (
                <Badge variant="accent">private</Badge>
              )}
              {app.categories.slice(0, 2).map((c) => (
                <Badge key={c.id} variant="outline">{c.name}</Badge>
              ))}
            </div>
            <h1 className="mt-3 text-3xl font-bold tracking-tight text-ink md:text-4xl">
              {app.name}
            </h1>
            <p className="mt-1 text-base text-ink-soft">
              {app.author_name || "Self-hosted release"}
            </p>
            <p className="mt-0.5 font-mono text-xs text-ink-mute">{app.package_name}</p>

            {/* Stats row */}
            <dl className="mt-5 grid max-w-md grid-cols-3 gap-4 border-t border-outline-soft pt-4 text-center">
              <Stat label="Version" value={latest ? `v${latest.version_name}` : "—"} mono />
              <Stat label="Size" value={latest ? formatBytes(latest.size_bytes) : "—"} mono />
              <Stat
                label="Min SDK"
                value={latest?.min_sdk ? String(latest.min_sdk) : "—"}
                mono
              />
            </dl>
          </div>

          {/* Install pill column (desktop) */}
          <div className="hidden md:block">
            <InstallPill apkFileName={latest?.file_name} size="xl" />
          </div>
        </div>

        {/* Install pill (mobile) */}
        <div className="mt-6 md:hidden">
          <InstallPill apkFileName={latest?.file_name} size="lg" />
        </div>
      </section>

      {/* ──── Screenshots ──── */}
      {screenshots.length > 0 && (
        <section className="mt-10">
          <h2 className="section-title mb-3">Screenshots</h2>
          <div className="rail -mx-4 px-4 md:-mx-2 md:px-2">
            {screenshots.map((s) => {
              const url = mediaUrl(s.storage_key);
              if (!url) return null;
              return (
                <a
                  key={s.id}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block shrink-0 overflow-hidden rounded-2xl border border-outline-soft bg-surface-2 shadow-e1 transition-shadow hover:shadow-e3"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt={`${app.name} screenshot`}
                    loading="lazy"
                    className="h-80 w-auto object-contain md:h-[420px]"
                  />
                </a>
              );
            })}
          </div>
        </section>
      )}

      {/* ──── What's new ──── */}
      {latest?.whats_new && (
        <section className="mt-10">
          <h2 className="section-title mb-3">What&apos;s new</h2>
          <div className="surface p-6">
            <div className="flex flex-wrap items-baseline gap-3 border-b border-outline-soft pb-3">
              <span className="text-xl font-bold tracking-tight text-ink">v{latest.version_name}</span>
              <Badge variant="primary">latest</Badge>
              {latest.published_at && (
                <span className="text-xs text-ink-mute">
                  <Calendar className="mr-1 inline-block h-3 w-3" />
                  {formatDate(latest.published_at)}
                </span>
              )}
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
              {latest.whats_new}
            </p>
          </div>
        </section>
      )}

      {/* ──── About + side specs ──── */}
      <section className="mt-10 grid gap-6 md:grid-cols-[1.6fr_1fr]">
        <div>
          <h2 className="section-title mb-3">About this app</h2>
          <div className="surface p-6">
            {app.description ? (
              <>
                <p
                  className={cn(
                    "whitespace-pre-wrap text-sm leading-relaxed text-ink-soft",
                    !expandDesc && "line-clamp-6",
                  )}
                >
                  {app.description}
                </p>
                {app.description.length > 320 && (
                  <Button
                    variant="text"
                    size="sm"
                    onClick={() => setExpandDesc((s) => !s)}
                    className="mt-2 px-0"
                  >
                    {expandDesc ? (
                      <>Show less <ChevronUp className="h-3.5 w-3.5" /></>
                    ) : (
                      <>Read more <ChevronDown className="h-3.5 w-3.5" /></>
                    )}
                  </Button>
                )}
              </>
            ) : (
              <p className="italic text-ink-mute">No description provided.</p>
            )}
          </div>
        </div>

        <aside>
          <h2 className="section-title mb-3">Info</h2>
          <dl className="surface divide-y divide-outline-soft">
            <SpecRow icon={<Globe className="h-4 w-4" />} label="Website" value={app.website} link={app.website} />
            <SpecRow icon={<GitBranch className="h-4 w-4" />} label="Source" value={app.source_code} link={app.source_code} />
            <SpecRow icon={<Bug className="h-4 w-4" />} label="Issues" value={app.issue_tracker} link={app.issue_tracker} />
            <SpecRow label="License" value={app.license} />
            <SpecRow label="Added" value={formatDate(app.created_at)} />
          </dl>
        </aside>
      </section>

      {/* ──── Permissions ──── */}
      {latest && (
        <section className="mt-10">
          <h2 className="section-title mb-1">Permissions</h2>
          <p className="mb-3 text-sm text-ink-mute">
            Requested by v{latest.version_name} ({latest.version_code})
          </p>
          <div className="surface p-6">
            <AppPermissions permissions={latest.permissions} />
          </div>
        </section>
      )}

      {/* ──── Versions ──── */}
      <section className="mt-10">
        <h2 className="section-title mb-3">
          {published.length} version{published.length === 1 ? "" : "s"}
        </h2>
        <div className="surface overflow-hidden">
          {published.length === 0 ? (
            <div className="px-6 py-10 text-center italic text-ink-mute">No published versions.</div>
          ) : (
            <ul>
              {published.map((apk, i) => (
                <li
                  key={apk.id}
                  className={cn(
                    "flex items-center gap-4 px-6 py-4",
                    i !== published.length - 1 && "border-b border-outline-soft",
                  )}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-semibold text-ink">v{apk.version_name}</span>
                      {i === 0 && <Badge variant="primary">latest</Badge>}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-mute">
                      Code {apk.version_code} · {formatBytes(apk.size_bytes)} · SDK {apk.min_sdk}–{apk.target_sdk}
                    </div>
                    {apk.published_at && (
                      <div className="mt-1 font-mono text-[11px] text-ink-mute">
                        {formatDate(apk.published_at)}
                      </div>
                    )}
                  </div>
                  <Button asChild variant={i === 0 ? "filled" : "outlined"} size="md">
                    <a href={`${REPO_URL}/${apk.file_name}`} download>
                      .apk
                    </a>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </article>
  );
}

/* ───────────────────────────────────────────────────────────────────────── */
function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-mute">{label}</div>
      <div className={cn("mt-0.5 text-base font-semibold text-ink", mono && "font-mono text-sm")}>
        {value}
      </div>
    </div>
  );
}

function SpecRow({
  icon,
  label,
  value,
  link,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string | null | undefined;
  link?: string | null;
}) {
  return (
    <div className="flex items-center gap-3 px-5 py-3 text-sm">
      <div className="flex w-20 shrink-0 items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-mute">
        {icon}
        {label}
      </div>
      <div className="min-w-0 flex-1 truncate text-ink">
        {value ? (
          link ? (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <span className="truncate">{value}</span>
              <ExternalLink className="h-3 w-3 shrink-0" strokeWidth={2.4} />
            </a>
          ) : (
            value
          )
        ) : (
          <span className="text-ink-mute">—</span>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div className="h-7 w-7 animate-spin rounded-full border-2 border-outline-soft border-t-primary" role="status" aria-label="Loading" />
  );
}
