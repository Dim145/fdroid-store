"use client";

import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, EyeOff, ExternalLink, Globe, GitBranch, Bug, Calendar, HandHeart, Languages, Mail, Rss, ShieldAlert, UserCircle2, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Trans, useTranslation } from "react-i18next";

import { AppIcon } from "@/components/app-icon";
import { AppPermissions } from "@/components/app-permissions";
import { InstallPill } from "@/components/install-pill";
import { NsfwTag } from "@/components/nsfw-tag";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, mediaUrl, type Apk, type AppDetail, type Screenshot } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { useRepoInfo } from "@/lib/repo-store";
import { cn, formatBytes, formatCount, formatDate, pickLocalizedText } from "@/lib/utils";
import { localeLabel } from "@/lib/locales";

/* ============================================================================
 * App detail — the conversion page. Hero with the big Install pill at top,
 * screenshots gallery, expandable description, "What's new", permissions,
 * versions list, repo info footer.
 * ============================================================================ */
export default function AppDetailClient() {
  const { t } = useTranslation();
  // Static export bakes ``useParams`` to the placeholder used at build time
  // (``__dynamic``), so reading the real segment requires the live URL.
  const pathname = usePathname();
  const pkg = useMemo(() => {
    const m = pathname?.match(/^\/apps\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }, [pathname]);
  const repo = useRepoInfo();
  const { user } = useAuth();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandDesc, setExpandDesc] = useState(false);
  // Lightbox state: ``null`` means closed, otherwise an index into the
  // sorted ``screenshots`` array. Stored as an index (not an id) so the
  // prev/next arrows can step without re-resolving from the screenshot
  // list each tick.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // NSFW interstitial: once consented for this navigation, stay open. Reset
  // when ``pkg`` changes so jumping between apps re-asks.
  const [nsfwAck, setNsfwAck] = useState(false);
  useEffect(() => { setNsfwAck(false); }, [pkg]);

  useEffect(() => {
    if (!pkg) return;
    api.apps.get(decodeURIComponent(pkg))
      .then(setApp)
      .catch((e) => setError(e instanceof Error ? e.message : t("appDetail.appNotFound")));
  }, [pkg, t]);

  // Auto-discovery for feed readers — inject a ``<link rel="alternate"
  // type="application/atom+xml">`` in <head> so RSS extensions
  // (Feedbro, Inoreader bookmarklet, …) detect this app's release feed
  // automatically. The element is removed when the user navigates away
  // so it never leaks between pages on a soft Next.js transition.
  useEffect(() => {
    if (!app) return;
    const link = document.createElement("link");
    link.rel = "alternate";
    link.type = "application/atom+xml";
    link.title = `${app.name} — releases`;
    link.href = `/api/v1/feed/apps/${encodeURIComponent(app.package_name)}`;
    document.head.appendChild(link);
    return () => {
      try { document.head.removeChild(link); } catch { /* already gone */ }
    };
  }, [app]);

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
        <div className="text-3xl font-bold tracking-tight">{t("appDetail.appNotFound")}</div>
        <p className="text-ink-soft">{error}</p>
        <Button asChild variant="filled" className="mt-4">
          <Link href="/apps">
            <ArrowLeft className="h-4 w-4" /> {t("profile.backToCatalogue")}
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

  // Interstitial: NSFW apps need an explicit "Continue" tap unless the user
  // has globally opted in via account settings. Owner + admin bypass it
  // (they already see this app everywhere else).
  const userOptedIn = !!user?.show_nsfw;
  const isOwnerOrAdmin =
    !!user && (user.role === "admin" || user.username === app.owner_username);
  const nsfwGate = app.is_nsfw && !userOptedIn && !isOwnerOrAdmin && !nsfwAck;
  if (nsfwGate) {
    return (
      <div className="flex flex-col items-center justify-center gap-5 py-20 text-center">
        <div
          className="flex h-16 w-16 items-center justify-center rounded-pill"
          style={{ background: `hsl(${hue} 70% 50% / 0.18)` }}
        >
          <EyeOff className="h-7 w-7 text-danger" strokeWidth={2} />
        </div>
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 rounded-pill bg-danger-container px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-danger-on-container">
            {t("appDetail.nsfw.tagline")}
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-ink">
            {t("appDetail.nsfw.title")}
          </h1>
          <p className="mx-auto max-w-md text-sm text-ink-soft">
            <Trans
              i18nKey="appDetail.nsfw.body"
              values={{ name: app.name }}
              components={{
                bold: <span className="font-mono text-ink" />,
                link: <Link href="/account" className="text-primary hover:underline" />,
              }}
            />
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button variant="outlined" asChild>
            <Link href="/apps">
              <ArrowLeft className="h-4 w-4" /> {t("appDetail.nsfw.backToCatalogue")}
            </Link>
          </Button>
          <Button variant="filled" onClick={() => setNsfwAck(true)}>
            {t("appDetail.nsfw.continue")}
          </Button>
        </div>
      </div>
    );
  }

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
          <ArrowLeft className="h-4 w-4" /> {t("appDetail.backToApps")}
        </Link>

        <div className="grid items-start gap-6 md:grid-cols-[auto_1fr_auto] md:gap-10">
          <div className="relative w-fit">
            <AppIcon
              iconPath={app.icon_path}
              name={app.name}
              size={140}
              shape="rounded"
              version={app.updated_at}
              mediaToken={app.media_token}
              className="shadow-e3"
            />
            <NsfwTag active={app.is_nsfw} size="md" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {app.visibility === "private" && (
                <Badge variant="accent">{t("appCard.private")}</Badge>
              )}
              {app.categories.slice(0, 2).map((c) => (
                <Badge key={c.id} variant="outline">{c.name}</Badge>
              ))}
            </div>
            <h1 className="mt-3 text-3xl font-bold tracking-tight text-ink md:text-4xl">
              {app.name}
            </h1>
            <p className="mt-1 text-base text-ink-soft">
              {app.author_name || t("appDetail.selfHostedRelease")}
            </p>
            <p className="mt-0.5 font-mono text-xs text-ink-mute">{app.package_name}</p>

            {/* Stats row */}
            <dl className="mt-5 grid max-w-md grid-cols-3 gap-4 border-t border-outline-soft pt-4 text-center">
              <Stat label={t("appDetail.stats.version")} value={latest ? `v${latest.version_name}` : "—"} mono />
              <Stat label={t("appDetail.stats.size")} value={latest ? formatBytes(latest.size_bytes) : "—"} mono />
              <Stat
                label={t("appDetail.stats.downloads")}
                value={formatCount(app.download_count)}
                mono
                title={t("appDetail.totalDownloads", { count: app.download_count.toLocaleString() })}
              />
            </dl>
          </div>

          {/* Desktop: a direct ".apk" download is the only useful action since
              the fdroidrepo:// scheme is a dead end without an Android device.
              The column is forced to the AppIcon's 140px height + items-center
              so the pill sits at the icon's vertical midpoint — centring on the
              row would drop it next to the stats line instead. */}
          <div className="hidden md:flex md:h-[140px] md:items-center">
            <InstallPill
              apkFileName={latest?.file_name}
              apkId={latest?.id}
              size="xl"
              mode="download"
            />
          </div>
        </div>

        {/* Mobile: the F-Droid deep-link is the primary CTA, with a small
            fallback for users who'd rather grab the raw APK. */}
        <div className="mt-6 md:hidden">
          <InstallPill
            apkFileName={latest?.file_name}
            apkId={latest?.id}
            size="lg"
            mode="deeplink"
          />
        </div>

        {app.owner_username && (
          <div className="mt-6 flex items-center justify-end gap-1.5 text-xs text-ink-mute md:absolute md:bottom-4 md:right-6 md:mt-0">
            <UserCircle2 className="h-3.5 w-3.5" strokeWidth={2.2} />
            {t("appDetail.uploadedBy")}{" "}
            <Link
              href={`/u/${encodeURIComponent(app.owner_username)}`}
              className="font-mono font-semibold text-ink underline-offset-4 transition-colors hover:text-primary hover:underline"
            >
              @{app.owner_username}
            </Link>
          </div>
        )}
      </section>

      {/* ──── Featured graphic ──── */}
      {app.feature_graphic_path && (
        <section className="mt-10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={mediaUrl(app.feature_graphic_path, { token: app.media_token }) || ""}
            alt={`${app.name} feature graphic`}
            className="w-full rounded-2xl border border-outline-soft bg-surface-2 object-cover shadow-e1"
          />
        </section>
      )}

      {/* ──── Screenshots ──── */}
      {screenshots.length > 0 && (
        <section className="mt-10">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="section-title">{t("appDetail.screenshots")}</h2>
            {screenshots.length > 3 && (
              <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-mute">
                {t("appDetail.screenshotsCount", {
                  count: screenshots.length,
                  defaultValue: "{{count}} captures",
                })}
              </span>
            )}
          </div>
          {/* Wrap the rail in a relative container so we can pin a
              fade-mask overlay against the right edge. Without it, the
              row of screenshots ran off the viewport with no visual
              cue that more existed beyond the fold — the scrollbar is
              hidden by ``.rail``, so the user had no signal whatsoever
              that a horizontal scroll was even possible. */}
          <div className="relative -mx-4 md:-mx-2">
            <div className="rail px-4 md:px-2">
              {screenshots.map((s, i) => {
                const url = mediaUrl(s.storage_key, { token: app.media_token });
                if (!url) return null;
                return (
                  <button
                    type="button"
                    key={s.id}
                    onClick={() => setLightboxIndex(i)}
                    aria-label={t("appDetail.lightbox.openIndex", {
                      index: i + 1,
                      total: screenshots.length,
                      defaultValue: "View screenshot {{index}} of {{total}}",
                    })}
                    className={cn(
                      "group relative block shrink-0 overflow-hidden rounded-2xl border border-outline-soft bg-surface-2 shadow-e1 transition-all",
                      "hover:-translate-y-0.5 hover:shadow-e3 hover:border-outline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30",
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt={`${app.name} screenshot`}
                      loading="lazy"
                      className="h-80 w-auto object-contain md:h-[420px]"
                    />
                    {/* Hover scrim — "+" inside a hairline ring, like a
                        contact-sheet zoom mark. Reveals on hover to hint
                        at the lightbox without crowding the row. */}
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg/40 opacity-0 backdrop-blur-[1px] transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                    >
                      <span className="flex h-12 w-12 items-center justify-center rounded-pill border border-ink/30 bg-surface/70 text-ink shadow-e2 backdrop-blur">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                          <circle cx="11" cy="11" r="7" />
                          <path d="m20 20-3.5-3.5" />
                          <path d="M11 8v6M8 11h6" />
                        </svg>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {/* Right-edge fade only when the rail can actually scroll
                (3+ portrait shots ≈ ~960 px wide, always overflows on
                a typical viewport). The mask uses the page background
                so the fade reads as "the content continues" rather
                than a coloured overlay. */}
            {screenshots.length > 2 && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 right-0 hidden w-16 md:block"
                style={{
                  background: "linear-gradient(to left, rgb(var(--bg)) 0%, rgb(var(--bg) / 0.85) 35%, transparent 100%)",
                }}
              />
            )}
          </div>
        </section>
      )}

      {/* ──── What's new ──── */}
      {latest && (() => {
        const notes = pickLocalizedText(latest.whats_new, user?.preferred_locale);
        if (!notes) return null;
        const fellBack =
          !!user?.preferred_locale && notes.locale !== user.preferred_locale;
        return (
          <section className="mt-10">
            <h2 className="section-title mb-3">{t("appDetail.whatsNew")}</h2>
            <div className="surface p-6">
              <div className="flex flex-wrap items-baseline gap-3 border-b border-outline-soft pb-3">
                <span className="text-xl font-bold tracking-tight text-ink">v{latest.version_name}</span>
                <Badge variant="primary">{t("appDetail.latest")}</Badge>
                {latest.published_at && (
                  <span className="text-xs text-ink-mute">
                    <Calendar className="mr-1 inline-block h-3 w-3" />
                    {formatDate(latest.published_at)}
                  </span>
                )}
                <span
                  className="ml-auto font-mono text-[10px] text-ink-mute"
                  title={
                    fellBack
                      ? `${localeLabel(user!.preferred_locale!).label} → ${localeLabel(notes.locale).label}`
                      : localeLabel(notes.locale).label
                  }
                >
                  {notes.locale}
                </span>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
                {notes.text}
              </p>
            </div>
          </section>
        );
      })()}

      {/* ──── About + side specs ──── */}
      <section className="mt-10 grid gap-6 md:grid-cols-[1.6fr_1fr]">
        <div>
          <h2 className="section-title mb-3">{t("appDetail.aboutThisApp")}</h2>
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
                      <>{t("common.showLess")} <ChevronUp className="h-3.5 w-3.5" /></>
                    ) : (
                      <>{t("common.showMore")} <ChevronDown className="h-3.5 w-3.5" /></>
                    )}
                  </Button>
                )}
              </>
            ) : (
              <p className="italic text-ink-mute">{t("appDetail.noDescription")}</p>
            )}
          </div>
        </div>

        <aside>
          <h2 className="section-title mb-3">{t("appDetail.info")}</h2>
          <dl className="surface divide-y divide-outline-soft">
            <SpecRow icon={<Globe className="h-4 w-4" />} label={t("appDetail.fields.website")} value={app.website} link={app.website} />
            <SpecRow icon={<GitBranch className="h-4 w-4" />} label={t("appDetail.fields.source")} value={app.source_code} link={app.source_code} />
            <SpecRow icon={<Bug className="h-4 w-4" />} label={t("appDetail.fields.issues")} value={app.issue_tracker} link={app.issue_tracker} />
            <SpecRow icon={<Languages className="h-4 w-4" />} label={t("appDetail.fields.translate")} value={app.translation} link={app.translation} />
            <SpecRow icon={<Mail className="h-4 w-4" />} label={t("appDetail.fields.author")} value={app.author_email} link={app.author_email ? `mailto:${app.author_email}` : null} />
            <SpecRow label={t("appDetail.fields.license")} value={app.license} />
            <SpecRow label={t("appDetail.fields.added")} value={formatDate(app.created_at)} />
            {/* Per-app release feed — sits inside the Info block so it
                reads as "yet another sub-link of the app" alongside
                Website / Source / Issues. Public apps work anonymously;
                private apps trigger a Basic-auth prompt in the feed
                reader (the backend sends ``WWW-Authenticate``). */}
            <SpecRow
              icon={<Rss className="h-4 w-4" />}
              label={t("appDetail.fields.feed")}
              value={t("appDetail.feedAtom")}
              link={`/api/v1/feed/apps/${encodeURIComponent(app.package_name)}`}
            />
          </dl>
          {(app.donate || app.liberapay || app.bitcoin || app.open_collective) && (
            <div className="surface mt-3 p-5">
              <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-wider text-ink-mute">
                <HandHeart className="h-3.5 w-3.5" />
                {t("appDetail.supportDeveloper")}
              </div>
              <div className="flex flex-wrap gap-2">
                {app.donate && <FundingChip label={t("appDetail.funding.donate")} href={app.donate} />}
                {app.liberapay && <FundingChip label={t("appDetail.funding.liberapay")} href={app.liberapay} />}
                {app.open_collective && <FundingChip label={t("appDetail.funding.openCollective")} href={app.open_collective} />}
                {app.bitcoin && <FundingChip label={t("appDetail.funding.bitcoin")} href={app.bitcoin.startsWith("bitcoin:") ? app.bitcoin : `bitcoin:${app.bitcoin}`} />}
              </div>
            </div>
          )}
        </aside>
      </section>

      {/* ──── Permissions ──── */}
      {latest && (
        <section className="mt-10">
          <h2 className="section-title mb-1">{t("appDetail.permissions")}</h2>
          <p className="mb-3 text-sm text-ink-mute">
            {t("appDetail.permissionsForVersion", { name: latest.version_name, code: latest.version_code })}
          </p>
          <div className="surface p-6">
            <AppPermissions permissions={latest.permissions} />
          </div>
        </section>
      )}

      {/* ──── Versions ──── */}
      <section className="mt-10">
        <h2 className="section-title mb-3">
          {t("appDetail.versionsCount", { count: published.length })}
        </h2>
        <div className="surface overflow-hidden">
          {published.length === 0 ? (
            <div className="px-6 py-10 text-center italic text-ink-mute">{t("appDetail.noPublishedVersions")}</div>
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
                      {i === 0 && <Badge variant="primary">{t("appDetail.latest")}</Badge>}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-mute">
                      Code {apk.version_code} · {formatBytes(apk.size_bytes)} · SDK {apk.min_sdk ?? "?"}–{apk.target_sdk ?? "?"}
                    </div>
                    {apk.published_at && (
                      <div className="mt-1 font-mono text-[11px] text-ink-mute">
                        {formatDate(apk.published_at)}
                      </div>
                    )}
                    {apk.anti_features && apk.anti_features.length > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <ShieldAlert className="h-3 w-3 text-accent" />
                        {apk.anti_features.map((flag) => (
                          <Badge key={flag} variant="accent">{flag}</Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <DownloadApkButton
                    apk={apk}
                    repoUrl={repo.url}
                    authenticated={!!user}
                    primary={i === 0}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Lightbox — portal-less since ``position: fixed`` already
          escapes the layout. Only mounted when an index is selected so
          the keyboard / body-scroll-lock side effects fire just for
          the duration of the viewing. */}
      {lightboxIndex !== null && screenshots[lightboxIndex] && (
        <ScreenshotLightbox
          screenshots={screenshots}
          index={lightboxIndex}
          mediaToken={app.media_token}
          appName={app.name}
          onClose={() => setLightboxIndex(null)}
          onIndex={setLightboxIndex}
        />
      )}
    </article>
  );
}

/* ───────────────────────────────────────────────────────────────────────── */
function Stat({
  label,
  value,
  mono,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div title={title}>
      <div className="text-[10px] uppercase tracking-wider text-ink-mute">{label}</div>
      <div className={cn("mt-0.5 text-base font-semibold text-ink", mono && "font-mono text-sm")}>
        {value}
      </div>
    </div>
  );
}

// Same allow-list used by ``FundingChip`` below — http(s) and mailto
// are safe; everything else (javascript:, data:, vbscript:, file:…) is
// rejected. An app owner who sets ``website="javascript:alert(1)"`` via
// the manage page would otherwise XSS every visitor of the public fiche.
// Accepts ``https://...``, ``http://...``, ``mailto:...`` (the original
// allowlist for user-provided values like ``app.website``), plus the
// in-app ``/api/v1/feed/...`` paths the page itself builds for the
// per-app subscribe link. The leading-slash branch is bound to that
// exact prefix so an opportunistic ``javascript:`` or ``data:`` value
// still fails the test.
const _SAFE_LINK_RE = /^(https?|mailto):|^\/api\/v1\/feed\//i;

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
  const safeLink = link && _SAFE_LINK_RE.test(link) ? link : null;
  return (
    <div className="flex items-center gap-3 px-5 py-3 text-sm">
      <div className="flex w-20 shrink-0 items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-mute">
        {icon}
        {label}
      </div>
      <div className="min-w-0 flex-1 truncate text-ink">
        {value ? (
          safeLink ? (
            <a
              href={safeLink}
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
  const { t } = useTranslation();
  return (
    <div className="h-7 w-7 animate-spin rounded-full border-2 border-outline-soft border-t-primary" role="status" aria-label={t("common.loading")} />
  );
}


/* Screenshot lightbox — a centred image viewer with keyboard navigation
 * and a calm editorial chrome that matches the rest of the page:
 *
 *   • Counter top-left ("03 / 10" — tabular mono uppercase) acts as a
 *     position eyebrow rather than a generic dialog title.
 *   • Close pill top-right.
 *   • Chevron pills left/right (only when there's somewhere to go).
 *   • Keyboard: ← → step, Esc closes.
 *   • Tap-outside-image closes; image area itself swallows clicks so
 *     a fat-fingered drag-to-pan doesn't dismiss the viewer.
 *   • Body scroll locked while open so the page underneath doesn't
 *     drift when the user pinch-zooms or wheels.
 *   • Neighbour preload — fetch the prev/next URL ahead of time so the
 *     arrow press swap is instant, not a fade-to-black.
 *
 * Chrome restraint is intentional: the photo is the page; everything
 * else is hairline + monospace eyebrow + tabular counter. Aesthetically
 * aligned with the page's other editorial bits (the /sections rail on
 * /my-apps/[id], the section number on the same page, etc.). */
function ScreenshotLightbox({
  screenshots,
  index,
  mediaToken,
  appName,
  onClose,
  onIndex,
}: {
  screenshots: Screenshot[];
  index: number;
  mediaToken: string | null;
  appName: string;
  onClose: () => void;
  onIndex: (next: number) => void;
}) {
  const { t } = useTranslation();
  const total = screenshots.length;
  const current = screenshots[index];

  const goPrev = useCallback(() => {
    if (index > 0) onIndex(index - 1);
  }, [index, onIndex]);
  const goNext = useCallback(() => {
    if (index < total - 1) onIndex(index + 1);
  }, [index, total, onIndex]);

  // Keyboard navigation + body scroll lock. Mount-only effect so we
  // don't keep re-binding on every index change.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); goPrev(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); goNext(); }
    }
    window.addEventListener("keydown", onKey);
    const orig = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = orig;
    };
  }, [onClose, goPrev, goNext]);

  // Neighbour preload — issue a side-effect-free Image() request for
  // index ± 1 so paging through the carousel doesn't pause for a
  // network round-trip. Fires after each index change.
  useEffect(() => {
    [index - 1, index + 1].forEach((i) => {
      if (i >= 0 && i < total) {
        const url = mediaUrl(screenshots[i].storage_key, { token: mediaToken });
        if (url) {
          const img = new window.Image();
          img.src = url;
        }
      }
    });
  }, [index, total, screenshots, mediaToken]);

  // SSR-safe portal target. During the static export pre-render the
  // body isn't available, so we bail and let the client-side mount
  // re-render us into the portal.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const url = mediaUrl(current.storage_key, { token: mediaToken });
  if (!url || !mounted) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("appDetail.lightbox.openIndex", {
        index: index + 1,
        total,
        defaultValue: "Screenshot {{index}} of {{total}}",
      })}
      className="fixed inset-0 z-[100] flex items-center justify-center animate-fade-in"
      onClick={onClose}
    >
      {/* Backdrop — deep ink with a touch of blur for depth. Sits
          below everything else so clicks on it hit the dialog's onClick
          and dismiss the viewer. */}
      <div aria-hidden className="absolute inset-0 bg-bg/[0.94] backdrop-blur-md" />

      {/* Top chrome: counter (left) + close (right) */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between p-4 md:p-6">
        <div
          className="rounded-pill border border-outline-soft bg-surface/70 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.28em] text-ink-mute backdrop-blur"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="tabular-nums text-ink">{String(index + 1).padStart(2, "0")}</span>
          <span className="px-2 opacity-50">/</span>
          <span className="tabular-nums">{String(total).padStart(2, "0")}</span>
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          aria-label={t("appDetail.lightbox.close", { defaultValue: "Close" })}
          className="flex h-10 w-10 items-center justify-center rounded-pill border border-outline-soft bg-surface/85 text-ink-soft backdrop-blur transition-colors hover:border-outline hover:text-ink focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30"
        >
          <X className="h-4 w-4" strokeWidth={2.4} />
        </button>
      </div>

      {/* Image — centred, with the modal-pop bounce on swap.
          ``key`` on the image element forces a re-mount when the index
          changes so the animation re-fires per slide. */}
      <div
        className="relative z-[5] max-h-[85vh] max-w-[92vw]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={current.id}
          src={url}
          alt={`${appName} screenshot ${index + 1}`}
          className="max-h-[85vh] max-w-[92vw] animate-modal-pop rounded-2xl object-contain shadow-e3"
          draggable={false}
        />
      </div>

      {/* Prev/Next pills — only when there's somewhere to go. The
          ``onClick`` stops propagation so the dialog's backdrop click
          doesn't fire when paging. */}
      {index > 0 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); goPrev(); }}
          aria-label={t("appDetail.lightbox.previous", { defaultValue: "Previous screenshot" })}
          className="absolute left-2 z-10 flex h-12 w-12 items-center justify-center rounded-pill border border-outline-soft bg-surface/85 text-ink-soft backdrop-blur transition-colors hover:border-outline hover:text-ink focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30 md:left-6 md:h-14 md:w-14"
        >
          <ChevronLeft className="h-5 w-5 md:h-6 md:w-6" strokeWidth={2.4} />
        </button>
      )}
      {index < total - 1 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); goNext(); }}
          aria-label={t("appDetail.lightbox.next", { defaultValue: "Next screenshot" })}
          className="absolute right-2 z-10 flex h-12 w-12 items-center justify-center rounded-pill border border-outline-soft bg-surface/85 text-ink-soft backdrop-blur transition-colors hover:border-outline hover:text-ink focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30 md:right-6 md:h-14 md:w-14"
        >
          <ChevronRight className="h-5 w-5 md:h-6 md:w-6" strokeWidth={2.4} />
        </button>
      )}

      {/* Bottom chrome — kbd shortcut hints + open-in-tab escape hatch
          (some users still want the raw URL for download / sharing). */}
      <div className="absolute inset-x-0 bottom-0 z-10 flex items-end justify-between gap-3 p-4 md:p-6">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1.5 rounded-pill border border-outline-soft bg-surface/70 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-mute backdrop-blur transition-colors hover:border-outline hover:text-ink"
        >
          <ExternalLink className="h-3 w-3" strokeWidth={2.4} />
          {t("appDetail.lightbox.openOriginal", { defaultValue: "Open original" })}
        </a>
        <div
          aria-hidden
          className="hidden items-center gap-2 rounded-pill border border-outline-soft bg-surface/70 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-mute backdrop-blur md:flex"
          onClick={(e) => e.stopPropagation()}
        >
          <kbd className="text-ink-soft">Esc</kbd>
          <span className="opacity-50">·</span>
          <kbd className="text-ink-soft">←</kbd>
          <kbd className="text-ink-soft">→</kbd>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Download button that handles the SPA-friendly download flow.
 *
 * The F-Droid serve endpoint requires either a Basic-auth API key or a
 * signed ``?t=`` token in private mode. Anchor clicks carry no auth, so
 * for logged-in users we exchange the JWT for a short-lived signed URL
 * before navigating. Anonymous users in public mode still get the direct
 * URL (which works since the repo allows anonymous downloads then). */
function DownloadApkButton({
  apk,
  repoUrl,
  authenticated,
  primary,
}: {
  apk: Apk;
  repoUrl: string;
  authenticated: boolean;
  primary: boolean;
}) {
  const [busy, setBusy] = useState(false);

  async function onClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (!authenticated) return; // let the default ``<a download>`` flow run
    e.preventDefault();
    setBusy(true);
    try {
      const { url } = await api.apps.downloadUrl(apk.id);
      // Defence against an API that ever returns a non-http(s) URL
      // (misconfig, DB-injection, future bug). Anything else would XSS
      // through ``window.location = "javascript:..."``.
      if (!/^https?:\/\//i.test(url) && !url.startsWith("/")) {
        throw new Error("Unsafe download URL");
      }
      window.location.href = url;
    } catch {
      // Fall back to the bare URL — the browser will then prompt for
      // credentials if private mode is on, which surfaces the failure
      // rather than silently doing nothing.
      window.location.href = `${repoUrl}/${apk.file_name}`;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button asChild variant={primary ? "filled" : "outlined"} size="md" disabled={busy}>
      <a href={`${repoUrl}/${apk.file_name}`} onClick={onClick} download>
        {busy ? "…" : ".apk"}
      </a>
    </Button>
  );
}

// Whitelist of URI schemes funding chips are allowed to link to. App-author-
// supplied values flow through here, so anything outside the list (notably
// ``javascript:``, ``data:``, ``vbscript:``) is rendered as plain text.
const _FUNDING_URL_RE = /^(https?|mailto|bitcoin):/i;

function FundingChip({ label, href }: { label: string; href: string }) {
  if (!_FUNDING_URL_RE.test(href)) {
    return (
      <span
        title="Link removed (unsupported URL scheme)"
        className="inline-flex items-center gap-1.5 rounded-pill border border-outline-soft bg-surface px-3 py-1.5 text-xs font-medium text-ink-mute"
      >
        {label}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 rounded-pill border border-outline-soft bg-surface px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:border-primary hover:text-primary"
    >
      {label}
      <ExternalLink className="h-3 w-3" strokeWidth={2.4} />
    </a>
  );
}
