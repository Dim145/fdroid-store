"use client";

import {
  ArrowDownAZ,
  Check,
  Pencil,
  Plus,
  Sparkles,
  Sprout,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type Category } from "@/lib/api";
import { toast } from "@/lib/toast-store";
import { cn } from "@/lib/utils";


type SortKey = "usage" | "name" | "newest";

export default function AdminCategoriesPage() {
  const { t } = useTranslation();
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [sort, setSort] = useState<SortKey>("usage");
  const [emptyOnly, setEmptyOnly] = useState(false);

  // Inline edit state lives at the page level so only one tile can be
  // in edit mode at a time. Carrying it in the tile would let an admin
  // open two editors at once and lose their work on the unsaved one.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Same idea for the inline delete confirmation.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  // Create-tile expansion. We keep the form mounted (it lives in the
  // grid) but switch its visual mode.
  const [creating, setCreating] = useState(false);

  async function refresh() {
    try {
      setCategories(await api.categories.list());
    } catch (e) {
      toast.error(t("admin.categories.loadFailed"), e instanceof Error ? e.message : undefined);
    }
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, []);

  // --- Derived state -----------------------------------------------------
  const rows = categories ?? [];
  const stats = useMemo(() => {
    const used = rows.filter((c) => (c.app_count ?? 0) > 0);
    const empties = rows.length - used.length;
    const top = rows.reduce<Category | null>(
      (acc, c) => ((c.app_count ?? 0) > (acc?.app_count ?? 0) ? c : acc),
      null,
    );
    return { total: rows.length, used: used.length, empty: empties, top };
  }, [rows]);

  const maxCount = useMemo(
    () => rows.reduce((m, c) => Math.max(m, c.app_count ?? 0), 0),
    [rows],
  );

  const sorted = useMemo(() => {
    const list = [...rows];
    if (emptyOnly) {
      return list.filter((c) => (c.app_count ?? 0) === 0)
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    switch (sort) {
      case "name":
        list.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "newest":
        // No created_at on Category yet — fall back to id which is a
        // UUIDv4 (random, so this sort is meaningless but predictable).
        // Acts as a tie-breaker rather than a real "recently created".
        list.sort((a, b) => b.id.localeCompare(a.id));
        break;
      default:
        list.sort((a, b) => (b.app_count ?? 0) - (a.app_count ?? 0));
    }
    return list;
  }, [rows, sort, emptyOnly]);

  // --- Mutations ---------------------------------------------------------
  async function onCreate(payload: { name: string; description: string }) {
    try {
      await api.categories.create({
        name: payload.name,
        description: payload.description || null,
      });
      toast.success(t("admin.categories.created"));
      setCreating(false);
      await refresh();
    } catch (e) {
      toast.error(t("admin.categories.createFailed"), e instanceof Error ? e.message : undefined);
    }
  }

  async function onSave(c: Category, payload: { name: string; description: string }) {
    try {
      await api.categories.update(c.id, {
        name: payload.name,
        description: payload.description || null,
      });
      toast.success(t("admin.categories.renamed", { name: payload.name }));
      setEditingId(null);
      await refresh();
    } catch (e) {
      toast.error(t("admin.categories.saveFailed"), e instanceof Error ? e.message : undefined);
    }
  }

  async function onDelete(c: Category) {
    try {
      await api.categories.remove(c.id);
      toast.success(t("admin.categories.deleted", { name: c.name }));
      setConfirmingId(null);
      await refresh();
    } catch (e) {
      toast.error(t("admin.categories.deleteFailed"), e instanceof Error ? e.message : undefined);
    }
  }

  async function cleanEmpty() {
    const targets = rows.filter((c) => (c.app_count ?? 0) === 0);
    if (targets.length === 0) return;
    const label = t("admin.categories.cleanupConfirm", { count: targets.length });
    if (!confirm(label)) return;
    const results = await Promise.allSettled(
      targets.map((c) => api.categories.remove(c.id)),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed === 0) toast.success(t("admin.categories.cleanupOk", { count: targets.length }));
    else toast.error(t("admin.categories.cleanupPartial", { ok: targets.length - failed, fail: failed }));
    await refresh();
  }

  return (
    <div className="space-y-8 pb-12">
      {/* ---------- Editorial header --------------------------------- */}
      <header className="relative overflow-hidden rounded-3xl border border-outline-soft bg-surface px-6 py-8 md:px-10 md:py-10">
        {/* Layered diagonal stripes — different texture from /admin/users
            so the two pages don't feel like the same template. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(135deg, rgb(var(--ink)) 0, rgb(var(--ink)) 1px, transparent 1px, transparent 14px)",
          }}
        />
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div>
            <div className="eyebrow">{t("admin.eyebrow")}</div>
            <h1 className="mt-1 text-4xl font-bold tracking-tight text-ink md:text-5xl">
              {t("admin.categories.title")}
            </h1>
            <p className="mt-2 max-w-prose text-ink-soft">{t("admin.categories.subtitle")}</p>
          </div>
          {stats.empty > 0 && (
            <Button variant="outlined" size="md" onClick={cleanEmpty}>
              <Sprout className="h-4 w-4" /> {t("admin.categories.cleanup", { count: stats.empty })}
            </Button>
          )}
        </div>

        <dl className="relative mt-8 grid grid-cols-2 gap-6 md:grid-cols-4">
          <Stat label={t("admin.categories.stats.total")} value={stats.total} />
          <Stat label={t("admin.categories.stats.used")} value={stats.used} accent="primary" />
          <Stat label={t("admin.categories.stats.empty")} value={stats.empty} accent={stats.empty > 0 ? "danger" : "mute"} />
          <div>
            <dt className="text-[10px] uppercase tracking-[0.18em] text-ink-mute">
              {t("admin.categories.stats.top")}
            </dt>
            <dd className="mt-1 flex items-baseline gap-2">
              {stats.top ? (
                <>
                  <span className="truncate text-2xl font-bold tracking-tight text-ink md:text-3xl">
                    {stats.top.name}
                  </span>
                  <span className="font-mono text-xs text-ink-mute">{stats.top.app_count ?? 0}</span>
                </>
              ) : (
                <span className="text-2xl font-bold text-ink-mute md:text-3xl">—</span>
              )}
            </dd>
          </div>
        </dl>
      </header>

      {/* ---------- Sort bar ----------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <SortChip
          label={t("admin.categories.sort.usage")}
          active={sort === "usage" && !emptyOnly}
          onClick={() => { setSort("usage"); setEmptyOnly(false); }}
          icon={<Sparkles className="h-3.5 w-3.5" />}
        />
        <SortChip
          label={t("admin.categories.sort.name")}
          active={sort === "name" && !emptyOnly}
          onClick={() => { setSort("name"); setEmptyOnly(false); }}
          icon={<ArrowDownAZ className="h-3.5 w-3.5" />}
        />
        <SortChip
          label={t("admin.categories.sort.emptyOnly")}
          active={emptyOnly}
          onClick={() => setEmptyOnly((v) => !v)}
          count={stats.empty}
        />
      </div>

      {/* ---------- Grid --------------------------------------------- */}
      {categories === null ? (
        <SkeletonGrid />
      ) : (
        <ul
          role="list"
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {!emptyOnly && (
            <AddTile expanded={creating} onExpand={() => setCreating(true)} onCancel={() => setCreating(false)} onCreate={onCreate} />
          )}
          {sorted.map((c, i) => (
            <CategoryTile
              key={c.id}
              category={c}
              index={i}
              maxCount={maxCount}
              editing={editingId === c.id}
              confirming={confirmingId === c.id}
              onEdit={() => { setEditingId(c.id); setConfirmingId(null); }}
              onCancelEdit={() => setEditingId(null)}
              onSave={(payload) => onSave(c, payload)}
              onConfirmDelete={() => { setConfirmingId(c.id); setEditingId(null); }}
              onCancelDelete={() => setConfirmingId(null)}
              onDelete={() => onDelete(c)}
            />
          ))}
        </ul>
      )}

      {categories !== null && sorted.length === 0 && !emptyOnly && !creating && (
        <p className="rounded-2xl border border-dashed border-outline-soft bg-surface-2/30 px-6 py-12 text-center text-sm italic text-ink-mute">
          {t("admin.categories.empty")}
        </p>
      )}
      {categories !== null && sorted.length === 0 && emptyOnly && (
        <p className="rounded-2xl border border-dashed border-outline-soft bg-surface-2/30 px-6 py-12 text-center text-sm italic text-ink-mute">
          {t("admin.categories.noEmpty")}
        </p>
      )}
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Animated stat (duplicate of /admin/users — small, kept local on purpose)   */
/* -------------------------------------------------------------------------- */

function Stat({
  label,
  value,
  accent = "ink",
}: {
  label: string;
  value: number;
  accent?: "ink" | "primary" | "accent" | "danger" | "mute";
}) {
  // See /admin/users for the rationale: animate from the last shown
  // value to the new one on every ``value`` change. The first useful
  // tween is the fetch-completion 0 → N transition.
  const [display, setDisplay] = useState(0);
  const prev = useRef(0);

  useEffect(() => {
    const from = prev.current;
    const to = value;
    prev.current = to;
    if (from === to) {
      setDisplay(to);
      return;
    }
    const duration = 600;
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
      <dd className={cn("mt-1 font-mono text-4xl font-bold tabular-nums tracking-tight md:text-5xl", color)}>
        {display}
      </dd>
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Sort chip                                                                  */
/* -------------------------------------------------------------------------- */

function SortChip({
  label,
  active,
  onClick,
  icon,
  count,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill border px-3.5 py-1.5 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-fg shadow-e1"
          : "border-outline-soft bg-surface text-ink-soft hover:border-outline hover:bg-surface-2 hover:text-ink",
      )}
    >
      {icon}
      {label}
      {count !== undefined && (
        <span
          className={cn(
            "rounded-pill px-1.5 py-px font-mono text-[10px] tabular-nums",
            active ? "bg-primary-fg/15 text-primary-fg" : "bg-surface-2 text-ink-mute",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}


/* -------------------------------------------------------------------------- */
/*  Category tile                                                              */
/* -------------------------------------------------------------------------- */

/** Stable hue from the category name so the same chip wears the same
 *  colour across reloads, like the user avatars. */
function hueFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function CategoryTile({
  category,
  index,
  maxCount,
  editing,
  confirming,
  onEdit,
  onCancelEdit,
  onSave,
  onConfirmDelete,
  onCancelDelete,
  onDelete,
}: {
  category: Category;
  index: number;
  maxCount: number;
  editing: boolean;
  confirming: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (payload: { name: string; description: string }) => Promise<void>;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const count = category.app_count ?? 0;
  const isEmpty = count === 0;
  const ratio = maxCount > 0 ? count / maxCount : 0;
  const hue = hueFor(category.name);

  return (
    <li
      style={{ animationDelay: `${Math.min(index, 9) * 40}ms` }}
      className={cn(
        "group relative isolate flex animate-fade-up flex-col overflow-hidden rounded-2xl border bg-surface shadow-e1 transition-all",
        editing
          ? "border-primary ring-2 ring-primary/15"
          : isEmpty
            ? "border-dashed border-outline-soft"
            : "border-outline-soft hover:border-outline hover:shadow-e2",
      )}
    >
      {/* Spine: 4px colored bar on the left = category identity. Muted
          when the category has no apps. */}
      <span
        aria-hidden
        className={cn(
          "absolute left-0 top-0 h-full w-[3px] transition-colors",
          isEmpty && "saturate-0 opacity-50",
        )}
        style={{ backgroundColor: `hsl(${hue} 70% 55%)` }}
      />
      {/* Soft hue tint in the corner. Just enough to feel curated. */}
      {!isEmpty && (
        <div
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full opacity-[0.10]"
          style={{ backgroundColor: `hsl(${hue} 80% 60%)` }}
        />
      )}

      <div className="relative flex flex-1 flex-col gap-2 px-5 pt-5">
        {editing ? (
          <EditForm
            initial={category}
            onCancel={onCancelEdit}
            onSave={onSave}
          />
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <h3 className="break-words text-2xl font-bold leading-tight tracking-tight text-ink">
                {category.name}
              </h3>
              <span className="shrink-0 font-mono text-2xl font-bold tabular-nums text-ink-mute">
                {count}
              </span>
            </div>
            <p className={cn(
              "min-h-[2.5rem] text-sm italic leading-snug text-ink-soft line-clamp-3",
              !category.description && "not-italic text-ink-mute",
            )}>
              {category.description || t("admin.categories.noDescription")}
            </p>
          </>
        )}
      </div>

      {/* Usage bar — only when not editing. CSS transition on the width
          gives a tasteful settle when the list re-sorts. */}
      {!editing && (
        <div className="relative mt-2 px-5 pb-4">
          <div className="h-1 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full transition-[width] duration-500 ease-out"
              style={{
                width: `${Math.max(2, ratio * 100)}%`,
                backgroundColor: isEmpty
                  ? "transparent"
                  : `hsl(${hue} 70% 55%)`,
              }}
            />
          </div>
        </div>
      )}

      {/* Action zone: edit/delete on hover; delete-confirm overlay */}
      {!editing && !confirming && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 px-3 pb-2 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
          <button
            type="button"
            onClick={onEdit}
            className="flex h-7 items-center gap-1 rounded-pill border border-outline-soft bg-surface px-2 text-[11px] font-medium text-ink-soft shadow-e1 hover:border-primary hover:text-primary"
          >
            <Pencil className="h-3 w-3" /> {t("admin.categories.edit")}
          </button>
          <button
            type="button"
            onClick={onConfirmDelete}
            className="flex h-7 items-center gap-1 rounded-pill border border-outline-soft bg-surface px-2 text-[11px] font-medium text-ink-soft shadow-e1 hover:border-danger hover:text-danger"
          >
            <Trash2 className="h-3 w-3" /> {t("admin.categories.delete")}
          </button>
        </div>
      )}

      {confirming && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-danger-container/95 px-4 text-center text-danger-on-container">
          <Trash2 className="h-5 w-5" />
          <p className="text-sm font-semibold">
            {t("admin.categories.deletePrompt", { name: category.name })}
          </p>
          <p className="text-xs">
            {count > 0
              ? t("admin.categories.deleteHintWithApps", { count })
              : t("admin.categories.deleteHintEmpty")}
          </p>
          <div className="mt-1 flex gap-2">
            <Button variant="danger" size="sm" onClick={onDelete}>
              <Trash2 className="h-3.5 w-3.5" /> {t("admin.categories.deleteConfirm")}
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancelDelete}>
              {t("admin.categories.cancel")}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}


/* -------------------------------------------------------------------------- */
/*  Inline edit form                                                           */
/* -------------------------------------------------------------------------- */

function EditForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: Category;
  onCancel: () => void;
  onSave: (payload: { name: string; description: string }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onSave({ name: name.trim(), description: description.trim() });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-1 flex-col gap-2 pb-4">
      <Label htmlFor={`name-${initial.id}`} className="text-[10px] uppercase tracking-wider text-ink-mute">
        {t("admin.categories.addNameLabel")}
      </Label>
      <Input
        id={`name-${initial.id}`}
        autoFocus
        required
        maxLength={64}
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="text-base font-semibold"
      />
      <Label htmlFor={`desc-${initial.id}`} className="mt-1 text-[10px] uppercase tracking-wider text-ink-mute">
        {t("admin.categories.addDescriptionLabel")}
      </Label>
      <Input
        id={`desc-${initial.id}`}
        maxLength={255}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t("admin.categories.addDescriptionPlaceholder")}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button type="submit" variant="filled" size="sm" disabled={busy || !name.trim()}>
          <Check className="h-3.5 w-3.5" /> {busy ? t("common.saving") : t("admin.categories.save")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          <X className="h-3.5 w-3.5" /> {t("admin.categories.cancel")}
        </Button>
      </div>
    </form>
  );
}


/* -------------------------------------------------------------------------- */
/*  Add tile — dashed border, expands into form                                */
/* -------------------------------------------------------------------------- */

function AddTile({
  expanded,
  onExpand,
  onCancel,
  onCreate,
}: {
  expanded: boolean;
  onExpand: () => void;
  onCancel: () => void;
  onCreate: (payload: { name: string; description: string }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onCreate({ name: name.trim(), description: description.trim() });
      setName(""); setDescription("");
    } finally {
      setBusy(false);
    }
  }

  if (!expanded) {
    return (
      <li>
        <button
          type="button"
          onClick={onExpand}
          className="group flex h-full min-h-[170px] w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-outline-soft bg-surface-2/30 px-6 py-5 text-ink-mute transition-all hover:border-primary hover:bg-primary-container/30 hover:text-primary"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-pill bg-surface text-ink-soft shadow-e1 transition-colors group-hover:bg-primary group-hover:text-primary-fg">
            <Plus className="h-5 w-5" strokeWidth={2.4} />
          </span>
          <span className="text-sm font-semibold">{t("admin.categories.addBtn")}</span>
        </button>
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-2 rounded-2xl border-2 border-primary/40 bg-surface p-5 shadow-e1">
      <form onSubmit={submit} className="flex flex-1 flex-col gap-2">
        <Label htmlFor="new-name" className="text-[10px] uppercase tracking-wider text-ink-mute">
          {t("admin.categories.addNameLabel")}
        </Label>
        <Input
          id="new-name"
          autoFocus
          required
          maxLength={64}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("admin.categories.addNamePlaceholder")}
          className="text-base font-semibold"
        />
        <Label htmlFor="new-desc" className="mt-1 text-[10px] uppercase tracking-wider text-ink-mute">
          {t("admin.categories.addDescriptionLabel")}
        </Label>
        <Input
          id="new-desc"
          maxLength={255}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("admin.categories.addDescriptionPlaceholder")}
        />
        <div className="mt-auto flex justify-end gap-2 pt-2">
          <Button type="submit" variant="filled" size="sm" disabled={busy || !name.trim()}>
            <Check className="h-3.5 w-3.5" /> {busy ? t("admin.categories.adding") : t("admin.categories.addBtn")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => { setName(""); setDescription(""); onCancel(); }}
          >
            <X className="h-3.5 w-3.5" /> {t("admin.categories.cancel")}
          </Button>
        </div>
      </form>
    </li>
  );
}


/* -------------------------------------------------------------------------- */
/*  Skeleton grid                                                              */
/* -------------------------------------------------------------------------- */

function SkeletonGrid() {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <li
          key={i}
          className="flex h-[170px] flex-col gap-3 rounded-2xl border border-outline-soft bg-surface p-5"
          style={{ animationDelay: `${i * 50}ms` }}
        >
          <div className="h-5 w-2/3 animate-pulse rounded-pill bg-surface-2" />
          <div className="h-3 w-full animate-pulse rounded-pill bg-surface-2" />
          <div className="h-3 w-1/2 animate-pulse rounded-pill bg-surface-2" />
          <div className="mt-auto h-1 animate-pulse rounded-full bg-surface-2" />
        </li>
      ))}
    </ul>
  );
}
