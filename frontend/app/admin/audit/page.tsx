"use client";

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Filter,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type AuditLogEntry } from "@/lib/api";
import { toast } from "@/lib/toast-store";
import { cn } from "@/lib/utils";


const PAGE_SIZE = 50;

type ActionColor = "primary" | "accent" | "danger" | "mute";

/** Action prefix → palette. The page colours every dot, chip, and rail
 *  segment off this mapping so the audit feed reads at a glance. */
function colorForAction(action: string): ActionColor {
  if (action.startsWith("clamav.")) return "danger";
  if (action.startsWith("repo.") || action.startsWith("user.")) return "primary";
  if (action.startsWith("app.") || action.startsWith("apk.")) return "accent";
  return "mute";
}

/** True when the action represents a destructive operation. The rail
 *  dot gets a small red halo for these so admins can scan for "what
 *  got nuked" without reading every line. */
function isDestructive(action: string): boolean {
  return (
    action.endsWith(".deleted") ||
    action.endsWith(".rejected") ||
    action.endsWith(".removed") ||
    action.endsWith(".revoked")
  );
}


/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function AdminAuditPage() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<AuditLogEntry[] | null>(null);
  const [total, setTotal] = useState(0);

  // Filter state (we keep the input separate from the applied filter
  // so live typing doesn't paginate the backend on every keystroke).
  const [searchInput, setSearchInput] = useState("");
  const [appliedAction, setAppliedAction] = useState("");
  const [targetType, setTargetType] = useState<string>("");
  const [page, setPage] = useState(0);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    try {
      const data = await api.admin.auditLog({
        action: appliedAction || undefined,
        target_type: targetType || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setRows(data.items);
      setTotal(data.total);
    } catch (e) {
      toast.error(t("admin.audit.loadFailed"), e instanceof Error ? e.message : undefined);
    }
  }, [appliedAction, targetType, page, t]);

  useEffect(() => { void reload(); }, [reload]);

  // --- Derived stats (computed off the current page slice — close
  // enough for the "what's been happening lately" eyeball) ---------
  const stats = useMemo(() => {
    const items = rows ?? [];
    const now = new Date();
    const todayKey = ymd(now);
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const today = items.filter((r) => ymd(new Date(r.created_at)) === todayKey).length;
    const week = items.filter((r) => new Date(r.created_at) >= weekAgo).length;
    const actors = new Set(items.map((r) => r.actor_id).filter(Boolean) as string[]);
    return { total, today, week, actors: actors.size };
  }, [rows, total]);

  // Available target_type chip values pulled from the visible slice.
  const availableTypes = useMemo(() => {
    const set = new Set<string>();
    (rows ?? []).forEach((r) => { if (r.target_type) set.add(r.target_type); });
    return Array.from(set).sort();
  }, [rows]);

  // Group rows by day for the timeline rendering.
  const groups = useMemo(() => groupByDay(rows ?? []), [rows]);

  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  function toggleExpand(id: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function applySearch(e?: React.FormEvent) {
    e?.preventDefault();
    setAppliedAction(searchInput.trim());
    setPage(0);
  }

  function clearFilters() {
    setSearchInput("");
    setAppliedAction("");
    setTargetType("");
    setPage(0);
  }

  const filteredOut = !!appliedAction || !!targetType;

  return (
    <div className="space-y-8 pb-12">
      {/* ---------- Hero — ledger paper texture ----------------- */}
      <header className="relative overflow-hidden rounded-3xl border border-outline-soft bg-surface px-6 py-8 md:px-10 md:py-10">
        {/* Thin vertical lines — "ledger / archive book" feel. Distinct
            from dots (/admin/users), diagonals (/admin/categories), and
            scanlines (/admin/apps). */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.06]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(90deg, rgb(var(--ink)) 0, rgb(var(--ink)) 1px, transparent 1px, transparent 8px)",
          }}
        />
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div className="min-w-0">
            <div className="eyebrow">{t("admin.eyebrow")}</div>
            <h1 className="mt-1 text-4xl font-bold tracking-tight text-ink md:text-5xl">
              {t("admin.audit.title")}
            </h1>
            <p className="mt-2 max-w-prose text-ink-soft">{t("admin.audit.subtitle")}</p>
          </div>
          <Button variant="outlined" onClick={() => reload()}>
            <RefreshCw className="h-4 w-4" /> {t("admin.audit.refresh")}
          </Button>
        </div>

        <dl className="relative mt-8 grid grid-cols-2 gap-6 md:grid-cols-4">
          <Stat label={t("admin.audit.stats.total")} value={stats.total} />
          <Stat label={t("admin.audit.stats.today")} value={stats.today} accent="primary" />
          <Stat label={t("admin.audit.stats.week")} value={stats.week} accent="primary" />
          <Stat label={t("admin.audit.stats.actors")} value={stats.actors} accent="mute" />
        </dl>
      </header>

      {/* ---------- Filter bar -------------------------------- */}
      <div className="space-y-3">
        <form onSubmit={applySearch} className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[260px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-mute" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t("admin.audit.filterPlaceholder")}
              className="pl-9 font-mono"
            />
          </div>
          <Button type="submit" variant="filled" size="md">
            <Filter className="h-3.5 w-3.5" /> {t("admin.audit.apply")}
          </Button>
          {filteredOut && (
            <Button type="button" variant="ghost" size="md" onClick={clearFilters}>
              {t("admin.audit.clear")}
            </Button>
          )}
        </form>

        {/* Target type chips — populated from the rows currently on the
            page so we never show options the data doesn't carry. */}
        {availableTypes.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <TypeChip label={t("admin.audit.allTypes")} active={!targetType} onClick={() => { setTargetType(""); setPage(0); }} />
            {availableTypes.map((tt) => (
              <TypeChip key={tt} label={tt} active={targetType === tt} onClick={() => { setTargetType(tt === targetType ? "" : tt); setPage(0); }} />
            ))}
          </div>
        )}
      </div>

      {/* ---------- Timeline ---------------------------------- */}
      {rows === null ? (
        <SkeletonTimeline />
      ) : groups.length === 0 ? (
        <EmptyState filtered={filteredOut} onReset={clearFilters} />
      ) : (
        <div className="relative">
          {/* The vertical rail. Anchored 16px from the left, drawn as a
              gradient so it fades into the page top + bottom. */}
          <div
            aria-hidden
            className="pointer-events-none absolute left-[19px] top-2 bottom-2 w-px"
            style={{
              backgroundImage:
                "linear-gradient(to bottom, transparent 0, rgb(var(--outline)/0.8) 24px, rgb(var(--outline)/0.8) calc(100% - 24px), transparent 100%)",
            }}
          />
          <div className="space-y-6">
            {groups.map((group) => (
              <DayGroup
                key={group.dayKey}
                group={group}
                expanded={expanded}
                onToggle={toggleExpand}
              />
            ))}
          </div>
        </div>
      )}

      {/* ---------- Pagination -------------------------------- */}
      {total > PAGE_SIZE && rows !== null && (
        <div className="flex items-center justify-between gap-3 border-t border-outline-soft pt-4">
          <p className="text-xs text-ink-mute">
            {t("admin.audit.pageOf", { page: page + 1, total: lastPage + 1, count: total })}
          </p>
          <div className="flex gap-1">
            <Button size="sm" variant="outlined" onClick={() => setPage(0)} disabled={page === 0}>
              {t("admin.audit.newest")}
            </Button>
            <Button size="sm" variant="outlined" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" variant="outlined" onClick={() => setPage((p) => Math.min(lastPage, p + 1))} disabled={page >= lastPage}>
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Day group                                                                  */
/* -------------------------------------------------------------------------- */

function DayGroup({
  group,
  expanded,
  onToggle,
}: {
  group: DayBucket;
  expanded: Set<string>;
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation();
  const todayKey = ymd(new Date());
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  const yestKey = ymd(yest);
  let label: string;
  if (group.dayKey === todayKey) {
    label = t("admin.audit.today");
  } else if (group.dayKey === yestKey) {
    label = t("admin.audit.yesterday");
  } else {
    const d = new Date(group.dayKey + "T00:00:00");
    try {
      label = d.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
    } catch {
      label = group.dayKey;
    }
  }
  return (
    <section>
      <DayDivider label={label} count={group.rows.length} />
      <ul className="space-y-1.5">
        {group.rows.map((row, idx) => (
          <EventRow
            key={row.id}
            row={row}
            index={idx}
            expanded={expanded.has(row.id)}
            onToggle={() => onToggle(row.id)}
          />
        ))}
      </ul>
    </section>
  );
}


function DayDivider({ label, count }: { label: string; count: number }) {
  const { t } = useTranslation();
  return (
    <div className="mb-2 flex items-baseline gap-3 pl-[40px]">
      <span className="text-[10px] uppercase tracking-[0.18em] text-ink-mute">{label}</span>
      <span className="h-px flex-1 bg-outline-soft" />
      <span className="font-mono text-[10px] tabular-nums text-ink-mute">
        {t("admin.audit.dayEvents", { count })}
      </span>
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Event row                                                                  */
/* -------------------------------------------------------------------------- */

function EventRow({
  row,
  index,
  expanded,
  onToggle,
}: {
  row: AuditLogEntry;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const tone = colorForAction(row.action);
  const destructive = isDestructive(row.action);
  const time = formatHM(new Date(row.created_at));

  const hasPayload =
    !!row.payload && Object.keys(row.payload).length > 0;
  const canExpand = hasPayload || !!row.ip_hash || !!row.user_agent;

  // Inline styles for the rail dot — keeps the colour computation in
  // one place rather than scattering classnames.
  const dotColor = {
    primary: "rgb(var(--primary))",
    accent: "rgb(var(--accent))",
    danger: "rgb(var(--danger))",
    mute: "rgb(var(--ink-mute))",
  }[tone];

  return (
    <li
      style={{ animationDelay: `${Math.min(index, 9) * 25}ms` }}
      className="group relative animate-fade-up pl-[40px]"
    >
      {/* Rail dot */}
      <span
        aria-hidden
        className="absolute left-[16px] top-[14px] flex h-2 w-2 items-center justify-center"
      >
        <span
          className={cn("h-2 w-2 rounded-full", destructive && "ring-2 ring-danger/30 ring-offset-1 ring-offset-surface")}
          style={{ backgroundColor: dotColor }}
        />
      </span>

      <div
        className={cn(
          "rounded-xl border bg-surface transition-colors",
          expanded
            ? "border-outline shadow-e1"
            : "border-outline-soft hover:border-outline",
        )}
      >
        <button
          type="button"
          onClick={canExpand ? onToggle : undefined}
          className={cn(
            "flex w-full items-start gap-3 px-3 py-2 text-left",
            canExpand && "cursor-pointer",
          )}
        >
          <span className="w-12 shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-ink-mute">
            {time}
          </span>

          {/* Actor pill (avatar + username) */}
          <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
            <ActorDot name={row.actor_username || row.actor_id || "system"} system={!row.actor_id} />
            <span className={cn(
              "font-mono text-xs",
              row.actor_id ? "text-ink-soft" : "italic text-ink-mute",
            )}>
              {row.actor_username || (row.actor_id ? row.actor_id.slice(0, 8) : t("admin.audit.system"))}
            </span>
          </span>

          {/* Action chip */}
          <ActionChip action={row.action} tone={tone} />

          {/* Summary + target */}
          <span className="min-w-0 flex-1 pt-0.5 text-xs text-ink">
            <span className="line-clamp-2 leading-snug">
              {row.summary || (
                <span className="italic text-ink-mute">{t("admin.audit.noSummary")}</span>
              )}
            </span>
            {row.target_type && (
              <span className="ml-1.5 align-middle">
                <Badge variant="soft" className="text-[9px] uppercase tracking-wider">
                  {row.target_type}
                </Badge>
              </span>
            )}
          </span>

          {canExpand && (
            <span className="shrink-0 self-center pl-1 text-ink-mute">
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  expanded && "rotate-180",
                )}
              />
            </span>
          )}
        </button>

        {expanded && canExpand && (
          <ExpandedPanel row={row} />
        )}
      </div>
    </li>
  );
}


function ExpandedPanel({ row }: { row: AuditLogEntry }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 border-t border-outline-soft bg-surface-2/50 px-3 py-3 md:grid-cols-[1fr_220px]">
      <div className="min-w-0">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-mute">
          {t("admin.audit.payload")}
        </div>
        {row.payload && Object.keys(row.payload).length > 0 ? (
          <pre className="max-h-72 overflow-auto rounded-lg border border-outline-soft bg-surface p-3 font-mono text-[11px] leading-relaxed text-ink-soft">
{JSON.stringify(row.payload, null, 2)}
          </pre>
        ) : (
          <p className="text-xs italic text-ink-mute">{t("admin.audit.noPayload")}</p>
        )}
      </div>
      <dl className="space-y-2 text-[11px]">
        <Field label={t("admin.audit.targetId")}>
          <code className="break-all font-mono text-ink-soft">
            {row.target_id || "—"}
          </code>
        </Field>
        <Field label={t("admin.audit.ipHash")}>
          <code className="break-all font-mono text-[10px] text-ink-soft">
            {row.ip_hash ? row.ip_hash.slice(0, 16) + "…" : "—"}
          </code>
        </Field>
        <Field label={t("admin.audit.userAgent")}>
          <span className="break-words text-ink-soft" title={row.user_agent || ""}>
            {row.user_agent || "—"}
          </span>
        </Field>
        <Field label={t("admin.audit.eventId")}>
          <code className="break-all font-mono text-[10px] text-ink-mute">
            {row.id}
          </code>
        </Field>
      </dl>
    </div>
  );
}


function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-ink-mute">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Action chip                                                                */
/* -------------------------------------------------------------------------- */

function ActionChip({ action, tone }: { action: string; tone: ActionColor }) {
  // Split prefix from leaf so the leaf can be emphasised — "user.deleted"
  // becomes ``user.`` + ``deleted`` with the latter bolder.
  const dot = action.indexOf(".");
  const prefix = dot > 0 ? action.slice(0, dot + 1) : "";
  const leaf = dot > 0 ? action.slice(dot + 1) : action;

  const cls = {
    primary: "border-primary/30 bg-primary-container/40 text-primary-on-container",
    accent: "border-accent/30 bg-accent-container/40 text-accent-on-container",
    danger: "border-danger/30 bg-danger-container/40 text-danger-on-container",
    mute: "border-outline-soft bg-surface-2 text-ink-soft",
  }[tone];

  return (
    <span className={cn(
      "shrink-0 self-center inline-flex items-baseline rounded-md border px-2 py-0.5 font-mono text-[10px]",
      cls,
    )}>
      {prefix && <span className="opacity-60">{prefix}</span>}
      <span className="font-semibold">{leaf}</span>
    </span>
  );
}


/* -------------------------------------------------------------------------- */
/*  Actor dot                                                                  */
/* -------------------------------------------------------------------------- */

function hueFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function ActorDot({ name, system }: { name: string; system: boolean }) {
  if (system) {
    return (
      <span
        aria-hidden
        className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-outline-soft bg-surface-2 font-mono text-[9px] text-ink-mute"
      >
        sys
      </span>
    );
  }
  const hue = hueFor(name);
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className="flex h-5 w-5 items-center justify-center rounded-full font-mono text-[9px] font-bold text-white"
      style={{
        backgroundImage: `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 40) % 360} 65% 45%))`,
      }}
    >
      {initial}
    </span>
  );
}


/* -------------------------------------------------------------------------- */
/*  Type chip + skeleton + empty                                               */
/* -------------------------------------------------------------------------- */

function TypeChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill border px-3 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
        active
          ? "border-primary bg-primary text-primary-fg"
          : "border-outline-soft bg-surface text-ink-soft hover:border-outline hover:bg-surface-2 hover:text-ink",
      )}
    >
      {label}
    </button>
  );
}


function Stat({
  label,
  value,
  accent = "ink",
}: {
  label: string;
  value: number;
  accent?: "ink" | "primary" | "accent" | "danger" | "mute";
}) {
  const [display, setDisplay] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    const from = prev.current;
    const to = value;
    prev.current = to;
    if (from === to) { setDisplay(to); return; }
    const duration = 650;
    const start = performance.now();
    let raf = 0;
    function tick(now: number) {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  const color = {
    ink: "text-ink",
    primary: "text-primary",
    accent: "text-accent",
    danger: "text-danger",
    mute: "text-ink-mute",
  }[accent];

  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.18em] text-ink-mute">{label}</dt>
      <dd className={cn("nums-no-slash mt-1 text-3xl font-bold tabular-nums tracking-tight md:text-4xl", color)}>
        {display}
      </dd>
    </div>
  );
}


function SkeletonTimeline() {
  return (
    <div className="space-y-3 pl-[40px]">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="h-12 animate-pulse rounded-xl bg-surface-2"
          style={{ animationDelay: `${i * 60}ms` }}
        />
      ))}
    </div>
  );
}


function EmptyState({
  filtered,
  onReset,
}: {
  filtered: boolean;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-outline-soft bg-surface-2/30 px-6 py-16 text-center">
      <div className="text-3xl">📜</div>
      <p className="text-sm font-medium text-ink">
        {filtered ? t("admin.audit.emptyFilter") : t("admin.audit.empty")}
      </p>
      {filtered && (
        <Button variant="outlined" size="sm" onClick={onReset}>
          {t("admin.audit.clear")}
        </Button>
      )}
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Date helpers                                                               */
/* -------------------------------------------------------------------------- */

type DayBucket = { dayKey: string; rows: AuditLogEntry[] };

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function groupByDay(rows: AuditLogEntry[]): DayBucket[] {
  const buckets: DayBucket[] = [];
  for (const r of rows) {
    const key = ymd(new Date(r.created_at));
    const last = buckets[buckets.length - 1];
    if (last && last.dayKey === key) last.rows.push(r);
    else buckets.push({ dayKey: key, rows: [r] });
  }
  return buckets;
}

function formatHM(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
