"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppCard } from "@/components/app-card";
import { FeatureHero } from "@/components/feature-hero";
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
  const router = useRouter();
  const { user, loading, fetchMe } = useAuth();
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  const [repoName, setRepoName] = useState<string | null>(null);
  const [repoDescription, setRepoDescription] = useState<string | null>(null);
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);

  useEffect(() => { fetchMe(); }, [fetchMe]);

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
  const hero = freshest[0];
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
          <div className="eyebrow text-primary">Setup required</div>
          <h1 className="mt-3 text-3xl font-bold tracking-tight">
            The repo isn&apos;t ready yet.
          </h1>
          <p className="mt-3 text-ink-soft">
            {user
              ? "An administrator needs to finish the wizard."
              : "Sign in as an administrator to complete the one-time setup."}
          </p>
          {!user && (
            <Button asChild size="lg" variant="filled" className="mt-6">
              <Link href="/login?next=/admin/setup">Sign in to set up</Link>
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
        {/* ──── Welcome / repo title ──── */}
        <header className="mb-6 md:mb-8">
          <div className="eyebrow">Welcome</div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">
            {repoName || "Your indie app shelf"}
          </h1>
          {repoDescription && (
            <p className="mt-1 max-w-2xl text-ink-soft">{repoDescription}</p>
          )}
        </header>

        {/* ──── Feature hero ──── */}
        {hero ? (
          <section className="animate-fade-up">
            <FeatureHero app={hero} kicker="Editor’s pick" />
          </section>
        ) : (
          <EmptyShelf />
        )}

        {/* ──── Top picks (tiles) ──── */}
        {topPicks.length > 0 && (
          <Section
            title="Top picks"
            subtitle="Curated highlights from the catalogue"
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
        {recentlyUpdated.length > 0 && (
          <Section
            title="Recently updated"
            subtitle="Freshest releases shipped"
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
          <Section title="Categories" subtitle="Browse by interest" delay={180}>
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
        {href && (
          <Link
            href={href}
            className="inline-flex items-center gap-1 rounded-pill px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/8"
          >
            See all
            <ChevronRight className="h-4 w-4" strokeWidth={2.4} />
          </Link>
        )}
      </header>
      {children}
    </section>
  );
}

function EmptyShelf() {
  return (
    <div className="surface flex flex-col items-center gap-3 p-12 text-center">
      <div className="text-2xl font-bold tracking-tight text-ink">
        Nothing on the shelf yet.
      </div>
      <p className="max-w-md text-ink-soft">
        Once an APK is published you&apos;ll see it featured here. Admin: head
        to <Link href="/my-apps/new" className="text-primary underline underline-offset-4">My apps → New release</Link>.
      </p>
    </div>
  );
}

function Spinner() {
  return (
    <div
      className="h-7 w-7 animate-spin rounded-full border-2 border-outline-soft border-t-primary"
      role="status"
      aria-label="Loading"
    />
  );
}
