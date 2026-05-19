"use client";

import {
  ArrowUpRight,
  Check,
  Copy,
  Dices,
  Eye,
  EyeOff,
  KeyRound,
  Search,
  ShieldHalf,
  Trash2,
  UserCog,
  UserPlus,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, type AdminUpdateUser, type CurrentUser } from "@/lib/api";
import { toast } from "@/lib/toast-store";
import { cn, formatDate } from "@/lib/utils";


/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

type FilterKey = "all" | "admin" | "user" | "disabled";

export default function AdminUsersPage() {
  const { t } = useTranslation();
  const [users, setUsers] = useState<CurrentUser[] | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [error, setError] = useState<string | null>(null);

  const [openUserId, setOpenUserId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  async function refresh() {
    try {
      setUsers(await api.admin.listUsers(q || undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("admin.users.loadFailed"));
    }
  }
  useEffect(() => {
    const timer = setTimeout(refresh, 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // Stats computed off the loaded list. Filter chips compute their own
  // sub-counts the same way, so a count of 0 actually disables the chip.
  const stats = useMemo(() => {
    const rows = users ?? [];
    return {
      total: rows.length,
      admins: rows.filter((u) => u.role === "admin").length,
      active: rows.filter((u) => u.is_active).length,
      disabled: rows.filter((u) => !u.is_active).length,
    };
  }, [users]);

  const visible = useMemo(() => {
    if (!users) return null;
    switch (filter) {
      case "admin":
        return users.filter((u) => u.role === "admin");
      case "user":
        return users.filter((u) => u.role === "user");
      case "disabled":
        return users.filter((u) => !u.is_active);
      default:
        return users;
    }
  }, [users, filter]);

  const openUser = useMemo(
    () => (openUserId ? users?.find((u) => u.id === openUserId) ?? null : null),
    [users, openUserId],
  );

  // Single source of truth for "would this action leave the repo without
  // a usable admin?" — the backend enforces this, but mirroring it client-
  // side lets us grey out the dangerous actions BEFORE the user clicks.
  const activeAdminCount = useMemo(
    () => (users ?? []).filter((u) => u.role === "admin" && u.is_active).length,
    [users],
  );

  return (
    <div className="space-y-8 pb-12">
      {/* ---------- Editorial header --------------------------------- */}
      <header className="relative overflow-hidden rounded-3xl border border-outline-soft bg-gradient-to-br from-primary-container/40 via-surface to-surface px-6 py-8 md:px-10 md:py-10">
        {/* Decorative grid in the corner — keeps the band from feeling
            flat without distracting from the numbers. */}
        <div
          aria-hidden
          className="pointer-events-none absolute right-0 top-0 h-full w-1/2 opacity-30"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, rgb(var(--ink) / 0.18) 1px, transparent 0)",
            backgroundSize: "18px 18px",
            maskImage: "linear-gradient(to left, black, transparent)",
          }}
        />
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div className="min-w-0">
            <div className="eyebrow">{t("admin.eyebrow")}</div>
            <h1 className="mt-1 text-4xl font-bold tracking-tight text-ink md:text-5xl">
              {t("admin.users.title")}
            </h1>
            <p className="mt-2 max-w-prose text-ink-soft">{t("admin.users.subtitle")}</p>
          </div>
          <Button variant="filled" size="lg" onClick={() => setInviteOpen(true)}>
            <UserPlus className="h-4 w-4" /> {t("admin.users.invite")}
          </Button>
        </div>

        {/* Big numbers — count-up on first paint */}
        <dl className="relative mt-8 grid grid-cols-2 gap-6 md:grid-cols-4">
          <Stat label={t("admin.users.stats.total")} value={stats.total} />
          <Stat label={t("admin.users.stats.active")} value={stats.active} accent="primary" />
          <Stat label={t("admin.users.stats.admins")} value={stats.admins} accent="accent" />
          <Stat label={t("admin.users.stats.disabled")} value={stats.disabled} accent={stats.disabled > 0 ? "danger" : "mute"} />
        </dl>
      </header>

      {error && (
        <p className="rounded-2xl border border-danger bg-danger-container px-4 py-3 text-sm text-danger-on-container">
          {error}
        </p>
      )}

      {/* ---------- Filter bar --------------------------------------- */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-mute" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("admin.users.search")}
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <FilterChip
            label={t("admin.users.filter.all")}
            count={stats.total}
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
          <FilterChip
            label={t("admin.users.filter.admins")}
            count={stats.admins}
            active={filter === "admin"}
            onClick={() => setFilter("admin")}
          />
          <FilterChip
            label={t("admin.users.filter.users")}
            count={stats.total - stats.admins}
            active={filter === "user"}
            onClick={() => setFilter("user")}
          />
          <FilterChip
            label={t("admin.users.filter.disabled")}
            count={stats.disabled}
            active={filter === "disabled"}
            onClick={() => setFilter("disabled")}
          />
        </div>
      </div>

      {/* ---------- List --------------------------------------------- */}
      {visible === null ? (
        <SkeletonList />
      ) : visible.length === 0 ? (
        <EmptyState query={q} filter={filter} onReset={() => { setQ(""); setFilter("all"); }} />
      ) : (
        <ul className="space-y-2">
          {visible.map((u, i) => (
            <UserRow
              key={u.id}
              user={u}
              index={i}
              selected={u.id === openUserId}
              onOpen={() => setOpenUserId(u.id)}
            />
          ))}
        </ul>
      )}

      {/* ---------- Drawers ------------------------------------------ */}
      <Sheet open={openUser != null} onClose={() => setOpenUserId(null)} width="lg">
        {openUser && (
          <UserDrawer
            user={openUser}
            activeAdminCount={activeAdminCount}
            onClose={() => setOpenUserId(null)}
            onChanged={refresh}
          />
        )}
      </Sheet>

      <Sheet open={inviteOpen} onClose={() => setInviteOpen(false)} width="md">
        {inviteOpen && (
          <InviteDrawer
            onClose={() => setInviteOpen(false)}
            onCreated={async () => {
              setInviteOpen(false);
              await refresh();
            }}
          />
        )}
      </Sheet>
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Stats hero                                                                 */
/* -------------------------------------------------------------------------- */

/** Big number that animates from the previously-shown value to the
 *  new one whenever ``value`` changes. The first useful change is when
 *  the fetch resolves (0 → N), which gives us the count-up. Subsequent
 *  CRUD also animates short transitions (e.g. 5 → 4 after a delete). */
function Stat({
  label,
  value,
  accent = "ink",
}: {
  label: string;
  value: number;
  accent?: "ink" | "primary" | "accent" | "danger" | "mute";
}) {
  // Start at 0 so the first paint is the "before fetch" snapshot, and
  // the effect below animates up to the real number once it lands.
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
    const duration = 700;
    const start = performance.now();
    let raf = 0;
    function tick(now: number) {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out-cubic
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
/*  Filter chip                                                                */
/* -------------------------------------------------------------------------- */

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-2 rounded-pill border px-3.5 py-1.5 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-fg shadow-e1"
          : "border-outline-soft bg-surface text-ink-soft hover:border-outline hover:bg-surface-2 hover:text-ink",
      )}
    >
      {label}
      <span
        className={cn(
          "rounded-pill px-1.5 py-px font-mono text-[10px] tabular-nums",
          active ? "bg-primary-fg/15 text-primary-fg" : "bg-surface-2 text-ink-mute",
        )}
      >
        {count}
      </span>
    </button>
  );
}


/* -------------------------------------------------------------------------- */
/*  User row                                                                   */
/* -------------------------------------------------------------------------- */

function UserRow({
  user,
  index,
  selected,
  onOpen,
}: {
  user: CurrentUser;
  index: number;
  selected: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const inactive = !user.is_active;
  return (
    <li
      // Staggered reveal: small delay per row, capped at ~10 entries so a
      // big list doesn't take forever to settle.
      style={{ animationDelay: `${Math.min(index, 9) * 35}ms` }}
      className={cn(
        "group animate-fade-up rounded-2xl border bg-surface px-4 py-3 transition-all",
        selected
          ? "border-primary shadow-e2 ring-2 ring-primary/15"
          : "border-outline-soft hover:border-outline hover:shadow-e1",
        inactive && "opacity-70",
      )}
    >
      <div className="flex items-center gap-4">
        <Avatar name={user.username} dimmed={inactive} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono text-sm font-semibold text-ink">{user.username}</span>
            {user.role === "admin" && (
              <Badge variant="primary" className="text-[10px] uppercase tracking-wider">
                {t("admin.users.role.admin")}
              </Badge>
            )}
            {inactive && (
              <Badge variant="soft" className="text-[10px] uppercase tracking-wider text-danger">
                {t("admin.users.disabled")}
              </Badge>
            )}
          </div>
          <div className="truncate text-xs text-ink-mute">{user.email}</div>
        </div>
        <div className="hidden text-right md:block">
          <div className="text-[10px] uppercase tracking-wider text-ink-mute">
            {t("admin.users.row.lastLogin")}
          </div>
          <div className="font-mono text-xs text-ink-soft">
            {user.last_login_at ? formatDate(user.last_login_at) : "—"}
          </div>
        </div>
        <div className="hidden md:block">
          <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
            {user.auth_provider}
          </Badge>
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex h-9 items-center gap-1 rounded-pill border border-outline-soft bg-surface px-3 text-xs font-medium text-ink-soft transition-colors hover:border-primary hover:bg-primary-container/40 hover:text-primary"
        >
          {t("admin.users.row.manage")} <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2.4} />
        </button>
      </div>
    </li>
  );
}


/* -------------------------------------------------------------------------- */
/*  Avatar — stable colored initial                                            */
/* -------------------------------------------------------------------------- */

function hueFor(name: string): number {
  // djb2-ish hash → deterministic hue so the same user always wears the
  // same colour across reloads + devices.
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function Avatar({
  name,
  size = 40,
  dimmed = false,
}: {
  name: string;
  size?: number;
  dimmed?: boolean;
}) {
  const hue = hueFor(name);
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-2xl font-mono font-bold text-white shadow-e1",
        dimmed && "saturate-50",
      )}
      style={{
        width: size,
        height: size,
        backgroundImage: `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 40) % 360} 65% 45%))`,
        fontSize: size * 0.42,
      }}
    >
      {initial}
    </span>
  );
}


/* -------------------------------------------------------------------------- */
/*  Sheet (right-side drawer)                                                  */
/* -------------------------------------------------------------------------- */

function Sheet({
  open,
  onClose,
  children,
  width = "md",
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  width?: "md" | "lg";
}) {
  // ESC to close. Mounted only while open so we don't keep a global
  // listener around for nothing.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;
  const widthCls = width === "lg" ? "w-[min(540px,100vw)]" : "w-[min(440px,100vw)]";
  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        className="absolute inset-0 animate-fade-in bg-black/40 backdrop-blur-[2px]"
      />
      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "absolute right-0 top-0 flex h-full flex-col overflow-y-auto border-l border-outline-soft bg-surface shadow-e3",
          "animate-slide-in-right",
          widthCls,
        )}
      >
        {children}
      </div>
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  User drawer — Identity / Access / Quotas / Danger                          */
/* -------------------------------------------------------------------------- */

function UserDrawer({
  user,
  activeAdminCount,
  onClose,
  onChanged,
}: {
  user: CurrentUser;
  activeAdminCount: number;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <>
      <SheetHeader onClose={onClose}>
        <div className="flex items-center gap-3">
          <Avatar name={user.username} size={48} />
          <div className="min-w-0">
            <div className="font-mono text-base font-semibold text-ink">{user.username}</div>
            <div className="truncate text-xs text-ink-mute">{user.email}</div>
          </div>
        </div>
      </SheetHeader>

      <div className="space-y-6 px-6 py-6">
        <DrawerSection
          icon={<UserCog className="h-4 w-4" />}
          title={t("admin.users.drawer.identity")}
        >
          <dl className="grid grid-cols-2 gap-3 text-xs">
            <Field2 label={t("admin.users.row.lastLogin")}>
              {user.last_login_at ? formatDate(user.last_login_at) : "—"}
            </Field2>
            <Field2 label={t("admin.users.drawer.created")}>{formatDate(user.created_at)}</Field2>
            <Field2 label={t("admin.users.fields.role")}>
              <Badge variant={user.role === "admin" ? "primary" : "outline"}>
                {t(user.role === "admin" ? "admin.users.role.admin" : "admin.users.role.user")}
              </Badge>
            </Field2>
            <Field2 label={t("admin.users.columns2.provider")}>
              <Badge variant="outline">{user.auth_provider}</Badge>
            </Field2>
          </dl>
        </DrawerSection>

        <AccessSection
          user={user}
          activeAdminCount={activeAdminCount}
          onChanged={onChanged}
        />

        <DrawerSection
          icon={<ShieldHalf className="h-4 w-4" />}
          title={t("admin.users.drawer.quotas")}
          subtitle={
            <>
              {t("admin.users.quotaBody")}{" "}
              <Link href="/admin/repo" className="underline decoration-dotted underline-offset-2 hover:text-primary">
                {t("admin.users.drawer.quotaDefaultsLink")}
              </Link>
              .
            </>
          }
        >
          <QuotaForm user={user} onSaved={onChanged} />
        </DrawerSection>

        <DangerSection user={user} activeAdminCount={activeAdminCount} onDeleted={async () => {
          await onChanged();
          onClose();
        }} />
      </div>
    </>
  );
}


function SheetHeader({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-outline-soft bg-surface/90 px-6 py-4 backdrop-blur">
      <div className="min-w-0 flex-1">{children}</div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="-mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-pill text-ink-mute hover:bg-surface-2 hover:text-ink"
      >
        <X className="h-4 w-4" />
      </button>
    </header>
  );
}


function DrawerSection({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <header className="mb-3 flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-ink-soft">
          {icon}
        </span>
        <div>
          <h3 className="text-sm font-semibold tracking-tight text-ink">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs leading-relaxed text-ink-mute">{subtitle}</p>}
        </div>
      </header>
      {children}
    </section>
  );
}


function Field2({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-ink-mute">{label}</dt>
      <dd className="mt-1 text-ink-soft">{children}</dd>
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Access section — toggles + reset password                                  */
/* -------------------------------------------------------------------------- */

function AccessSection({
  user,
  activeAdminCount,
  onChanged,
}: {
  user: CurrentUser;
  activeAdminCount: number;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<"role" | "active" | null>(null);
  const [showReset, setShowReset] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [revealPw, setRevealPw] = useState(false);
  const [savingPw, setSavingPw] = useState(false);

  const lastAdmin =
    user.role === "admin" && user.is_active && activeAdminCount <= 1;

  async function patch(payload: AdminUpdateUser, key: "role" | "active") {
    setBusy(key);
    try {
      await api.admin.updateUser(user.id, payload);
      await onChanged();
    } catch (e) {
      toast.error(t("admin.users.saveFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  async function resetPassword() {
    if (!newPw || newPw.length < 8) {
      toast.error(t("admin.users.passwordTooShort"));
      return;
    }
    setSavingPw(true);
    try {
      await api.admin.updateUser(user.id, { new_password: newPw });
      toast.success(t("admin.users.passwordReset"));
      setNewPw(""); setShowReset(false);
      await onChanged();
    } catch (e) {
      toast.error(t("admin.users.saveFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setSavingPw(false);
    }
  }

  return (
    <DrawerSection icon={<KeyRound className="h-4 w-4" />} title={t("admin.users.drawer.access")}>
      <div className="space-y-2">
        {/* Active toggle */}
        <label className="flex items-center justify-between gap-3 rounded-xl border border-outline-soft bg-surface px-4 py-3">
          <div>
            <div className="text-sm font-medium text-ink">{t("admin.users.drawer.accountActive")}</div>
            <div className="text-xs text-ink-mute">
              {user.is_active
                ? t("admin.users.drawer.accountActiveBody")
                : t("admin.users.drawer.accountDisabledBody")}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {lastAdmin && user.is_active && (
              <span className="hidden text-[10px] uppercase tracking-wider text-ink-mute sm:inline">
                {t("admin.users.drawer.lastAdminHint")}
              </span>
            )}
            <Switch
              checked={user.is_active}
              disabled={busy === "active" || (lastAdmin && user.is_active)}
              onCheckedChange={(v) => patch({ is_active: v }, "active")}
            />
          </div>
        </label>

        {/* Role toggle — admins vs users */}
        <label className="flex items-center justify-between gap-3 rounded-xl border border-outline-soft bg-surface px-4 py-3">
          <div>
            <div className="text-sm font-medium text-ink">{t("admin.users.drawer.roleAdmin")}</div>
            <div className="text-xs text-ink-mute">{t("admin.users.drawer.roleAdminBody")}</div>
          </div>
          <Switch
            checked={user.role === "admin"}
            disabled={busy === "role" || (lastAdmin && user.role === "admin")}
            onCheckedChange={(v) => patch({ role: v ? "admin" : "user" }, "role")}
          />
        </label>

        {/* Reset password */}
        {!showReset ? (
          <button
            type="button"
            onClick={() => setShowReset(true)}
            className="flex w-full items-center justify-between gap-3 rounded-xl border border-outline-soft bg-surface px-4 py-3 text-left transition-colors hover:border-outline hover:bg-surface-2"
          >
            <div>
              <div className="text-sm font-medium text-ink">{t("admin.users.drawer.resetPassword")}</div>
              <div className="text-xs text-ink-mute">{t("admin.users.drawer.resetPasswordBody")}</div>
            </div>
            <span className="text-xs text-primary">→</span>
          </button>
        ) : (
          <div className="rounded-xl border border-primary/40 bg-primary-container/20 p-4">
            <Label htmlFor={`pw-${user.id}`} className="text-xs font-medium text-ink-soft">
              {t("admin.users.drawer.newPasswordLabel")}
            </Label>
            <div className="mt-1 flex gap-2">
              <div className="relative flex-1">
                <Input
                  id={`pw-${user.id}`}
                  type={revealPw ? "text" : "password"}
                  autoComplete="new-password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  className="pr-20 font-mono"
                  placeholder="••••••••"
                />
                <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => setRevealPw((r) => !r)}
                    className="flex h-8 w-8 items-center justify-center rounded-pill text-ink-mute hover:bg-surface-2 hover:text-ink"
                    aria-label={revealPw ? "Hide" : "Show"}
                  >
                    {revealPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewPw(generatePassword())}
                    className="flex h-8 w-8 items-center justify-center rounded-pill text-ink-mute hover:bg-surface-2 hover:text-ink"
                    aria-label="Generate"
                    title={t("admin.users.drawer.generate")}
                  >
                    <Dices className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-ink-mute">
              {t("admin.users.drawer.resetPasswordWarn")}
            </p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="filled" disabled={savingPw || newPw.length < 8} onClick={resetPassword}>
                {savingPw ? t("common.saving") : t("admin.users.drawer.confirmReset")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setShowReset(false); setNewPw(""); }}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </DrawerSection>
  );
}


/* -------------------------------------------------------------------------- */
/*  Quota form                                                                 */
/* -------------------------------------------------------------------------- */

function QuotaForm({
  user,
  onSaved,
}: {
  user: CurrentUser;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [apps, setApps] = useState<string>(user.quota_max_apps?.toString() ?? "");
  const [storageMB, setStorageMB] = useState<string>(
    user.quota_max_storage_bytes != null
      ? Math.floor(user.quota_max_storage_bytes / (1024 * 1024)).toString()
      : "",
  );
  const [monthly, setMonthly] = useState<string>(user.quota_max_apks_per_month?.toString() ?? "");
  const [busy, setBusy] = useState(false);

  function parseOrNull(s: string): number | null {
    const trimmed = s.trim();
    if (!trimmed) return null;
    const n = parseInt(trimmed, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  async function save() {
    setBusy(true);
    const payload: AdminUpdateUser = {};
    const a = parseOrNull(apps);
    if (a == null) payload.quota_reset_apps = true;
    else payload.quota_max_apps = a;

    const s = parseOrNull(storageMB);
    if (s == null) payload.quota_reset_storage_bytes = true;
    else payload.quota_max_storage_bytes = s * 1024 * 1024;

    const m = parseOrNull(monthly);
    if (m == null) payload.quota_reset_apks_per_month = true;
    else payload.quota_max_apks_per_month = m;

    try {
      await api.admin.updateUser(user.id, payload);
      toast.success(t("admin.users.quotaSaved"));
      await onSaved();
    } catch (e) {
      toast.error(t("admin.users.quotaSaveFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <QuotaInput
          id={`q-apps-${user.id}`}
          label={t("admin.users.quotaApps")}
          placeholder={t("admin.users.quotaInherit")}
          value={apps}
          onChange={setApps}
        />
        <QuotaInput
          id={`q-storage-${user.id}`}
          label={t("admin.users.quotaStorage")}
          placeholder={t("admin.users.quotaInherit")}
          value={storageMB}
          onChange={setStorageMB}
        />
        <QuotaInput
          id={`q-monthly-${user.id}`}
          label={t("admin.users.quotaMonthly")}
          placeholder={t("admin.users.quotaInherit")}
          value={monthly}
          onChange={setMonthly}
        />
      </div>
      <div className="flex justify-end">
        <Button variant="filled" size="sm" onClick={save} disabled={busy}>
          {busy ? t("common.saving") : t("admin.users.drawer.saveQuotas")}
        </Button>
      </div>
    </div>
  );
}

function QuotaInput({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (s: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-[10px] uppercase tracking-wider text-ink-mute">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={0}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono"
      />
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Danger zone                                                                */
/* -------------------------------------------------------------------------- */

function DangerSection({
  user,
  activeAdminCount,
  onDeleted,
}: {
  user: CurrentUser;
  activeAdminCount: number;
  onDeleted: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const lastAdmin =
    user.role === "admin" && user.is_active && activeAdminCount <= 1;

  async function remove() {
    setBusy(true);
    try {
      await api.admin.deleteUser(user.id);
      toast.success(t("admin.users.deleted"));
      await onDeleted();
    } catch (e) {
      toast.error(t("admin.users.deleteFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <section className="rounded-2xl border-2 border-danger/30 p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-pill bg-danger-container text-danger-on-container">
          <Trash2 className="h-3.5 w-3.5" />
        </span>
        <h3 className="text-sm font-semibold tracking-tight text-danger">{t("admin.users.drawer.danger")}</h3>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-ink-soft">
        {t("admin.users.drawer.dangerBody", { username: user.username })}
      </p>
      {lastAdmin && (
        <p className="mb-3 rounded-xl border border-outline-soft bg-surface-2 px-3 py-2 text-[11px] text-ink-soft">
          {t("admin.users.drawer.dangerLastAdmin")}
        </p>
      )}
      {!confirming ? (
        <Button
          variant="danger"
          size="sm"
          disabled={lastAdmin}
          onClick={() => setConfirming(true)}
        >
          <Trash2 className="h-3.5 w-3.5" /> {t("admin.users.drawer.deleteAction")}
        </Button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-danger">
            {t("admin.users.drawer.confirmDeletePrompt")}
          </span>
          <Button variant="danger" size="sm" disabled={busy} onClick={remove}>
            {busy ? t("common.saving") : t("admin.users.drawer.confirmDelete")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            {t("common.cancel")}
          </Button>
        </div>
      )}
    </section>
  );
}


/* -------------------------------------------------------------------------- */
/*  Invite drawer — create user                                                */
/* -------------------------------------------------------------------------- */

function InviteDrawer({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState(generatePassword());
  const [reveal, setReveal] = useState(false);
  const [role, setRole] = useState<"user" | "admin">("user");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      await api.admin.createUser({ email, username, password, role });
      toast.success(t("admin.users.created", { username }));
      await onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("admin.users.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked — ignore */ }
  }

  return (
    <>
      <SheetHeader onClose={onClose}>
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-container text-primary-on-container">
            <UserPlus className="h-5 w-5" />
          </span>
          <div>
            <div className="font-mono text-base font-semibold text-ink">{t("admin.users.drawer.inviteTitle")}</div>
            <div className="text-xs text-ink-mute">{t("admin.users.drawer.inviteBody")}</div>
          </div>
        </div>
      </SheetHeader>

      <form onSubmit={submit} className="space-y-5 px-6 py-6">
        <div className="space-y-1.5">
          <Label htmlFor="ie" className="text-xs font-medium text-ink-soft">
            {t("admin.users.fields.email")}
          </Label>
          <Input
            id="ie"
            type="email"
            autoComplete="off"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="alice@example.org"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="iu" className="text-xs font-medium text-ink-soft">
            {t("admin.users.fields.username")}
          </Label>
          <Input
            id="iu"
            autoComplete="off"
            required
            pattern="[a-zA-Z0-9_.\-]+"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="alice"
            className="font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ip" className="text-xs font-medium text-ink-soft">
            {t("admin.users.fields.password")}
          </Label>
          <div className="relative">
            <Input
              id="ip"
              type={reveal ? "text" : "password"}
              autoComplete="new-password"
              minLength={8}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pr-24 font-mono"
            />
            <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => setReveal((r) => !r)}
                className="flex h-8 w-8 items-center justify-center rounded-pill text-ink-mute hover:bg-surface-2 hover:text-ink"
                aria-label={reveal ? "Hide" : "Show"}
              >
                {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={copyPassword}
                className="flex h-8 w-8 items-center justify-center rounded-pill text-ink-mute hover:bg-surface-2 hover:text-ink"
                aria-label="Copy"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => setPassword(generatePassword())}
                className="flex h-8 w-8 items-center justify-center rounded-pill text-ink-mute hover:bg-surface-2 hover:text-ink"
                aria-label="Regenerate"
                title={t("admin.users.drawer.generate")}
              >
                <Dices className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <p className="text-[11px] text-ink-mute">{t("admin.users.drawer.inviteCopyHint")}</p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-ink-soft">{t("admin.users.fields.role")}</Label>
          <div className="grid grid-cols-2 gap-2">
            <RoleCard
              active={role === "user"}
              onClick={() => setRole("user")}
              title={t("admin.users.role.user")}
              body={t("admin.users.drawer.roleUserBody")}
            />
            <RoleCard
              active={role === "admin"}
              onClick={() => setRole("admin")}
              title={t("admin.users.role.admin")}
              body={t("admin.users.drawer.roleAdminBodyShort")}
            />
          </div>
        </div>

        {err && (
          <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">
            {err}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="filled" disabled={busy}>
            {busy ? t("common.saving") : t("admin.users.drawer.createUser")}
          </Button>
        </div>
      </form>
    </>
  );
}


function RoleCard({
  active,
  title,
  body,
  onClick,
}: {
  active: boolean;
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left text-xs transition-colors",
        active
          ? "border-primary bg-primary-container/40 text-primary-on-container"
          : "border-outline-soft bg-surface text-ink-soft hover:border-outline hover:bg-surface-2",
      )}
    >
      <span className="text-sm font-semibold tracking-tight">{title}</span>
      <span className="text-[11px] leading-relaxed opacity-80">{body}</span>
    </button>
  );
}


/* -------------------------------------------------------------------------- */
/*  Skeleton + empty state                                                     */
/* -------------------------------------------------------------------------- */

function SkeletonList() {
  return (
    <ul className="space-y-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <li
          key={i}
          className="flex items-center gap-4 rounded-2xl border border-outline-soft bg-surface px-4 py-3"
          style={{ animationDelay: `${i * 60}ms` }}
        >
          <div className="h-10 w-10 animate-pulse rounded-2xl bg-surface-2" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-32 animate-pulse rounded-pill bg-surface-2" />
            <div className="h-2 w-48 animate-pulse rounded-pill bg-surface-2" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({
  query,
  filter,
  onReset,
}: {
  query: string;
  filter: FilterKey;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const isFiltered = !!query || filter !== "all";
  return (
    <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-outline-soft bg-surface-2/30 px-6 py-16 text-center">
      <div className="text-3xl">🪐</div>
      <p className="text-sm font-medium text-ink">
        {isFiltered ? t("admin.users.emptyFilter") : t("admin.users.emptyUsers")}
      </p>
      {isFiltered && (
        <Button variant="outlined" size="sm" onClick={onReset}>
          {t("admin.users.clearFilters")}
        </Button>
      )}
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function generatePassword(length = 16): string {
  // Hand-rolled CSPRNG-backed password: 16 chars from an ambiguous-free
  // alphabet (drop O/0/I/l/1) so admins can dictate it verbally to a
  // user without confusion.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*";
  const arr = new Uint32Array(length);
  if (typeof window !== "undefined" && window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(arr);
  } else {
    // Server-side fallback (shouldn't actually run — the drawer is
    // client-only — but TypeScript demands a path).
    for (let i = 0; i < length; i++) arr[i] = Math.floor(Math.random() * 2 ** 32);
  }
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[arr[i] % alphabet.length];
  return out;
}
