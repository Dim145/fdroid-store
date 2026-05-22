"use client";

import {
  BarChart3,
  Lock,
} from "lucide-react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AppIcon } from "@/components/app-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, type StatsPayload } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { cn, formatBytes, formatCount, formatDate } from "@/lib/utils";

/* ============================================================================
 * /stats — "Repo Almanac" treatment.
 *
 * The page reads like a single-page magazine spread: a masthead at the top,
 * a serif-display hero number (downloads, the lead metric), a tight ladder of
 * secondary KPIs to the right, then three thematic sections — a 30-day SVG
 * area chart, a ranked leaderboard with proportional download bars, and the
 * categories breakdown. Hairline rules between sections mimic newspaper
 * column dividers; eyebrows are mono-caps; numerals stick to tabular-nums so
 * vertical alignment reads cleanly down the page.
 *
 * Visibility rules (unchanged from the previous incarnation):
 *
 *   * Anonymous + repo public + public_stats ON  → public view (no private)
 *   * Anonymous + (private repo OR public_stats OFF) → backend 401, we show
 *     a "sign in to see" empty state
 *   * Authenticated non-admin → public view
 *   * Authenticated admin     → admin view (private apps included)
 * ============================================================================ */
export default function StatsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [data, setData] = useState<StatsPayload | null>(null);
  const [error, setError] = useState<"unauthorized" | "forbidden" | "other" | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .stats()
      .then((p) => { if (!cancelled) setData(p); })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "";
        if (/403|forbidden|administrator/i.test(msg)) setError("forbidden");
        else if (/401|unauth/i.test(msg)) setError("unauthorized");
        else setError("other");
      });
    return () => { cancelled = true; };
  }, []);

  if (error === "unauthorized") {
    return <UnauthorizedState />;
  }
  if (error === "forbidden") {
    return <ForbiddenState loggedIn={!!user} />;
  }
  if (error === "other") {
    return (
      <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">
        {t("stats.loadFailed")}
      </p>
    );
  }
  if (!data) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="relative pb-16">
      {/* Subtle paper-grain background. SVG fractal noise, low contrast, sits
          fixed under the page chrome so scrolling doesn't repaint it. Pure
          decoration — pointer-events-none so it never eats clicks. */}
      <GrainOverlay />

      <Masthead scope={data.scope} />
      <Lead data={data} />
      {/* Dividers are conditioned on the matching section actually
          rendering something — an empty top-apps list shouldn't leave
          a lonely "II · CLASSEMENT" hairline floating in the void. */}
      <SectionDivider label={t("stats.divider.activity")} />
      <DownloadsChart days={data.downloads_by_day} />
      {data.top_apps.length > 0 && (
        <>
          <SectionDivider label={t("stats.divider.leaderboard")} />
          <Leaderboard apps={data.top_apps} />
        </>
      )}
      {data.categories.some((c) => c.app_count > 0) && (
        <>
          <SectionDivider label={t("stats.divider.catalogue")} />
          <CategoriesBreakdown categories={data.categories} />
        </>
      )}
    </div>
  );
}

/* ============================================================================
 *                              CHROME PIECES
 * ============================================================================ */

/** Top masthead — fixed-typography "issue strip" that signals the editorial
 *  tone. ISO date on the right, admin chip when applicable. The motion
 *  ``initial → animate`` is a staggered slide-up so the page enters one
 *  layer at a time. */
function Masthead({ scope }: { scope: StatsPayload["scope"] }) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  const today = new Date().toISOString().slice(0, 10);
  return (
    <motion.header
      initial={reduce ? false : { opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }}
      className="mb-10 flex flex-wrap items-center justify-between gap-3 border-b border-outline-soft pb-3 font-mono text-[10px] uppercase tracking-[0.28em] text-ink-mute"
    >
      <div className="flex items-center gap-3">
        <span className="text-ink">{t("stats.masthead.publication")}</span>
        <span aria-hidden className="h-3 w-px bg-outline-soft" />
        <span>{t("stats.masthead.edition")}</span>
        {scope === "admin" && (
          <>
            <span aria-hidden className="h-3 w-px bg-outline-soft" />
            <Badge variant="accent" className="!text-[9px] tracking-[0.28em]">
              {t("stats.adminScope")}
            </Badge>
          </>
        )}
      </div>
      <span className="tabular-nums text-ink-soft">{today}</span>
    </motion.header>
  );
}

/** Big, magazine-style horizontal rule with a quiet label dropped into the
 *  middle. Sits between thematic sections so the page reads as separate
 *  spreads. */
function SectionDivider({ label }: { label: string }) {
  return (
    <div className="my-10 flex items-center gap-4 font-mono text-[10px] uppercase tracking-[0.32em] text-ink-mute">
      <span className="h-px flex-1 bg-outline-soft" aria-hidden />
      <span>{label}</span>
      <span className="h-px flex-1 bg-outline-soft" aria-hidden />
    </div>
  );
}

/* ============================================================================
 *                                  LEAD
 * ============================================================================ */

/** Lead spread: hero downloads number + 4 sidekick KPIs.
 *
 *  The downloads number renders in a variable serif at near-page-width.
 *  Empty repos show "0" with the same gravity — the layout never collapses,
 *  the page just feels honest about being new.
 */
function Lead({ data }: { data: StatsPayload }) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  return (
    <section className="relative">
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08, duration: 0.55, ease: [0.2, 0.8, 0.2, 1] }}
      >
        <div className="font-mono text-[10px] uppercase tracking-[0.32em] text-ink-mute">
          {t("stats.eyebrow")}
        </div>
        <h1 className="mt-2 font-display text-[clamp(3rem,8vw,6rem)] font-medium leading-[0.92] tracking-tight text-ink">
          {t("stats.title")}
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-soft">
          {data.scope === "admin" ? t("stats.subtitleAdmin") : t("stats.subtitlePublic")}
        </p>
      </motion.div>

      <div className="mt-12 grid gap-10 md:grid-cols-[1.4fr_1fr] md:items-end">
        {/* ── Hero number ── */}
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.18, duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
          className="relative"
        >
          <div className="font-mono text-[10px] uppercase tracking-[0.32em] text-ink-mute">
            {t("stats.lead.label")}
          </div>
          <div className="mt-1 font-display font-medium leading-[0.88] tracking-tight">
            <CountUp
              value={data.totals.downloads}
              className="block text-[clamp(5rem,18vw,12rem)] text-primary"
              fmt={formatCount}
            />
          </div>
          <div className="mt-2 font-mono text-[11px] uppercase tracking-[0.24em] text-ink-mute">
            {t("stats.lead.windowAllTime")}
          </div>
        </motion.div>

        {/* ── KPI ladder ── */}
        <motion.dl
          initial={reduce ? false : { opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.32, duration: 0.55, ease: [0.2, 0.8, 0.2, 1] }}
          className="divide-y divide-outline-soft border-y border-outline-soft"
        >
          <KpiRow label={t("stats.totals.apps")} value={formatCount(data.totals.apps)} />
          <KpiRow label={t("stats.totals.apks")} value={formatCount(data.totals.apks_published)} />
          <KpiRow label={t("stats.totals.storage")} value={formatBytes(data.totals.bytes_published)} />
          <KpiRow label={t("stats.totals.users")} value={formatCount(data.totals.active_users)} />
        </motion.dl>
      </div>
    </section>
  );
}

function KpiRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3">
      <dt className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-mute">
        {label}
      </dt>
      <dd className="font-display text-2xl font-medium tabular-nums tracking-tight text-ink md:text-3xl">
        {value}
      </dd>
    </div>
  );
}

/** Count-up motion on the hero number. ``useMotionValue`` + ``useTransform``
 *  drives the rendered text — cheaper than re-rendering the parent every
 *  frame, and the spring config lets us land softly on the final integer.
 *
 *  Respects ``prefers-reduced-motion``: with it on, we render the final
 *  value immediately and skip the animation.
 */
function CountUp({
  value,
  className,
  fmt,
  duration = 1.2,
}: {
  value: number;
  className?: string;
  fmt: (n: number) => string;
  duration?: number;
}) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(reduce ? value : 0);
  const display = useTransform(mv, (n) => fmt(Math.round(n)));
  useEffect(() => {
    if (reduce) {
      mv.set(value);
      return;
    }
    const controls = animate(mv, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
    });
    return () => controls.stop();
  }, [value, duration, mv, reduce]);
  return <motion.span className={className}>{display}</motion.span>;
}

/* ============================================================================
 *                              DOWNLOADS CHART
 * ============================================================================ */

/** 30-day downloads as an SVG area chart. The path itself draws in via a
 *  stroke-dashoffset transition on mount; the area underneath fades in a
 *  beat later. Grid lines + axis labels keep the chart legible even on a
 *  near-empty repo (which our small-instance test environment is). */
function DownloadsChart({ days }: { days: StatsPayload["downloads_by_day"] }) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();

  const filled = useMemo(() => {
    const out: { date: string; count: number }[] = [];
    const map = new Map(days.map((d) => [d.date, d.count]));
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const iso = d.toISOString().slice(0, 10);
      out.push({ date: iso, count: map.get(iso) ?? 0 });
    }
    return out;
  }, [days]);

  const max = Math.max(1, ...filled.map((d) => d.count));
  const total = filled.reduce((s, d) => s + d.count, 0);
  const peak = filled.reduce((p, d) => (d.count > p.count ? d : p), filled[0]);
  const avg = Math.round(total / Math.max(1, filled.length));

  // SVG viewbox: 600 × 200, last point right-edge, first point left-edge.
  // We always render to that virtual size and let CSS handle the responsive
  // width; the lineWidth stays crisp under any DPR because vector.
  const W = 600;
  const H = 200;
  const PAD_T = 12;
  const PAD_B = 24;
  const points = filled.map((d, i) => {
    const x = (i / (filled.length - 1)) * W;
    const y = PAD_T + (1 - d.count / max) * (H - PAD_T - PAD_B);
    return { x, y, ...d };
  });
  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(" ");
  const areaPath = `${linePath} L${W},${H - PAD_B} L0,${H - PAD_B} Z`;

  // Gridlines at 25/50/75% of the chart height; baseline at 100%.
  const grid = [0.25, 0.5, 0.75].map(
    (frac) => PAD_T + frac * (H - PAD_T - PAD_B),
  );

  // Hover state: which day index is the cursor over? null = no readout.
  const [hover, setHover] = useState<number | null>(null);
  const focusDay = hover != null ? filled[hover] : null;

  return (
    <motion.section
      initial={reduce ? false : { opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.55, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-ink-mute">
            {t("stats.downloadsEyebrow")}
          </div>
          <h2 className="mt-1 font-display text-3xl font-medium tracking-tight text-ink md:text-4xl">
            {t("stats.downloadsTitle")}
          </h2>
        </div>
        <div className="flex flex-wrap items-end gap-8 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-mute">
          <Stat dt={t("stats.downloadsTotal30")} dd={formatCount(total)} />
          <Stat dt={t("stats.chart.peak")} dd={formatCount(peak?.count ?? 0)} />
          <Stat dt={t("stats.chart.avg")} dd={formatCount(avg)} />
        </div>
      </header>

      <div className="relative mt-6">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block h-56 w-full md:h-64"
          role="img"
          aria-label={t("stats.downloadsTitle")}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const rel = (e.clientX - rect.left) / rect.width;
            const i = Math.round(rel * (points.length - 1));
            setHover(Math.max(0, Math.min(points.length - 1, i)));
          }}
        >
          {/* Gridlines */}
          {grid.map((y) => (
            <line
              key={y}
              x1={0}
              x2={W}
              y1={y}
              y2={y}
              stroke="rgb(var(--outline-soft))"
              strokeDasharray="2 4"
              strokeWidth={0.5}
            />
          ))}
          {/* Baseline */}
          <line
            x1={0}
            x2={W}
            y1={H - PAD_B}
            y2={H - PAD_B}
            stroke="rgb(var(--outline-soft))"
            strokeWidth={1}
          />
          {/* Area fill — fades in after the stroke. */}
          <motion.path
            d={areaPath}
            fill="rgb(var(--primary) / 0.14)"
            initial={reduce ? false : { opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 0.5, duration: 0.5 }}
          />
          {/* Line stroke — drawn with pathLength so the line "writes
              itself" left → right. */}
          <motion.path
            d={linePath}
            fill="none"
            stroke="rgb(var(--primary))"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={reduce ? false : { pathLength: 0 }}
            whileInView={{ pathLength: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }}
          />
          {/* Hover cursor — a vertical hairline + the active dot. */}
          {focusDay && hover != null && (
            <g pointerEvents="none">
              <line
                x1={points[hover].x}
                x2={points[hover].x}
                y1={PAD_T - 2}
                y2={H - PAD_B}
                stroke="rgb(var(--ink))"
                strokeWidth={0.5}
                strokeDasharray="2 3"
              />
              <circle
                cx={points[hover].x}
                cy={points[hover].y}
                r={4}
                fill="rgb(var(--primary))"
                stroke="rgb(var(--bg))"
                strokeWidth={2}
              />
            </g>
          )}
        </svg>

        {/* Hover read-out — anchored to the top-right of the chart so it
            doesn't reflow the layout as the cursor moves. */}
        <div
          aria-hidden={!focusDay}
          className={cn(
            "pointer-events-none absolute right-0 top-0 rounded-xl border border-outline-soft bg-surface px-3 py-2 text-xs text-ink shadow-e1 transition-opacity",
            focusDay ? "opacity-100" : "opacity-0",
          )}
        >
          {focusDay && (
            <>
              <div className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                {formatDate(focusDay.date)}
              </div>
              <div className="mt-0.5 font-display text-lg font-medium tabular-nums leading-none">
                {formatCount(focusDay.count)}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-ink-mute">
        <span>{formatDate(filled[0]?.date ?? "")}</span>
        <span>{t("stats.today")}</span>
      </div>
    </motion.section>
  );
}

function Stat({ dt, dd }: { dt: string; dd: string }) {
  return (
    <div>
      <div className="text-ink-mute">{dt}</div>
      <div className="mt-0.5 font-display text-xl font-medium tabular-nums tracking-tight text-ink md:text-2xl">
        {dd}
      </div>
    </div>
  );
}

/* ============================================================================
 *                              LEADERBOARD
 * ============================================================================ */

/** Ranked apps with proportional download bars. The bar widths animate from
 *  0 → final % on mount, staggered per row, so the eye reads the order as
 *  the race is being run. */
function Leaderboard({ apps }: { apps: StatsPayload["top_apps"] }) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  if (apps.length === 0) return null;
  const max = Math.max(1, ...apps.map((a) => a.download_count));

  return (
    <motion.section
      initial={reduce ? false : { opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <header className="mb-6">
        <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-ink-mute">
          {t("stats.topAppsEyebrow")}
        </div>
        <h2 className="mt-1 font-display text-3xl font-medium tracking-tight text-ink md:text-4xl">
          {t("stats.topAppsTitle")}
        </h2>
      </header>
      <ol>
        {apps.map((a, i) => {
          const pct = (a.download_count / max) * 100;
          return (
            <li
              key={a.id}
              className={cn(
                "border-t border-outline-soft",
                i === apps.length - 1 && "border-b",
              )}
            >
              <Link
                href={`/apps/${encodeURIComponent(a.package_name)}`}
                className="group relative flex items-center gap-5 py-4 transition-colors hover:bg-surface-2"
              >
                {/* Animated bar fill — sits behind the row, fades back when
                    the row is hovered so the foreground content stays
                    legible. */}
                <motion.div
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 left-0 origin-left bg-primary/10 transition-colors group-hover:bg-primary/15"
                  initial={reduce ? false : { scaleX: 0 }}
                  whileInView={{ scaleX: pct / 100 }}
                  viewport={{ once: true, margin: "-40px" }}
                  transition={{ delay: 0.1 + i * 0.06, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                  style={{ width: "100%" }}
                />
                <span className="relative w-10 shrink-0 font-display text-3xl font-medium leading-none tabular-nums text-ink-mute group-hover:text-primary">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <AppIcon
                  iconPath={a.icon_path}
                  name={a.name}
                  size={44}
                  version={a.updated_at ?? undefined}
                  className="relative shrink-0"
                />
                <div className="relative min-w-0 flex-1">
                  <div className="truncate text-base font-semibold leading-tight text-ink group-hover:text-primary">
                    {a.name}
                  </div>
                  <div className="truncate font-mono text-[11px] text-ink-mute">
                    {a.package_name}
                  </div>
                </div>
                <div className="relative text-right">
                  <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
                    {t("stats.downloadsLabel")}
                  </div>
                  <div className="mt-0.5 font-display text-xl font-medium tabular-nums leading-none text-ink md:text-2xl">
                    {formatCount(a.download_count)}
                  </div>
                </div>
              </Link>
            </li>
          );
        })}
      </ol>
    </motion.section>
  );
}

/* ============================================================================
 *                            CATEGORIES BREAKDOWN
 * ============================================================================ */

function CategoriesBreakdown({ categories }: { categories: StatsPayload["categories"] }) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  const visible = categories.filter((c) => c.app_count > 0);
  if (visible.length === 0) return null;
  const max = Math.max(1, ...visible.map((c) => c.app_count));

  return (
    <motion.section
      initial={reduce ? false : { opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <header className="mb-6 flex items-end justify-between gap-6">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-ink-mute">
            {t("stats.categoriesEyebrow")}
          </div>
          <h2 className="mt-1 font-display text-3xl font-medium tracking-tight text-ink md:text-4xl">
            {t("stats.categoriesTitle")}
          </h2>
        </div>
        <BarChart3 className="hidden h-6 w-6 text-ink-mute md:block" strokeWidth={1.5} />
      </header>
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {visible.map((c, i) => {
          const pct = (c.app_count / max) * 100;
          return (
            <li key={c.id} className="flex items-baseline gap-4">
              <span className="w-28 shrink-0 truncate text-sm font-medium text-ink">
                {c.name}
              </span>
              <div className="relative h-px flex-1 bg-outline-soft">
                {/* The fill is a 2px band sitting on the hairline so it
                    visually overflows below — keeps the row feeling like
                    a print rule, not a chunky progress bar. */}
                <motion.div
                  aria-hidden
                  className="absolute -bottom-px h-[2px] origin-left bg-primary"
                  initial={reduce ? false : { scaleX: 0 }}
                  whileInView={{ scaleX: pct / 100 }}
                  viewport={{ once: true, margin: "-40px" }}
                  transition={{ delay: 0.05 + i * 0.04, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                  style={{ width: "100%" }}
                />
              </div>
              <span className="w-10 shrink-0 text-right font-display text-base font-medium tabular-nums text-ink">
                {c.app_count}
              </span>
            </li>
          );
        })}
      </ul>
    </motion.section>
  );
}

/* ============================================================================
 *                              EMPTY / DECOR
 * ============================================================================ */

/** Decorative paper grain. Inlined SVG with ``feTurbulence`` — no asset
 *  request, no separate <img>. Sits fixed under the chrome at very low
 *  opacity so the dark background gets that "newsprint on a dark press"
 *  texture without ever distracting. Pointer events are off; aria-hidden
 *  removes it from the a11y tree.
 */
function GrainOverlay() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 opacity-[0.06] mix-blend-overlay"
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.7 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
        backgroundSize: "160px 160px",
      }}
    />
  );
}

function UnauthorizedState() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-2xl rounded-3xl border border-outline-soft bg-surface p-10 text-center">
      <Lock className="mx-auto h-8 w-8 text-ink-mute" strokeWidth={1.8} />
      <h1 className="mt-4 font-display text-3xl font-medium tracking-tight text-ink">
        {t("stats.gatedTitle")}
      </h1>
      <p className="mt-2 text-sm text-ink-soft">{t("stats.gatedBody")}</p>
      <div className="mt-6">
        <Button asChild variant="filled">
          <Link href="/login?next=%2Fstats">{t("stats.signIn")}</Link>
        </Button>
      </div>
    </div>
  );
}

function ForbiddenState({ loggedIn }: { loggedIn: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-2xl rounded-3xl border border-outline-soft bg-surface p-10 text-center">
      <Lock className="mx-auto h-8 w-8 text-ink-mute" strokeWidth={1.8} />
      <h1 className="mt-4 font-display text-3xl font-medium tracking-tight text-ink">
        {t("stats.adminOnlyTitle")}
      </h1>
      <p className="mt-2 text-sm text-ink-soft">{t("stats.adminOnlyBody")}</p>
      {!loggedIn && (
        <div className="mt-6">
          <Button asChild variant="filled">
            <Link href="/login?next=%2Fstats">{t("stats.signIn")}</Link>
          </Button>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <div
      className="h-6 w-6 animate-spin rounded-full border-2 border-outline-soft border-t-primary"
      role="status"
      aria-label="Loading"
    />
  );
}
