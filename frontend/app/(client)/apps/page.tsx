"use client";

export const dynamic = "force-dynamic";

import { Search, LayoutGrid, List } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { AppCard } from "@/components/app-card";
import { Button } from "@/components/ui/button";
import { api, type AppSummary, type Category } from "@/lib/api";
import { cn } from "@/lib/utils";

/* ============================================================================
 * Browse — list/grid of every app on the catalogue.
 *
 * Toolbar holds the search + sort + view toggle. Category chips below.
 * Default view is list (Play Store-style rows); user can switch to a tile
 * grid for a more iconic browse.
 * ============================================================================ */
export default function AppsBrowsePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-64 items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <Browse />
    </Suspense>
  );
}

type SortMode = "fresh" | "alpha";
type View = "list" | "grid";

function Browse() {
  const search = useSearchParams();
  const categoryParam = search.get("category");
  const queryParam = search.get("q") || "";

  const [apps, setApps] = useState<AppSummary[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [q, setQ] = useState(queryParam);
  const [sort, setSort] = useState<SortMode>("fresh");
  const [view, setView] = useState<View>("list");
  const [activeCategory, setActiveCategory] = useState<string | null>(categoryParam);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      Promise.all([api.apps.list(q || undefined), api.categories.list()])
        .then(([a, c]) => {
          if (cancelled) return;
          setApps(a);
          setCategories(c);
        })
        .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Failed"))
        .finally(() => !cancelled && setLoading(false));
    }, q ? 220 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

  useEffect(() => setActiveCategory(categoryParam), [categoryParam]);

  const filtered = useMemo(() => {
    let list = apps;
    if (activeCategory) {
      list = list.filter((a) => a.categories.some((c) => c.name === activeCategory));
    }
    if (sort === "alpha") {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    } else {
      list = [...list].sort((a, b) => {
        const ta = a.last_published_at ? new Date(a.last_published_at).getTime() : 0;
        const tb = b.last_published_at ? new Date(b.last_published_at).getTime() : 0;
        return tb - ta;
      });
    }
    return list;
  }, [apps, activeCategory, sort]);

  const usedCategoryNames = useMemo(() => {
    const m = new Map<string, number>();
    apps.forEach((a) => a.categories.forEach((c) => {
      m.set(c.name, (m.get(c.name) || 0) + 1);
    }));
    return m;
  }, [apps]);
  const liveCategories = useMemo(
    () => categories.filter((c) => usedCategoryNames.has(c.name)),
    [categories, usedCategoryNames],
  );

  return (
    <div>
      {/* ──── Title ──── */}
      <header className="mb-6">
        <div className="eyebrow">Catalogue</div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-ink md:text-4xl">
          Browse apps
        </h1>
        <p className="mt-1 text-ink-mute">
          {apps.length} {apps.length === 1 ? "title" : "titles"} on the shelf
        </p>
      </header>

      {/* ──── Toolbar ──── */}
      <section className="mb-5 flex flex-col gap-3 md:flex-row md:items-center">
        <label className="flex flex-1 items-center gap-2 rounded-pill border border-outline-soft bg-surface-2 px-4 py-2.5 transition-colors focus-within:border-primary focus-within:bg-surface md:max-w-lg">
          <Search className="h-4 w-4 text-ink-mute" strokeWidth={2.2} />
          <input
            type="search"
            placeholder="Search by name or package…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-mute"
          />
        </label>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-pill border border-outline-soft bg-surface p-0.5">
            <Pill active={sort === "fresh"} onClick={() => setSort("fresh")}>
              Fresh
            </Pill>
            <Pill active={sort === "alpha"} onClick={() => setSort("alpha")}>
              A → Z
            </Pill>
          </div>
          <div className="flex items-center rounded-pill border border-outline-soft bg-surface p-0.5">
            <ViewPill active={view === "list"} onClick={() => setView("list")} label="List">
              <List className="h-3.5 w-3.5" strokeWidth={2.4} />
            </ViewPill>
            <ViewPill active={view === "grid"} onClick={() => setView("grid")} label="Grid">
              <LayoutGrid className="h-3.5 w-3.5" strokeWidth={2.4} />
            </ViewPill>
          </div>
        </div>
      </section>

      {/* ──── Category chips ──── */}
      {liveCategories.length > 0 && (
        <section className="mb-6">
          <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto pb-1">
            <button
              type="button"
              onClick={() => setActiveCategory(null)}
              className="chip"
              data-active={activeCategory === null}
            >
              All
              <span className="ml-1 font-mono text-[10px] text-ink-mute">{apps.length}</span>
            </button>
            {liveCategories.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setActiveCategory(c.name)}
                className="chip"
                data-active={activeCategory === c.name}
              >
                {c.name}
                <span className="ml-1 font-mono text-[10px] text-ink-mute">
                  {usedCategoryNames.get(c.name) || 0}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {error && (
        <p className="mb-4 rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">
          {error}
        </p>
      )}

      {/* ──── Results ──── */}
      <section>
        {loading ? (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="surface flex flex-col items-center gap-3 py-16 text-center">
            <div className="text-xl font-semibold tracking-tight text-ink">No matches</div>
            <p className="text-sm text-ink-soft">
              {q ? <>Try a different query.</> : <>Adjust the category or sort.</>}
            </p>
            {(q || activeCategory) && (
              <Button
                variant="outlined"
                size="md"
                onClick={() => { setQ(""); setActiveCategory(null); }}
              >
                Reset filters
              </Button>
            )}
          </div>
        ) : view === "grid" ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
            {filtered.map((app, i) => (
              <div
                key={app.id}
                className="animate-fade-up"
                style={{ animationDelay: `${Math.min(i * 20, 320)}ms` }}
              >
                <AppCard app={app} variant="tile" />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
            {filtered.map((app, i) => (
              <div
                key={app.id}
                className="animate-fade-up"
                style={{ animationDelay: `${Math.min(i * 20, 320)}ms` }}
              >
                <AppCard app={app} variant="list" />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────────── */
function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-8 rounded-pill px-3 text-xs font-semibold transition-colors",
        active
          ? "bg-primary-container text-primary-on-container"
          : "text-ink-soft hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function ViewPill({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-pill transition-colors",
        active
          ? "bg-primary-container text-primary-on-container"
          : "text-ink-soft hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function Skeleton() {
  return (
    <div className="flex items-center gap-3 rounded-xl p-2.5">
      <div className="h-14 w-14 animate-pulse rounded-2xl bg-surface-2" />
      <div className="flex-1 space-y-2">
        <div className="h-3 w-3/5 animate-pulse rounded-pill bg-surface-2" />
        <div className="h-2 w-2/5 animate-pulse rounded-pill bg-surface-2" />
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div className="h-7 w-7 animate-spin rounded-full border-2 border-outline-soft border-t-primary" role="status" aria-label="Loading" />
  );
}
