"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { AppCard } from "@/components/app-card";
import { FeatureHero } from "@/components/feature-hero";
import { PrivateAccessGuard } from "@/components/private-access-guard";
import { RepoCta } from "@/components/repo-cta";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { api, type AppSummary, type Category } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";

/* ============================================================================
 * Home — modern Android-app-store layout.
 * Sections (Play Store order): feature hero · top picks (tiles) · recently
 * updated (list) · categories grid · repo CTA.
 * ============================================================================ */
export default function Home() {
  const { t } = useTranslation();
  const router = useRouter();
  const { user, loading } = useAuth();
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  const [repoName, setRepoName] = useState<string | null>(null);
  const [repoDescription, setRepoDescription] = useState<string | null>(null);
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);

  // ``fetchMe`` is fired once at module load by the auth-store bootstrap;
  // an extra effect here just caused a duplicate /me request on every
  // home-page mount.

  useEffect(() => {
    api.setup.status()
      .then((s) => {
        setSetupComplete(s.setup_complete);
        setRepoName(s.repo_name);
        setRepoDescription(s.repo_description);
      })
      .catch(() => setSetupComplete(true));
    api.apps.list().then(setApps).catch(() => setApps([]));
    api.categories.list().then(setCategories).catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    if (setupComplete === false && !loading && user?.role === "admin") {
      router.replace("/admin/setup");
    }
  }, [setupComplete, loading, user, router]);

  const freshest = useMemo(
    () =>
      [...apps]
        .filter((a) => a.last_published_at)
        .sort(
          (a, b) =>
            new Date(b.last_published_at!).getTime() -
            new Date(a.last_published_at!).getTime(),
        ),
    [apps],
  );
  // Below this threshold the multi-section layout (hero · top picks
  // rail · recently-updated list) looks half-empty: the same 1–5 apps
  // get re-rendered three times, the hero "Editor's pick" reads as
  // theatrical for what is in practice "the only app we have", and the
  // page wastes most of the fold on whitespace. Drop straight into a
  // single tile grid until the catalogue has enough density to support
  // the storefront treatment.
  const COMPACT_THRESHOLD = 5;
  const compactMode = freshest.length > 0 && freshest.length <= COMPACT_THRESHOLD;
  const hero = compactMode ? undefined : freshest[0];
  const topPicks = freshest.slice(0, 12);
  const recentlyUpdated = freshest.slice(0, 8);

  const usedCategoryNames = useMemo(() => {
    const s = new Set<string>();
    apps.forEach((a) => a.categories.forEach((c) => s.add(c.name)));
    return s;
  }, [apps]);
  const liveCategories = useMemo(
    () => categories.filter((c) => usedCategoryNames.has(c.name)),
    [categories, usedCategoryNames],
  );

  if (setupComplete === null) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  // ─── Setup not complete ────────────────────────────────────────────────
  if (!setupComplete) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
        <div className="surface max-w-md p-10">
          <div className="eyebrow text-primary">{t("home.setupRequired")}</div>
          <h1 className="mt-3 text-3xl font-bold tracking-tight">
            {t("home.setupNotReady")}
          </h1>
          <p className="mt-3 text-ink-soft">
            {user ? t("home.setupAdminCta") : t("home.setupAnonCta")}
          </p>
          {!user && (
            <Button asChild size="lg" variant="filled" className="mt-6">
              <Link href="/login?next=/admin/setup">{t("home.setupSignIn")}</Link>
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="container flex-1 py-6 md:py-10">
        <PrivateAccessGuard>
        {/* ──── Welcome / repo title ──── */}
        <header className="mb-6 md:mb-8">
          <div className="eyebrow">{t("home.welcome")}</div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">
            {repoName || t("home.defaultRepoName")}
          </h1>
          {repoDescription && (
            <p className="mt-1 max-w-2xl text-ink-soft">{repoDescription}</p>
          )}
        </header>

        {/* ──── Feature hero ──── */}
        {hero ? (
          <section className="animate-fade-up">
            <FeatureHero app={hero} kicker={t("home.editorsPick")} />
          </section>
        ) : freshest.length === 0 ? (
          <EmptyShelf />
        ) : null}

        {/* ──── Compact small-shelf view ────
         *  Catalogue is non-empty but tiny: show every app once, in a
         *  single grid that fills the fold without ceremony. Tile size
         *  matches the regular "Top picks" rail so the page doesn't
         *  feel visually re-skinned past the threshold. */}
        {compactMode && (
          <Section
            title={t("home.compactTitle", {
              count: freshest.length,
              defaultValue: "{{count}} apps on the shelf",
            })}
            subtitle={t("home.compactSubtitle", {
              defaultValue: "Every app in the repo, right here.",
            })}
            href="/apps"
            delay={60}
          >
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {freshest.map((app) => (
                <AppCard key={app.id} app={app} variant="tile" />
              ))}
            </div>
          </Section>
        )}

        {/* ──── Top picks (tiles) ──── */}
        {!compactMode && topPicks.length > 0 && (
          <Section
            title={t("home.topPicks")}
            subtitle={t("home.topPicksSubtitle")}
            href="/apps"
            delay={60}
          >
            <div className="rail -mx-4 px-4 md:-mx-2 md:px-2">
              {topPicks.map((app) => (
                <AppCard key={app.id} app={app} variant="tile" />
              ))}
            </div>
          </Section>
        )}

        {/* ──── Recently updated (list rows) ──── */}
        {!compactMode && recentlyUpdated.length > 0 && (
          <Section
            title={t("home.recentlyUpdated")}
            subtitle={t("home.recentlyUpdatedSubtitle")}
            href="/apps"
            delay={120}
          >
            <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
              {recentlyUpdated.map((app, i) => (
                <AppCard key={app.id} app={app} variant="list" rank={i + 1} />
              ))}
            </div>
          </Section>
        )}

        {/* ──── Categories grid ──── */}
        {liveCategories.length > 0 && (
          <Section title={t("home.categoriesTitle")} subtitle={t("home.categoriesSubtitle")} delay={180}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {liveCategories.map((c) => {
                const count = apps.filter((a) =>
                  a.categories.some((x) => x.id === c.id),
                ).length;
                return (
                  <Link
                    key={c.id}
                    href={`/apps?category=${encodeURIComponent(c.name)}`}
                    className="surface surface-interactive group flex items-center justify-between gap-2 p-4"
                  >
                    <span className="font-semibold text-ink">{c.name}</span>
                    <span className="font-mono text-xs text-ink-mute transition-colors group-hover:text-primary">
                      {count} →
                    </span>
                  </Link>
                );
              })}
            </div>
          </Section>
        )}

        {/* ──── Repo CTA ──── */}
        <section className="mt-12 animate-fade-up [animation-delay:220ms]">
          <RepoCta />
        </section>
        </PrivateAccessGuard>
      </main>
      <SiteFooter />
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────────── */
function Section({
  title,
  subtitle,
  href,
  delay = 0,
  children,
}: {
  title: string;
  subtitle?: string;
  href?: string;
  delay?: number;
  children: React.ReactNode;
}) {
  return (
    <section
      className="mt-10 animate-fade-up md:mt-14"
      style={{ animationDelay: `${delay}ms` }}
    >
      <header className="mb-4 flex items-end justify-between gap-3">
        <div>
          <h2 className="section-title">{title}</h2>
          {subtitle && (
            <p className="mt-0.5 text-sm text-ink-mute">{subtitle}</p>
          )}
        </div>
        {href && <SeeAllLink href={href} />}
      </header>
      {children}
    </section>
  );
}

function EmptyShelf() {
  const { t } = useTranslation();
  return (
    <div className="surface flex flex-col items-center gap-3 p-12 text-center">
      <div className="text-2xl font-bold tracking-tight text-ink">
        {t("home.emptyShelfTitle")}
      </div>
      <p className="max-w-md text-ink-soft">
        <Trans
          i18nKey="home.emptyShelfBody"
          components={{
            link: <Link href="/my-apps/new" className="text-primary underline underline-offset-4" />,
          }}
        />
      </p>
    </div>
  );
}

function SeeAllLink({ href }: { href: string }) {
  const { t } = useTranslation();
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded-pill px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/8"
    >
      {t("home.seeAll")}
      <ChevronRight className="h-4 w-4" strokeWidth={2.4} />
    </Link>
  );
}

function Spinner() {
  const { t } = useTranslation();
  return (
    <div
      className="h-7 w-7 animate-spin rounded-full border-2 border-outline-soft border-t-primary"
      role="status"
      aria-label={t("common.loading")}
    />
  );
}
