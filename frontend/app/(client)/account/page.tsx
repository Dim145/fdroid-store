"use client";

import { Check, Copy, EyeOff, Globe2, Key, Trash2, User as UserIcon, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { QuotaUsageSection, SessionsSection, TotpSection } from "@/components/account-security";
import { AuthGuard } from "@/components/auth-guard";
import { RepoQrCode } from "@/components/repo-qr-code";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, type ApiKey } from "@/lib/api";
import { COMMON_LOCALES, localeLabel } from "@/lib/locales";
import { fdroidDeepLink, useRepoInfo } from "@/lib/repo-store";
import { useAuth } from "@/lib/auth-store";
import { cn, formatDate } from "@/lib/utils";

function AccountInner() {
  const { t } = useTranslation();
  const { user, fetchMe } = useAuth();
  const [fullName, setFullName] = useState(user?.full_name || "");
  const [showNsfw, setShowNsfw] = useState(user?.show_nsfw ?? false);
  const [nsfwBusy, setNsfwBusy] = useState(false);
  const [preferredLocale, setPreferredLocale] = useState<string | null>(user?.preferred_locale ?? null);
  const [localeBusy, setLocaleBusy] = useState(false);
  const [localePickerOpen, setLocalePickerOpen] = useState(false);
  const [customLocale, setCustomLocale] = useState("");
  const localePickerRef = useRef<HTMLDivElement>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [keyName, setKeyName] = useState("");
  const [canDownloadPrivate, setCanDownloadPrivate] = useState(true);
  const [canManageApps, setCanManageApps] = useState(false);
  const [expiresIn, setExpiresIn] = useState("");
  const [newlyCreated, setNewlyCreated] = useState<string | null>(null);

  useEffect(() => setFullName(user?.full_name || ""), [user]);
  useEffect(() => setShowNsfw(user?.show_nsfw ?? false), [user]);
  useEffect(() => setPreferredLocale(user?.preferred_locale ?? null), [user]);

  // Click-outside dismisses the locale dropdown.
  useEffect(() => {
    if (!localePickerOpen) return;
    function onClick(e: MouseEvent) {
      if (!localePickerRef.current?.contains(e.target as Node)) {
        setLocalePickerOpen(false);
      }
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [localePickerOpen]);

  async function setLocale(next: string | null) {
    if (next === preferredLocale) return;
    const previous = preferredLocale;
    setPreferredLocale(next);
    setLocalePickerOpen(false);
    setCustomLocale("");
    setLocaleBusy(true);
    setMsg(null); setErr(null);
    try {
      await api.updateMe({ preferred_locale: next });
      await fetchMe();
      setMsg(
        next
          ? t("account.languagePicker.saved", { name: localeLabel(next).label })
          : t("account.languagePicker.cleared"),
      );
    } catch (e) {
      setPreferredLocale(previous);
      setErr(e instanceof Error ? e.message : t("account.languagePicker.updateFailed"));
    } finally {
      setLocaleBusy(false);
    }
  }

  async function toggleNsfw(next: boolean) {
    setMsg(null); setErr(null);
    setShowNsfw(next);
    setNsfwBusy(true);
    try {
      await api.updateMe({ show_nsfw: next });
      await fetchMe();
      setMsg(next ? t("account.nsfwToggle.shown") : t("account.nsfwToggle.hidden"));
    } catch (e) {
      // Revert on failure so the UI doesn't lie about server state.
      setShowNsfw(!next);
      setErr(e instanceof Error ? e.message : t("account.nsfwToggle.updateFailed"));
    } finally {
      setNsfwBusy(false);
    }
  }

  async function refreshKeys() {
    try { setKeys(await api.apiKeys.list()); }
    catch (e) { setErr(e instanceof Error ? e.message : t("errors.loadFailed")); }
  }
  useEffect(() => { refreshKeys(); /* eslint-disable-next-line */ }, []);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null); setErr(null);
    try { await api.updateMe({ full_name: fullName }); await fetchMe(); setMsg(t("account.saved")); }
    catch (e) { setErr(e instanceof Error ? e.message : t("account.saveFailed")); }
  }
  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null); setErr(null);
    try {
      await api.changePassword({ current_password: currentPassword, new_password: newPassword });
      setCurrentPassword(""); setNewPassword("");
      setMsg(t("account.passwordChanged"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("account.saveFailed"));
    }
  }
  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null); setErr(null); setNewlyCreated(null);
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
    }
  }
  async function revokeKey(id: string) {
    if (!confirm(t("account.apiKey.revokeConfirm"))) return;
    try { await api.apiKeys.revoke(id); await refreshKeys(); }
    catch (e) { setErr(e instanceof Error ? e.message : t("account.apiKey.revokeFailed")); }
  }

  if (!user) return null;

  return (
    <div className="space-y-6">
      <header className="surface flex items-center gap-4 p-6">
        <div className="flex h-16 w-16 items-center justify-center rounded-pill bg-primary-container text-primary-on-container">
          <UserIcon className="h-7 w-7" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-ink md:text-4xl">
            {user.full_name || user.username}
          </h1>
          <p className="font-mono text-xs text-ink-mute">{user.email}</p>
        </div>
        <div className="ml-auto">
          <Badge variant={user.role === "admin" ? "primary" : "outline"}>
            {user.role === "admin" ? t("account.role.admin") : t("account.role.user")}
          </Badge>
        </div>
      </header>

      {msg && <p className="rounded-xl border border-primary bg-primary-container px-3 py-2 text-sm text-primary-on-container">{msg}</p>}
      {err && <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{err}</p>}

      {/* Profile */}
      <Section step="01" title={t("account.sections.profile")}>
        <form onSubmit={saveProfile} className="grid gap-4 md:grid-cols-2">
          <Field label={t("account.fields.email")} htmlFor="em"><Input id="em" value={user.email} disabled /></Field>
          <Field label={t("account.fields.username")} htmlFor="un"><Input id="un" value={user.username} disabled /></Field>
          <Field label={t("account.fields.fullName")} htmlFor="fn" className="md:col-span-2">
            <Input id="fn" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </Field>
          <div className="md:col-span-2"><Button type="submit" variant="filled">{t("account.saveProfile")}</Button></div>
        </form>
      </Section>

      {/* Content preferences */}
      <Section
        step="02"
        title={t("account.sections.content")}
        subtitle={t("account.sections.contentSubtitle")}
      >
        <div className="flex items-center gap-4 rounded-2xl border border-outline-soft bg-surface-2 p-4 transition-colors hover:border-outline">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-surface text-ink-soft">
            <EyeOff className="h-4 w-4" strokeWidth={2.2} />
          </span>
          <label htmlFor="nsfw-switch" className="min-w-0 flex-1 cursor-pointer">
            <span className="block text-sm font-semibold text-ink">
              {t("account.nsfwToggle.title")}
            </span>
            <span className="mt-0.5 block text-xs text-ink-mute">
              <Trans
                i18nKey="account.nsfwToggle.body"
                components={{ code: <span className="font-mono" /> }}
              />
            </span>
          </label>
          <Switch
            id="nsfw-switch"
            ariaLabel={t("account.nsfwToggle.title")}
            checked={showNsfw}
            disabled={nsfwBusy}
            onCheckedChange={toggleNsfw}
          />
        </div>
      </Section>

      {/* Language */}
      <Section
        step="03"
        title={t("account.sections.language")}
        subtitle={t("account.sections.languageSubtitle")}
      >
        <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-outline-soft bg-surface-2 p-4 transition-colors hover:border-outline">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-surface text-ink-soft">
            <Globe2 className="h-4 w-4" strokeWidth={2.2} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-ink">
              {t("account.languagePicker.title")}
            </div>
            <p className="mt-0.5 text-xs text-ink-mute">
              {t("account.languagePicker.body")}
            </p>
          </div>
          <div ref={localePickerRef} className="relative shrink-0">
            <Button
              type="button"
              variant="outlined"
              size="md"
              onClick={() => setLocalePickerOpen((o) => !o)}
              disabled={localeBusy}
              className="min-w-[10rem] justify-between"
            >
              <span className="truncate">
                {preferredLocale ? localeLabel(preferredLocale).label : t("account.languagePicker.defaultLabel")}
              </span>
              <span className="ml-2 font-mono text-[10px] text-ink-mute">
                {preferredLocale ?? "—"}
              </span>
            </Button>
            {localePickerOpen && (
              <div className="absolute right-0 top-12 z-20 w-80 rounded-2xl border border-outline-soft bg-surface p-3 shadow-e3">
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
                          <span className="block truncate font-medium">
                            {l.label}
                          </span>
                          {l.native !== l.label && (
                            <span className="block truncate text-xs opacity-70">
                              {l.native}
                            </span>
                          )}
                        </span>
                        <span className="font-mono text-[10px] opacity-70">
                          {l.code}
                        </span>
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
        </div>
      </Section>

      {/* Password */}
      {user.auth_provider === "local" && (
        <Section step="04" title={t("account.sections.password")}>
          <form onSubmit={changePassword} className="grid gap-4 md:grid-cols-2">
            <Field label={t("account.fields.currentPassword")} htmlFor="cur">
              <Input id="cur" type="password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
            </Field>
            <Field label={t("account.fields.newPassword")} htmlFor="new">
              <Input id="new" type="password" minLength={8} required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </Field>
            <div className="md:col-span-2"><Button type="submit" variant="filled">{t("account.changePassword")}</Button></div>
          </form>
        </Section>
      )}

      {/* API keys */}
      <Section
        step="05"
        title={t("account.sections.apiKeys")}
        subtitle={t("account.sections.apiKeysSubtitle")}
      >
        {newlyCreated && (
          <NewKeyCelebration
            secret={newlyCreated}
            username={user.username}
            onDismiss={() => setNewlyCreated(null)}
          />
        )}
        <form onSubmit={createKey} className="grid gap-3 md:grid-cols-[2fr_1fr_auto]">
          <Field label={t("account.apiKey.label")} htmlFor="kn">
            <Input id="kn" required placeholder={t("account.apiKey.labelPlaceholder")} value={keyName} onChange={(e) => setKeyName(e.target.value)} />
          </Field>
          <Field label={t("account.apiKey.expiresDays")} htmlFor="exp">
            <Input id="exp" type="number" min={1} placeholder={t("account.apiKey.neverExpires")} value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="filled" className="w-full">
              <Key className="h-4 w-4" /> {t("account.apiKey.create")}
            </Button>
          </div>
          <div className="md:col-span-3 flex flex-wrap items-center gap-4 text-sm text-ink-soft">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={canDownloadPrivate} onChange={(e) => setCanDownloadPrivate(e.target.checked)} />
              {t("account.apiKey.canDownloadPrivate")}
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={canManageApps} onChange={(e) => setCanManageApps(e.target.checked)} />
              {t("account.apiKey.canManageApps")}
            </label>
          </div>
        </form>

        <ul className="mt-6 space-y-2">
          {keys.length === 0 && <li className="rounded-xl border border-dashed border-outline px-4 py-8 text-center italic text-ink-mute">{t("account.apiKey.noKeys")}</li>}
          {keys.map((k) => (
            <li key={k.id} className="surface flex flex-wrap items-center gap-3 p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-pill bg-surface-2">
                <Key className="h-4 w-4 text-ink-soft" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-ink">{k.name}</div>
                <div className="font-mono text-[11px] text-ink-mute">fdr_{k.prefix}_…</div>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {k.can_download_private && <Badge variant="outline">{t("account.apiKey.privateDl")}</Badge>}
                {k.can_manage_apps && <Badge variant="outline">{t("account.apiKey.manage")}</Badge>}
                {k.revoked_at
                  ? <Badge variant="destructive">{t("account.apiKey.revoked")}</Badge>
                  : <Badge variant="primary">{t("account.apiKey.active")}</Badge>}
              </div>
              <div className="hidden text-right text-xs text-ink-mute md:block">
                <div>{t("account.apiKey.used")} <span className="font-mono">{formatDate(k.last_used_at)}</span></div>
                <div>{t("account.apiKey.expires")} <span className="font-mono">{formatDate(k.expires_at)}</span></div>
              </div>
              {!k.revoked_at && (
                <Button size="sm" variant="outlined" onClick={() => revokeKey(k.id)}>
                  <Trash2 className="h-3.5 w-3.5" /> {t("account.apiKey.revoke")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Section>

      {/* Quotas */}
      <Section step="06" title={t("account.sections.quotas")}>
        <QuotaUsageSection />
      </Section>

      {/* Active sessions */}
      <Section step="07" title={t("account.sections.sessions")}>
        <SessionsSection />
      </Section>

      {/* 2FA */}
      <Section step="08" title={t("account.sections.totp")}>
        <TotpSection />
      </Section>
    </div>
  );
}

/* The "you just created an API key" celebration block.
 *
 * Renders once, only when the parent stores the fresh secret. Shows the QR
 * code with credentials embedded so users can subscribe from their phone in
 * one scan, plus a copy-friendly text fallback. Dismissing the block is
 * intentionally explicit (X button) so users don't lose the key by
 * accidentally clicking away. */
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
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  // The Basic-auth URL the QR encodes — same scheme the QR uses, so
  // copy/paste from this field matches scanning. Pulled from the live repo
  // config so the username:password@host part reflects the current admin
  // settings.
  const repo = useRepoInfo();
  const authUrl = fdroidDeepLink(repo.url, {
    credentials: { username, secret },
    fingerprint: repo.fingerprint,
  });

  return (
    <div className="surface relative mb-4 overflow-hidden p-5 animate-fade-up">
      {/* Soft success tint */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 80% at 100% 0%, rgb(var(--primary) / 0.10), transparent 70%)",
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
        <p className="text-sm text-ink-soft">
          {t("account.apiKey.newKeyBody")}
        </p>
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
          <p className="text-xs text-ink-mute">
            {t("account.apiKey.usernameNote")}
          </p>
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
          className={
            "min-w-0 flex-1 select-all break-all rounded-xl border border-outline-soft bg-surface px-3 py-2 " +
            (mono ? "font-mono " : "") +
            (small ? "text-[10px]" : "text-xs")
          }
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

function Section({
  step,
  title,
  subtitle,
  children,
}: {
  step: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="surface p-6">
      <header className="mb-5 flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-pill bg-primary-container font-mono text-sm font-bold text-primary-on-container">
          {step}
        </span>
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink">{title}</h2>
          {subtitle && <p className="text-sm text-ink-mute">{subtitle}</p>}
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
    <div className={`space-y-1.5 ${className || ""}`}>
      <Label htmlFor={htmlFor} className="text-sm font-medium text-ink-soft">{label}</Label>
      {children}
    </div>
  );
}

export default function AccountPage() {
  return (
    <AuthGuard>
      <AccountInner />
    </AuthGuard>
  );
}
