"use client";

import {
  Activity,
  ChevronRight,
  Cpu,
  Hash,
  RefreshCw,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { api, type JobsSnapshot } from "@/lib/api";
import { toast } from "@/lib/toast-store";
import { cn, formatDate } from "@/lib/utils";


type RunRow = JobsSnapshot["recent"][number];


/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function AdminJobsPage() {
  const { t } = useTranslation();
  const [snap, setSnap] = useState<JobsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  // Live "now" tick — drives the UTC clock + the relative timestamps on
  // each run row so the timecodes keep advancing between backend polls.
  const [now, setNow] = useState(() => Date.now());

  async function reload() {
    setLoading(true);
    try {
      setSnap(await api.admin.jobs());
    } catch (e) {
      toast.error(t("admin.jobs.loadFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
  }

  async function triggerReindex() {
    try {
      await api.admin.reindex();
      toast.success(t("admin.jobs.reindexQueued"));
      // Let arq register the new job before we snapshot again.
      window.setTimeout(reload, 600);
    } catch (e) {
      toast.error(t("admin.jobs.reindexFailed"), e instanceof Error ? e.message : undefined);
    }
  }

  // Initial load.
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-poll the backend every 10 s. Suspended when the operator hits
  // pause — useful when inspecting a specific row.
  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(reload, 10000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  // Once-a-second tick for the mission clock + relative time stamps.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // The backend hands us ``recent`` already reversed, but arq's result
  // keys carry a random suffix so the order isn't strictly chronological.
  // Re-sort client-side by finish_time, falling back to start_time.
  const runs = useMemo(() => {
    const rows = [...(snap?.recent ?? [])];
    rows.sort((a, b) => stampOf(b) - stampOf(a));
    return rows;
  }, [snap?.recent]);

  // Throughput in the last 5 minutes — a quick "is anything happening"
  // signal that's more useful than the raw run count.
  const recentWindow = useMemo(() => {
    const cutoff = now - 5 * 60 * 1000;
    let ok = 0;
    let fail = 0;
    for (const r of runs) {
      const ts = stampOf(r);
      if (ts > cutoff) {
        const v = visualStatus(r);
        if (v === "ok") ok += 1;
        else if (v === "fail") fail += 1;
      }
    }
    return { ok, fail, total: ok + fail };
  }, [runs, now]);

  return (
    <div className="relative space-y-7 pb-12">
      {/* Calibration-screen crosshatch. Unique to this page — a 14 px
          tile of 1 px lines at ±45°, very low opacity so the content
          still dominates. Fixed so it doesn't scroll with the page. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 opacity-[0.035]"
        style={{
          backgroundImage: [
            "linear-gradient(45deg, rgb(var(--ink)) 0 1px, transparent 1px 14px)",
            "linear-gradient(-45deg, rgb(var(--ink)) 0 1px, transparent 1px 14px)",
          ].join(", "),
          backgroundSize: "14px 14px",
        }}
      />

      <Hero
        clock={fmtUtcClock(new Date(now))}
        available={snap?.available ?? false}
        loading={loading}
        paused={paused}
        onTogglePause={() => setPaused((p) => !p)}
        onRefresh={reload}
        onReindex={triggerReindex}
      />

      {!snap?.available && (
        <div className="rounded-2xl border border-danger/40 bg-danger-container/40 px-4 py-3 text-sm text-danger-on-container animate-fade-up">
          {t("admin.jobs.unavailable")}
          {snap?.error ? ` — ${snap.error}` : ""}
        </div>
      )}

      <Telemetry
        queued={snap?.queued ?? 0}
        inProgress={snap?.in_progress ?? 0}
        recent={recentWindow}
      />

      <Log runs={runs} observedAt={snap?.observed_at} now={now} loading={loading && !snap} />
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Hero — mission-control header                                              */
/* -------------------------------------------------------------------------- */

function Hero({
  clock,
  available,
  loading,
  paused,
  onTogglePause,
  onRefresh,
  onReindex,
}: {
  clock: string;
  available: boolean;
  loading: boolean;
  paused: boolean;
  onTogglePause: () => void;
  onRefresh: () => void;
  onReindex: () => void;
}) {
  const { t } = useTranslation();
  return (
    <header className="relative overflow-hidden rounded-3xl border border-outline-soft bg-surface px-6 py-7 md:px-10 md:py-9 animate-fade-up">
      {/* Slow primary-tint wash in the corner — the only chromatic accent
          in the header, so the mono numbers feel scientific. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 80% at 0% 0%, rgb(var(--primary) / 0.10), transparent 65%)",
        }}
      />
      <div className="relative flex flex-wrap items-end justify-between gap-6">
        <div className="min-w-0">
          <div className="eyebrow">{t("admin.eyebrow")}</div>
          <h1 className="mt-2 text-4xl font-bold tracking-tight text-ink md:text-5xl">
            {t("admin.jobs.title")}
          </h1>
          <p className="mt-2 max-w-prose text-ink-soft">{t("admin.jobs.subtitle")}</p>
        </div>
        <div className="flex flex-col items-end gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <HealthPill available={available} />
            <AutoRefreshToggle paused={paused} onToggle={onTogglePause} />
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute tabular-nums">
              {clock}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outlined" size="sm" onClick={onRefresh} disabled={loading}>
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              {t("admin.jobs.refresh")}
            </Button>
            <Button variant="filled" size="sm" onClick={onReindex}>
              <Activity className="h-3.5 w-3.5" />
              {t("admin.jobs.triggerReindex")}
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}


/** Page-level auto-refresh toggle. Lives in the status row next to the
 *  HealthPill — visually a sibling of "Redis link", which makes it read
 *  as a *page display setting* (this polls the API every 10 s) rather
 *  than an action button. The previous "Pause" label was misread as a
 *  worker-pause control, which it never was. */
function AutoRefreshToggle({ paused, onToggle }: { paused: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const active = !paused;
  return (
    <button
      type="button"
      onClick={onToggle}
      title={t("admin.jobs.autoRefreshTitle")}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
        active
          ? "border-primary/30 bg-primary-container/40 text-primary-on-container hover:border-primary/60"
          : "border-outline-soft bg-surface-2 text-ink-soft hover:border-outline hover:text-ink",
      )}
    >
      <span className="relative flex h-1.5 w-1.5">
        {active && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-pill bg-primary opacity-60" />
        )}
        <span
          className={cn(
            "relative inline-flex h-1.5 w-1.5 rounded-pill",
            active ? "bg-primary" : "bg-ink-mute",
          )}
        />
      </span>
      {active
        ? t("admin.jobs.autoRefreshOn")
        : t("admin.jobs.autoRefreshOff")}
    </button>
  );
}


function HealthPill({ available }: { available: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider",
        available
          ? "bg-primary-container/50 text-primary-on-container"
          : "bg-danger-container/50 text-danger-on-container",
      )}
    >
      <span className="relative flex h-1.5 w-1.5">
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-pill opacity-75",
            available ? "bg-primary" : "bg-danger",
          )}
        />
        <span
          className={cn(
            "relative inline-flex h-1.5 w-1.5 rounded-pill",
            available ? "bg-primary" : "bg-danger",
          )}
        />
      </span>
      {available ? t("admin.jobs.linkOk") : t("admin.jobs.linkDown")}
    </span>
  );
}


/* -------------------------------------------------------------------------- */
/*  Telemetry strip                                                            */
/* -------------------------------------------------------------------------- */

function Telemetry({
  queued,
  inProgress,
  recent,
}: {
  queued: number;
  inProgress: number;
  recent: { ok: number; fail: number; total: number };
}) {
  const { t } = useTranslation();
  return (
    <section className="grid gap-3 md:grid-cols-3">
      <TelemetryCard
        eyebrow={t("admin.jobs.queued")}
        value={queued}
        tone="neutral"
        icon={<Hash className="h-3.5 w-3.5" />}
        sub={queued > 0 ? t("admin.jobs.queuedSub") : t("admin.jobs.queuedEmpty")}
        delay={0}
      />
      <TelemetryCard
        eyebrow={t("admin.jobs.inProgress")}
        value={inProgress}
        tone={inProgress > 0 ? "live" : "neutral"}
        icon={<Cpu className="h-3.5 w-3.5" />}
        sub={inProgress > 0 ? t("admin.jobs.inProgressSub") : t("admin.jobs.idle")}
        delay={80}
      />
      <TelemetryCard
        eyebrow={t("admin.jobs.throughput")}
        value={recent.total}
        tone={recent.fail > 0 ? "warn" : "neutral"}
        icon={<Zap className="h-3.5 w-3.5" />}
        sub={
          recent.total > 0
            ? t("admin.jobs.throughputBreak", { ok: recent.ok, fail: recent.fail })
            : t("admin.jobs.throughputEmpty")
        }
        delay={160}
      />
    </section>
  );
}


function TelemetryCard({
  eyebrow,
  value,
  tone,
  icon,
  sub,
  delay,
}: {
  eyebrow: string;
  value: number;
  tone: "neutral" | "live" | "warn";
  icon: React.ReactNode;
  sub: string;
  delay: number;
}) {
  // Tween from previous value to current. Pinning the start point with a
  // ref means the animation runs every time the number changes, not just
  // on first paint.
  const [display, setDisplay] = useState(value);
  const prev = useRef(value);
  useEffect(() => {
    const from = prev.current;
    const to = value;
    if (from === to) return;
    const start = performance.now();
    const dur = 600;
    const frame = (n: number) => {
      const k = Math.min(1, (n - start) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      setDisplay(Math.round(from + (to - from) * e));
      if (k < 1) requestAnimationFrame(frame);
      else prev.current = to;
    };
    requestAnimationFrame(frame);
  }, [value]);

  return (
    <div
      className="relative overflow-hidden rounded-3xl border border-outline-soft bg-surface p-5 shadow-e1 animate-fade-up"
      style={{ animationDelay: `${delay}ms` }}
    >
      {/* Top sweep — a slow primary-tinted bar that walks across the
          card's top edge. Felt right for "telemetry incoming". */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden">
        <div
          className="h-full w-1/3 animate-telemetry-sweep"
          style={{
            background:
              tone === "live"
                ? "linear-gradient(90deg, transparent, rgb(var(--primary)), transparent)"
                : tone === "warn"
                  ? "linear-gradient(90deg, transparent, rgb(var(--danger)), transparent)"
                  : "linear-gradient(90deg, transparent, rgb(var(--ink) / 0.4), transparent)",
          }}
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-pill",
              tone === "live"
                ? "bg-primary-container text-primary-on-container"
                : tone === "warn"
                  ? "bg-danger-container/60 text-danger-on-container"
                  : "bg-surface-2 text-ink-soft",
            )}
          >
            {icon}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
            {eyebrow}
          </span>
        </div>
        {tone === "live" && (
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-primary">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-pill bg-primary opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-pill bg-primary" />
            </span>
            LIVE
          </span>
        )}
      </div>

      <div className="nums-no-slash mt-2 text-5xl font-bold tabular-nums tracking-tight text-ink">
        {display}
      </div>
      <div className="mt-1 text-xs text-ink-mute">{sub}</div>
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Run log                                                                    */
/* -------------------------------------------------------------------------- */

function Log({
  runs,
  observedAt,
  now,
  loading,
}: {
  runs: RunRow[];
  observedAt?: number;
  now: number;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<string | null>(null);

  // Functions present in the current snapshot — drives the filter pill
  // row. Stable order so the chips don't reshuffle on every poll.
  const functions = useMemo(() => {
    const set = new Set<string>();
    for (const r of runs) if (r.function) set.add(r.function);
    return Array.from(set).sort();
  }, [runs]);
  const filtered = filter ? runs.filter((r) => r.function === filter) : runs;

  return (
    <section className="surface relative overflow-hidden p-6 animate-fade-up" style={{ animationDelay: "240ms" }}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-mute">
            {t("admin.jobs.logEyebrow")}
          </div>
          <h2 className="mt-1 text-xl font-bold tracking-tight text-ink">
            {t("admin.jobs.recent")}
          </h2>
        </div>
        {functions.length > 1 && (
          <div className="flex flex-wrap items-center gap-1">
            <FilterPill active={filter === null} onClick={() => setFilter(null)}>
              {t("admin.jobs.allFunctions")}
            </FilterPill>
            {functions.map((f) => (
              <FilterPill key={f} active={filter === f} onClick={() => setFilter(f)}>
                {f}
              </FilterPill>
            ))}
          </div>
        )}
      </div>

      <ul className="mt-4 space-y-1.5">
        {loading && filtered.length === 0 && <SkeletonLog />}
        {!loading && filtered.length === 0 && (
          <li className="rounded-2xl border border-dashed border-outline px-4 py-10 text-center italic text-ink-mute">
            {filter ? t("admin.jobs.noMatch", { fn: filter }) : t("admin.jobs.noRecent")}
          </li>
        )}
        {filtered.map((r, i) => (
          <LogRow
            key={`${stampOf(r)}-${r.function ?? r.raw_key ?? i}`}
            run={r}
            now={now}
            index={i}
          />
        ))}
      </ul>

      {observedAt && (
        <p className="mt-5 border-t border-outline-soft pt-3 font-mono text-[10px] uppercase tracking-wider text-ink-mute">
          {t("admin.jobs.observed", {
            when: formatDate(new Date(observedAt * 1000).toISOString()),
          })}
        </p>
      )}
    </section>
  );
}


function FilterPill({
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
        "rounded-pill px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
        active
          ? "bg-primary text-primary-fg"
          : "bg-surface-2 text-ink-soft hover:bg-surface hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}


function LogRow({
  run,
  now,
  index,
}: {
  run: RunRow;
  now: number;
  index: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ts = stampOf(run);
  const verdict = visualStatus(run);
  const fail = verdict === "fail";

  return (
    <li
      className={cn(
        "group overflow-hidden rounded-2xl border bg-surface transition-colors animate-fade-up",
        fail ? "border-danger/30" : "border-outline-soft",
      )}
      style={{ animationDelay: `${Math.min(index * 25, 400)}ms` }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
      >
        <StatusLed verdict={verdict} />
        <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-wider tabular-nums text-ink-mute">
          {ts ? fmtRel(now, ts) : "—"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-sm text-ink">
            {run.function || run.raw_key || "?"}
          </span>
          {run.result_str && (
            <span className="block truncate text-[11px] text-ink-mute">{run.result_str}</span>
          )}
        </span>
        <span className="hidden w-16 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-mute md:block">
          {run.duration_ms != null ? fmtDuration(run.duration_ms) : "—"}
        </span>
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-ink-mute transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="space-y-2 border-t border-outline-soft bg-surface-2 px-4 py-3 animate-slide-down">
          <DetailRow label={t("admin.jobs.detail.function")} value={run.function ?? run.raw_key ?? "—"} mono />
          <DetailRow
            label={t("admin.jobs.detail.status")}
            value={
              verdict === "ok"
                ? t("admin.jobs.ok")
                : verdict === "fail"
                  ? t("admin.jobs.fail")
                  : "?"
            }
          />
          <DetailRow
            label={t("admin.jobs.detail.start")}
            value={run.start_time ? formatDate(run.start_time) : "—"}
            mono
          />
          <DetailRow
            label={t("admin.jobs.detail.finish")}
            value={run.finish_time ? formatDate(run.finish_time) : "—"}
            mono
          />
          <DetailRow
            label={t("admin.jobs.detail.duration")}
            value={run.duration_ms != null ? `${run.duration_ms.toLocaleString()} ms` : "—"}
            mono
          />
          {run.result_str && (
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                {t("admin.jobs.detail.result")}
              </div>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-xl border border-outline-soft bg-surface p-3 font-mono text-[11px] text-ink-soft">
                {run.result_str}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}


function StatusLed({ verdict }: { verdict: "ok" | "fail" | "unknown" }) {
  if (verdict === "ok") {
    return (
      <span aria-label="success" className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
        <span className="absolute inset-[-3px] rounded-full bg-primary/25 blur-[3px]" />
        <span className="relative h-2 w-2 rounded-full bg-primary" />
      </span>
    );
  }
  if (verdict === "fail") {
    return (
      <span aria-label="failure" className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
        <span className="absolute inset-[-3px] animate-pulse rounded-full bg-danger/35 blur-[3px]" />
        <span className="relative h-2 w-2 rounded-full bg-danger" />
      </span>
    );
  }
  return <span aria-label="unknown" className="h-2 w-2 shrink-0 rounded-full bg-ink-mute/40" />;
}


/** Visual verdict for a run row. arq considers a job successful as long
 *  as it didn't raise — but worker functions like ``fetch_github_source``
 *  catch their own errors and return ``{"status": "error", ...}`` so the
 *  source row keeps a clean record of the failure. We inspect the result
 *  payload for that convention and downgrade the LED accordingly. */
function visualStatus(run: RunRow): "ok" | "fail" | "unknown" {
  if (run.success === false) return "fail";
  if (run.result_str && /["']status["']\s*:\s*["']error["']/i.test(run.result_str)) {
    return "fail";
  }
  if (run.success === true) return "ok";
  return "unknown";
}


function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2">
      <div className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">{label}</div>
      <div className={cn("text-xs text-ink-soft", mono && "font-mono")}>{value}</div>
    </div>
  );
}


function SkeletonLog() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <li
          key={i}
          className="h-12 animate-pulse rounded-2xl border border-outline-soft bg-surface-2"
          style={{ animationDelay: `${i * 60}ms` }}
        />
      ))}
    </>
  );
}


/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function stampOf(r: RunRow): number {
  const s = r.finish_time ?? r.start_time;
  return s ? new Date(s).getTime() : 0;
}


function fmtRel(now: number, ts: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 5) return "T-0s";
  if (s < 60) return `T-${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `T-${m}m${s % 60}s` : `T-${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `T-${h}h${m % 60}m` : `T-${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `T-${d}d${h % 24}h` : `T-${d}d`;
}


function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}


function fmtUtcClock(d: Date): string {
  const h = d.getUTCHours().toString().padStart(2, "0");
  const m = d.getUTCMinutes().toString().padStart(2, "0");
  const s = d.getUTCSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s} UTC`;
}
