"use client";

import {
  Check,
  ChevronRight,
  Copy,
  Download,
  EyeOff,
  Fingerprint,
  Globe2,
  Key,
  KeyRound,
  ShieldCheck,
  Trash2,
  UserCircle2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { PasskeysSection, QuotaUsageSection, SessionsSection, TotpSection } from "@/components/account-security";
import { AuthGuard } from "@/components/auth-guard";
import { RepoQrCode } from "@/components/repo-qr-code";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, API_URL, getAccessToken, type ApiKey, type CurrentUser } from "@/lib/api";
import { COMMON_LOCALES, localeLabel } from "@/lib/locales";
import { fdroidDeepLink, useRepoInfo } from "@/lib/repo-store";
import { useAuth } from "@/lib/auth-store";
import { cn, formatDate } from "@/lib/utils";


type TabKey = "profile" | "security" | "tokens";


/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

function AccountInner() {
  const { t } = useTranslation();
  const { user, fetchMe } = useAuth();

  // Active tab — synchronized with the URL hash so deep links like
  // /account#security land directly on the right pane.
  const [tab, setTab] = useState<TabKey>("profile");
  useEffect(() => {
    function fromHash() {
      const raw = (window.location.hash || "").replace("#", "");
      if (raw === "security" || raw === "tokens" || raw === "profile") {
        setTab(raw);
      } else {
        setTab("profile");
      }
    }
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);
  function goTab(next: TabKey) {
    setTab(next);
    // Use replaceState so the user can still hit Back to leave /account
    // without paging through tab switches.
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.hash = next;
      window.history.replaceState(null, "", url);
    }
  }

  if (!user) return null;
  const hue = hueFor(user.username);

  return (
    <div className="space-y-8 pb-12">
      <AccountHero user={user} hue={hue} />

      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <SideNav tab={tab} onPick={goTab} user={user} />
        <div className="min-w-0">
          {tab === "profile" && <ProfilePane user={user} fetchMe={fetchMe} />}
          {tab === "security" && <SecurityPane user={user} />}
          {tab === "tokens" && <TokensPane />}
        </div>
      </div>
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Hero — avatar + identity                                                   */
/* -------------------------------------------------------------------------- */

function AccountHero({ user, hue }: { user: CurrentUser; hue: number }) {
  const { t } = useTranslation();
  return (
    <header
      className="relative overflow-hidden rounded-3xl border border-outline-soft bg-surface px-6 py-7 md:px-10 md:py-9"
    >
      {/* User-coloured gradient mesh. The hue is derived from the
          username, so every account wears a slightly different
          atmosphere — distinct from the other admin/personal pages
          and personalised at zero design cost. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: [
            `radial-gradient(55% 70% at 0% 0%, hsl(${hue} 70% 55% / 0.18), transparent 60%)`,
            `radial-gradient(40% 60% at 100% 100%, hsl(${(hue + 60) % 360} 65% 50% / 0.12), transparent 65%)`,
          ].join(", "),
        }}
      />
      {/* Concentric arc decoration in the bottom-right — geometric flair
          unique to this page. Hidden on small screens to avoid clutter. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-20 -top-20 hidden h-72 w-72 md:block"
        style={{
          backgroundImage: [
            "radial-gradient(circle at center, transparent 60%, transparent 62%, rgb(var(--ink) / 0.05) 62%, rgb(var(--ink) / 0.05) 63%, transparent 63%)",
            "radial-gradient(circle at center, transparent 45%, transparent 47%, rgb(var(--ink) / 0.05) 47%, rgb(var(--ink) / 0.05) 48%, transparent 48%)",
            "radial-gradient(circle at center, transparent 30%, transparent 32%, rgb(var(--ink) / 0.05) 32%, rgb(var(--ink) / 0.05) 33%, transparent 33%)",
          ].join(", "),
        }}
      />

      <div className="relative flex flex-wrap items-center gap-5">
        <Avatar name={user.username} hue={hue} size={88} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-3xl font-bold tracking-tight text-ink md:text-4xl">
            {user.full_name || user.username}
          </h1>
          <p className="mt-0.5 truncate font-mono text-xs text-ink-mute">{user.email}</p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Badge variant={user.role === "admin" ? "primary" : "outline"}>
              {user.role === "admin" ? t("account.role.admin") : t("account.role.user")}
            </Badge>
            <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
              {user.auth_provider}
            </Badge>
            <span className="font-mono text-[10px] text-ink-mute">
              {t("account.memberSince", { date: formatDate(user.created_at) })}
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}


function hueFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function Avatar({ name, hue, size }: { name: string; hue: number; size: number }) {
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-3xl font-mono font-bold text-white shadow-e2"
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
/*  Side nav                                                                   */
/* -------------------------------------------------------------------------- */

function SideNav({
  tab,
  onPick,
  user,
}: {
  tab: TabKey;
  onPick: (t: TabKey) => void;
  user: CurrentUser;
}) {
  const { t } = useTranslation();
  const items: { key: TabKey; label: string; sub: string; icon: React.ReactNode }[] = [
    {
      key: "profile",
      label: t("account.nav.profile"),
      sub: t("account.nav.profileSub"),
      icon: <UserCircle2 className="h-4 w-4" />,
    },
    {
      key: "security",
      label: t("account.nav.security"),
      sub: user.auth_provider === "local" ? t("account.nav.securitySubLocal") : t("account.nav.securitySubOidc"),
      icon: <ShieldCheck className="h-4 w-4" />,
    },
    {
      key: "tokens",
      label: t("account.nav.tokens"),
      sub: t("account.nav.tokensSub"),
      icon: <Key className="h-4 w-4" />,
    },
  ];

  return (
    <nav className="lg:sticky lg:top-20 lg:self-start">
      {/* Mobile: horizontal scrolling pills. Desktop: vertical list. */}
      <ul className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
        {items.map((it) => {
          const active = tab === it.key;
          return (
            <li key={it.key} className="shrink-0 lg:shrink">
              <button
                type="button"
                onClick={() => onPick(it.key)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left transition-colors",
                  active
                    ? "border-primary bg-primary-container/40 text-primary-on-container shadow-e1"
                    : "border-transparent text-ink-soft hover:bg-surface-2 hover:text-ink",
                )}
              >
                <span className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-pill",
                  active ? "bg-primary text-primary-fg" : "bg-surface-2 text-ink-soft",
                )}>
                  {it.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{it.label}</span>
                  <span className="block truncate text-[10px] text-ink-mute lg:block">{it.sub}</span>
                </span>
                <ChevronRight
                  className={cn(
                    "hidden h-3.5 w-3.5 shrink-0 text-ink-mute transition-transform lg:block",
                    active && "translate-x-0.5 text-primary",
                  )}
                />
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}


/* -------------------------------------------------------------------------- */
/*  Card primitive                                                             */
/* -------------------------------------------------------------------------- */

function Card({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-3xl border border-outline-soft bg-surface p-6 shadow-e1">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-ink-soft">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-bold tracking-tight text-ink">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs leading-relaxed text-ink-mute">{subtitle}</p>}
        </div>
      </header>
      {children}
    </section>
  );
}


function Field({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-xs font-medium uppercase tracking-wider text-ink-mute">
        {label}
      </Label>
      {children}
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Profile pane                                                               */
/* -------------------------------------------------------------------------- */

function ProfilePane({
  user,
  fetchMe,
}: {
  user: CurrentUser;
  fetchMe: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [fullName, setFullName] = useState(user.full_name || "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => { setFullName(user.full_name || ""); }, [user.full_name]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      await api.updateMe({ full_name: fullName });
      await fetchMe();
      setMsg({ kind: "ok", text: t("account.saved") });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : t("account.saveFailed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Identity (read-only) */}
      <Card
        icon={<UserCircle2 className="h-4 w-4" />}
        title={t("account.profile.identityTitle")}
        subtitle={t("account.profile.identitySubtitle")}
      >
        <dl className="grid gap-3 md:grid-cols-2">
          <ReadField label={t("account.fields.email")} value={user.email} mono />
          <ReadField label={t("account.fields.username")} value={user.username} mono />
        </dl>
      </Card>

      {/* Display name */}
      <Card
        icon={<UserCircle2 className="h-4 w-4" />}
        title={t("account.profile.displayNameTitle")}
        subtitle={t("account.profile.displayNameSubtitle")}
      >
        <form onSubmit={save} className="space-y-3">
          <Field label={t("account.fields.fullName")} htmlFor="fn">
            <Input
              id="fn"
              value={fullName}
              maxLength={255}
              onChange={(e) => setFullName(e.target.value)}
              placeholder={t("account.profile.displayNamePlaceholder")}
            />
          </Field>
          <div className="flex items-center justify-end gap-3">
            {msg && (
              <span className={cn(
                "text-xs",
                msg.kind === "ok" ? "text-primary" : "text-danger",
              )}>
                {msg.text}
              </span>
            )}
            <Button type="submit" variant="filled" size="sm" disabled={busy}>
              {busy ? t("common.saving") : t("account.saveProfile")}
            </Button>
          </div>
        </form>
      </Card>

      {/* Language */}
      <LanguageCard user={user} fetchMe={fetchMe} />

      {/* NSFW toggle */}
      <NsfwCard user={user} fetchMe={fetchMe} />

      {/* GDPR data export */}
      <DataExportCard user={user} />
    </div>
  );
}


function ReadField({
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
      <dt className="text-[10px] uppercase tracking-wider text-ink-mute">{label}</dt>
      <dd className={cn("mt-1 truncate text-sm text-ink-soft", mono && "font-mono")}>{value}</dd>
    </div>
  );
}


function LanguageCard({
  user,
  fetchMe,
}: {
  user: CurrentUser;
  fetchMe: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [preferredLocale, setPreferredLocale] = useState<string | null>(user.preferred_locale ?? null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [customLocale, setCustomLocale] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => { setPreferredLocale(user.preferred_locale ?? null); }, [user.preferred_locale]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  async function setLocale(next: string | null) {
    if (next === preferredLocale) return;
    const prev = preferredLocale;
    setPreferredLocale(next);
    setOpen(false); setCustomLocale("");
    setBusy(true); setMsg(null);
    try {
      await api.updateMe({ preferred_locale: next });
      await fetchMe();
      setMsg({
        kind: "ok",
        text: next
          ? t("account.languagePicker.saved", { name: localeLabel(next).label })
          : t("account.languagePicker.cleared"),
      });
    } catch (e) {
      setPreferredLocale(prev);
      setMsg({ kind: "err", text: e instanceof Error ? e.message : t("account.languagePicker.updateFailed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      icon={<Globe2 className="h-4 w-4" />}
      title={t("account.profile.languageTitle")}
      subtitle={t("account.profile.languageSubtitle")}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div ref={ref} className="relative">
          <Button
            type="button"
            variant="outlined"
            size="md"
            onClick={() => setOpen((o) => !o)}
            disabled={busy}
            className="min-w-[10rem] justify-between"
          >
            <span className="truncate">
              {preferredLocale ? localeLabel(preferredLocale).label : t("account.languagePicker.defaultLabel")}
            </span>
            <span className="ml-2 font-mono text-[10px] text-ink-mute">
              {preferredLocale ?? "—"}
            </span>
          </Button>
          {open && (
            <div className="absolute left-0 top-12 z-20 w-80 rounded-2xl border border-outline-soft bg-surface p-3 shadow-e3">
              <div className="mb-2 flex items-center justify-between gap-2 px-1 text-[10px] uppercase tracking-wider text-ink-mute">
                <span>{t("account.languagePicker.pickPrompt")}</span>
                {preferredLocale && (
                  <button
                    type="button"
                    onClick={() => setLocale(null)}
                    className="font-mono normal-case tracking-tight text-ink-mute hover:text-danger"
                  >
                    {t("account.languagePicker.reset")}
                  </button>
                )}
              </div>
              <div className="max-h-72 space-y-0.5 overflow-y-auto">
                {COMMON_LOCALES.map((l) => {
                  const active = l.code === preferredLocale;
                  return (
                    <button
                      key={l.code}
                      type="button"
                      onClick={() => setLocale(l.code)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors",
                        active
                          ? "bg-primary-container text-primary-on-container"
                          : "hover:bg-surface-2",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{l.label}</span>
                        {l.native !== l.label && (
                          <span className="block truncate text-xs opacity-70">{l.native}</span>
                        )}
                      </span>
                      <span className="font-mono text-[10px] opacity-70">{l.code}</span>
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 border-t border-outline-soft pt-2">
                <div className="mb-1 px-1 text-[10px] uppercase tracking-wider text-ink-mute">
                  {t("account.languagePicker.other")}
                </div>
                <div className="flex gap-1.5 px-1">
                  <Input
                    placeholder={t("account.languagePicker.otherPlaceholder")}
                    value={customLocale}
                    onChange={(e) => setCustomLocale(e.target.value)}
                    className="h-9"
                  />
                  <Button
                    type="button"
                    variant="outlined"
                    size="sm"
                    onClick={() => setLocale(customLocale.trim() || null)}
                    disabled={!customLocale.trim()}
                  >
                    {t("account.languagePicker.use")}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
        {msg && (
          <span className={cn(
            "text-xs",
            msg.kind === "ok" ? "text-primary" : "text-danger",
          )}>
            {msg.text}
          </span>
        )}
      </div>
    </Card>
  );
}


function NsfwCard({
  user,
  fetchMe,
}: {
  user: CurrentUser;
  fetchMe: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [showNsfw, setShowNsfw] = useState(user.show_nsfw);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => { setShowNsfw(user.show_nsfw); }, [user.show_nsfw]);

  async function toggle(next: boolean) {
    setShowNsfw(next); setBusy(true); setMsg(null);
    try {
      await api.updateMe({ show_nsfw: next });
      await fetchMe();
      setMsg({ kind: "ok", text: next ? t("account.nsfwToggle.shown") : t("account.nsfwToggle.hidden") });
    } catch (e) {
      setShowNsfw(!next);
      setMsg({ kind: "err", text: e instanceof Error ? e.message : t("account.nsfwToggle.updateFailed") });
    } finally { setBusy(false); }
  }

  return (
    <Card
      icon={<EyeOff className="h-4 w-4" />}
      title={t("account.nsfwToggle.title")}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="flex-1 text-xs leading-relaxed text-ink-mute">
          <Trans
            i18nKey="account.nsfwToggle.body"
            components={{ code: <span className="font-mono" /> }}
          />
        </p>
        <Switch
          ariaLabel={t("account.nsfwToggle.title")}
          checked={showNsfw}
          disabled={busy}
          onCheckedChange={toggle}
        />
      </div>
      {msg && (
        <p className={cn(
          "mt-2 text-xs",
          msg.kind === "ok" ? "text-primary" : "text-danger",
        )}>
          {msg.text}
        </p>
      )}
    </Card>
  );
}


function DataExportCard({ user }: { user: CurrentUser }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function download() {
    setBusy(true);
    setMsg(null);
    try {
      const token = getAccessToken();
      if (!token) throw new Error("Not authenticated");
      const res = await fetch(`${API_URL}/api/v1/me/export`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      // Pull the filename from Content-Disposition; fall back to a sane
      // default if the header is stripped by a CDN.
      const dispo = res.headers.get("content-disposition") || "";
      const match = dispo.match(/filename="([^"]+)"/);
      const filename =
        match?.[1] ||
        `fdroid-store-export-${user.username}-${new Date().toISOString().slice(0, 10)}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMsg({ kind: "ok", text: t("account.export.success") });
    } catch (e) {
      setMsg({
        kind: "err",
        text: e instanceof Error ? e.message : t("account.export.failed"),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      icon={<Download className="h-4 w-4" />}
      title={t("account.export.title")}
    >
      <p className="text-xs leading-relaxed text-ink-mute">
        {t("account.export.body")}
      </p>
      <div className="mt-4 flex items-center gap-3">
        <Button variant="filled" size="sm" disabled={busy} onClick={download}>
          {busy ? t("account.export.busy") : t("account.export.button")}
        </Button>
        {msg && (
          <span
            className={cn(
              "text-xs",
              msg.kind === "ok" ? "text-primary" : "text-danger",
            )}
          >
            {msg.text}
          </span>
        )}
      </div>
    </Card>
  );
}


/* -------------------------------------------------------------------------- */
/*  Security pane                                                              */
/* -------------------------------------------------------------------------- */

function SecurityPane({ user }: { user: CurrentUser }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      {user.auth_provider === "local" && <PasswordCard />}

      <Card
        icon={<KeyRound className="h-4 w-4" />}
        title={t("account.sections.totp")}
      >
        <TotpSection />
      </Card>

      <Card
        icon={<Fingerprint className="h-4 w-4" />}
        title={t("account.sections.passkeys")}
      >
        <PasskeysSection />
      </Card>

      <Card
        icon={<ShieldCheck className="h-4 w-4" />}
        title={t("account.sections.sessions")}
      >
        <SessionsSection />
      </Card>
    </div>
  );
}


function PasswordCard() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      await api.changePassword({ current_password: current, new_password: next });
      setCurrent(""); setNext("");
      setMsg({ kind: "ok", text: t("account.passwordChanged") });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : t("account.saveFailed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      icon={<KeyRound className="h-4 w-4" />}
      title={t("account.sections.password")}
      subtitle={t("account.password.body")}
    >
      <form onSubmit={submit} className="grid gap-3 md:grid-cols-2">
        <Field label={t("account.fields.currentPassword")} htmlFor="cur">
          <Input id="cur" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label={t("account.fields.newPassword")} htmlFor="new">
          <Input id="new" type="password" autoComplete="new-password" minLength={8} required value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <div className="md:col-span-2 flex items-center justify-end gap-3">
          {msg && (
            <span className={cn(
              "text-xs",
              msg.kind === "ok" ? "text-primary" : "text-danger",
            )}>
              {msg.text}
            </span>
          )}
          <Button type="submit" variant="filled" size="sm" disabled={busy}>
            {busy ? t("common.saving") : t("account.changePassword")}
          </Button>
        </div>
      </form>
    </Card>
  );
}


/* -------------------------------------------------------------------------- */
/*  Tokens pane                                                                */
/* -------------------------------------------------------------------------- */

function TokensPane() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [keyName, setKeyName] = useState("");
  const [canDownloadPrivate, setCanDownloadPrivate] = useState(true);
  const [canManageApps, setCanManageApps] = useState(false);
  const [expiresIn, setExpiresIn] = useState("");
  const [newlyCreated, setNewlyCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refreshKeys() {
    try { setKeys(await api.apiKeys.list()); }
    catch (e) { setErr(e instanceof Error ? e.message : t("errors.loadFailed")); }
  }
  useEffect(() => { refreshKeys(); /* eslint-disable-next-line */ }, []);

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setNewlyCreated(null); setBusy(true);
    try {
      const k = await api.apiKeys.create({
        name: keyName,
        can_download_private: canDownloadPrivate,
        can_manage_apps: canManageApps,
        expires_in_days: expiresIn ? Number(expiresIn) : undefined,
      });
      setNewlyCreated(k.full_key);
      setKeyName("");
      await refreshKeys();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("account.apiKey.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey(id: string) {
    if (!confirm(t("account.apiKey.revokeConfirm"))) return;
    try { await api.apiKeys.revoke(id); await refreshKeys(); }
    catch (e) { setErr(e instanceof Error ? e.message : t("account.apiKey.revokeFailed")); }
  }

  return (
    <div className="space-y-4">
      {/* Quotas first — they frame the budget the user is spending */}
      <Card
        icon={<KeyRound className="h-4 w-4" />}
        title={t("account.sections.quotas")}
      >
        <QuotaUsageSection />
      </Card>

      {err && (
        <p className="rounded-2xl border border-danger bg-danger-container px-4 py-3 text-sm text-danger-on-container">
          {err}
        </p>
      )}

      {/* New key celebration */}
      {newlyCreated && user && (
        <NewKeyCelebration
          secret={newlyCreated}
          username={user.username}
          onDismiss={() => setNewlyCreated(null)}
        />
      )}

      {/* Create form */}
      <Card
        icon={<Key className="h-4 w-4" />}
        title={t("account.sections.apiKeys")}
        subtitle={t("account.sections.apiKeysSubtitle")}
      >
        <form onSubmit={createKey} className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[1.6fr_1fr_auto] md:items-end">
            <Field label={t("account.apiKey.label")} htmlFor="kn">
              <Input id="kn" required placeholder={t("account.apiKey.labelPlaceholder")} value={keyName} onChange={(e) => setKeyName(e.target.value)} />
            </Field>
            <Field label={t("account.apiKey.expiresDays")} htmlFor="exp">
              <Input id="exp" type="number" min={1} placeholder={t("account.apiKey.neverExpires")} value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)} />
            </Field>
            <Button type="submit" variant="filled" disabled={busy}>
              <Key className="h-4 w-4" /> {busy ? t("common.saving") : t("account.apiKey.create")}
            </Button>
          </div>

          {/* Capability cards — replace the bare checkboxes with explicit
              clickable cards explaining each scope. */}
          <div className="grid gap-2 sm:grid-cols-2">
            <CapabilityCard
              checked={canDownloadPrivate}
              onChange={setCanDownloadPrivate}
              title={t("account.apiKey.canDownloadPrivate")}
              body={t("account.apiKey.canDownloadPrivateBody")}
            />
            <CapabilityCard
              checked={canManageApps}
              onChange={setCanManageApps}
              title={t("account.apiKey.canManageApps")}
              body={t("account.apiKey.canManageAppsBody")}
            />
          </div>
        </form>

        {/* Existing keys */}
        <ul className="mt-6 space-y-2">
          {keys.length === 0 && (
            <li className="rounded-xl border border-dashed border-outline px-4 py-8 text-center italic text-ink-mute">
              {t("account.apiKey.noKeys")}
            </li>
          )}
          {keys.map((k) => (
            <KeyRow key={k.id} apiKey={k} onRevoke={() => revokeKey(k.id)} />
          ))}
        </ul>
      </Card>
    </div>
  );
}


function CapabilityCard({
  checked,
  onChange,
  title,
  body,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  body: string;
}) {
  return (
    <label className={cn(
      "flex cursor-pointer items-start gap-3 rounded-2xl border px-3 py-2.5 text-left transition-colors",
      checked
        ? "border-primary bg-primary-container/30"
        : "border-outline-soft bg-surface hover:border-outline hover:bg-surface-2",
    )}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1"
      />
      <div className="min-w-0">
        <div className={cn(
          "text-sm font-semibold",
          checked ? "text-primary-on-container" : "text-ink",
        )}>
          {title}
        </div>
        <div className="mt-0.5 text-[11px] leading-relaxed text-ink-soft">{body}</div>
      </div>
    </label>
  );
}


function KeyRow({ apiKey: k, onRevoke }: { apiKey: ApiKey; onRevoke: () => void }) {
  const { t } = useTranslation();
  const revoked = !!k.revoked_at;
  return (
    <li className={cn(
      "flex flex-wrap items-center gap-3 rounded-2xl border bg-surface px-4 py-3 transition-colors",
      revoked ? "border-outline-soft opacity-70" : "border-outline-soft hover:border-outline",
    )}>
      <div className="flex h-10 w-10 items-center justify-center rounded-pill bg-surface-2">
        <Key className="h-4 w-4 text-ink-soft" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-ink">{k.name}</div>
        <div className="font-mono text-[11px] text-ink-mute">fdr_{k.prefix}_…</div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {k.can_download_private && <Badge variant="outline" className="text-[10px] uppercase tracking-wider">{t("account.apiKey.privateDl")}</Badge>}
        {k.can_manage_apps && <Badge variant="outline" className="text-[10px] uppercase tracking-wider">{t("account.apiKey.manage")}</Badge>}
        {revoked
          ? <Badge variant="destructive">{t("account.apiKey.revoked")}</Badge>
          : <Badge variant="primary">{t("account.apiKey.active")}</Badge>}
      </div>
      <div className="hidden text-right text-[11px] text-ink-mute md:block">
        <div>{t("account.apiKey.used")} <span className="font-mono">{formatDate(k.last_used_at)}</span></div>
        <div>{t("account.apiKey.expires")} <span className="font-mono">{formatDate(k.expires_at)}</span></div>
      </div>
      {!revoked && (
        <Button size="sm" variant="outlined" onClick={onRevoke}>
          <Trash2 className="h-3.5 w-3.5" /> {t("account.apiKey.revoke")}
        </Button>
      )}
    </li>
  );
}


/* -------------------------------------------------------------------------- */
/*  New-key celebration (unchanged behaviour, restyled card)                   */
/* -------------------------------------------------------------------------- */

function NewKeyCelebration({
  secret,
  username,
  onDismiss,
}: {
  secret: string;
  username: string;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {/* clipboard blocked */}
  }
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(id);
  }, [copied]);

  const repo = useRepoInfo();
  const authUrl = fdroidDeepLink(repo.url, {
    credentials: { username, secret },
    fingerprint: repo.fingerprint,
  });

  return (
    <div className="relative animate-fade-up overflow-hidden rounded-3xl border-2 border-primary/40 bg-surface p-5 shadow-e2">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 80% at 100% 0%, rgb(var(--primary) / 0.12), transparent 70%)",
        }}
      />
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("common.close")}
        className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-pill text-ink-mute transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="relative flex flex-col gap-2">
        <div className="inline-flex w-fit items-center gap-2 rounded-pill bg-primary-container px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-primary-on-container">
          {t("account.apiKey.newKey")}
        </div>
        <h3 className="text-xl font-bold tracking-tight text-ink">
          {t("account.apiKey.newKeyTitle")}
        </h3>
        <p className="text-sm text-ink-soft">{t("account.apiKey.newKeyBody")}</p>
      </div>

      <div className="relative mt-5 grid items-center gap-6 md:grid-cols-[auto_1fr]">
        <RepoQrCode
          credentials={{ username, secret }}
          size={208}
          showCaption
          className="mx-auto md:mx-0"
        />
        <div className="space-y-3 text-sm">
          <Credential label={t("account.apiKey.fullKey")} value={secret} mono onCopy={copyKey} copied={copied} />
          <Credential label={t("account.apiKey.username")} value={username} mono />
          <Credential label={t("account.apiKey.encodedUrl")} value={authUrl} mono small />
          <p className="text-xs text-ink-mute">{t("account.apiKey.usernameNote")}</p>
        </div>
      </div>
    </div>
  );
}


function Credential({
  label,
  value,
  mono,
  small,
  onCopy,
  copied,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
  onCopy?: () => void;
  copied?: boolean;
}) {
  const [localCopied, setLocalCopied] = useState(false);
  async function fallbackCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setLocalCopied(true);
      setTimeout(() => setLocalCopied(false), 1800);
    } catch {/* ignore */}
  }
  const visibleCopied = onCopy ? !!copied : localCopied;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-mute">{label}</div>
      <div className="mt-0.5 flex items-center gap-2">
        <code
          className={cn(
            "min-w-0 flex-1 select-all break-all rounded-xl border border-outline-soft bg-surface px-3 py-2",
            mono && "font-mono",
            small ? "text-[10px]" : "text-xs",
          )}
        >
          {value}
        </code>
        <Button
          type="button"
          variant="tonal"
          size="icon-sm"
          onClick={onCopy ?? fallbackCopy}
          aria-label={label}
        >
          {visibleCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/*  Page export                                                                */
/* -------------------------------------------------------------------------- */

export default function AccountPage() {
  return (
    <AuthGuard>
      <AccountInner />
    </AuthGuard>
  );
}
