"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { History as HistoryIcon, LayoutGrid, LogOut, Menu, Search, ShieldCheck, Sparkles, User as UserIcon, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-store";
import { cn } from "@/lib/utils";

type NavItem = {
  href: string;
  labelKey: string;
  icon: typeof Sparkles;
  authOnly: boolean;
  /** When true, the link is shown only to ``uploader`` / ``admin``.
   *  Plain ``user`` accounts can't push to /my-apps so we hide the
   *  link to keep the affordance honest. */
  uploaderOnly?: boolean;
};

const PRIMARY_NAV: readonly NavItem[] = [
  { href: "/apps", labelKey: "header.nav.apps", icon: Sparkles, authOnly: false },
  { href: "/my-apps", labelKey: "header.nav.myApps", icon: LayoutGrid, authOnly: true, uploaderOnly: true },
] as const;

/** Treat the ``/`` key as "open the search" only when the user *isn't*
 *  already typing somewhere else — otherwise pressing ``/`` mid-comment
 *  would yank focus out of a textarea, which is the canonical
 *  GitHub-shortcut gotcha. */
function isTypingInTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    // ``search``-typed inputs *are* the search field — pressing ``/``
    // inside one should produce a literal slash, so bail out too.
    return type !== "button" && type !== "checkbox" && type !== "radio" && type !== "submit";
  }
  return false;
}

/* M3 top app bar — sticky, surface-tinted, hosts brand + nav + search +
 * theme toggle + auth. Mobile collapses the secondary actions into a
 * slide-down sheet. */
export function SiteHeader() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname() || "/";
  const { user, logout } = useAuth();
  const [searchValue, setSearchValue] = useState("");
  const [drawer, setDrawer] = useState(false);
  // Track Mac vs. PC so the hint pill shows ``⌘K`` or ``Ctrl K``
  // appropriately. Hydrated on the client after mount — defaults to
  // ``ctrl`` during SSR/static export, which is also a reasonable
  // fallback on unknown platforms.
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    if (typeof navigator !== "undefined") {
      setIsMac(/Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent));
    }
  }, []);
  const desktopSearchRef = useRef<HTMLInputElement>(null);
  const mobileSearchRef = useRef<HTMLInputElement>(null);

  // Global ⌘K / Ctrl+K listener — pulls focus into whichever search
  // field is visible. Falls back to the mobile drawer when the desktop
  // input is hidden (md: breakpoint). Also handles the bare ``/`` key
  // (à la GitHub) but only when nothing else is being typed into.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const shortcut = mod && (e.key === "k" || e.key === "K");
      const slash =
        e.key === "/" &&
        !e.metaKey && !e.ctrlKey && !e.altKey &&
        !isTypingInTextField(e.target);
      if (!shortcut && !slash) return;
      e.preventDefault();
      const desk = desktopSearchRef.current;
      if (desk && desk.offsetParent !== null) {
        desk.focus();
        desk.select();
        return;
      }
      // Mobile path: open the drawer, then focus the input on the next
      // tick so it's actually mounted when we ask for focus.
      setDrawer(true);
      window.setTimeout(() => {
        mobileSearchRef.current?.focus();
        mobileSearchRef.current?.select();
      }, 0);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMac]);

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = searchValue.trim();
    router.push(q ? `/apps?q=${encodeURIComponent(q)}` : "/apps");
  }

  return (
    <header className="sticky top-0 z-40 border-b border-outline-soft bg-bg/85 backdrop-blur-md">
      <div className="container flex h-16 items-center gap-4">
        {/* Brand */}
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2.5"
          aria-label={t("header.homeAriaLabel")}
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-fg shadow-e1">
            <span className="text-sm font-bold tracking-tight">fS</span>
          </span>
          <span className="hidden text-base font-bold tracking-tight text-ink sm:inline">
            {t("header.brand")}
          </span>
        </Link>

        {/* Primary nav (desktop) */}
        <nav className="hidden items-center gap-1 md:flex">
          {PRIMARY_NAV.filter((n) => {
            if (n.authOnly && !user) return false;
            if (n.uploaderOnly && user?.role !== "uploader" && user?.role !== "admin") return false;
            return true;
          }).map((item) => {
            const active = isActive(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "inline-flex items-center gap-2 rounded-pill px-3.5 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary-container text-primary-on-container"
                    : "text-ink-soft hover:bg-surface-2 hover:text-ink",
                )}
              >
                <Icon className="h-4 w-4" strokeWidth={2.2} />
                {t(item.labelKey)}
              </Link>
            );
          })}
        </nav>

        {/* Search (grows) */}
        <form onSubmit={submitSearch} className="ml-auto hidden flex-1 max-w-md md:flex">
          <label className="group flex w-full items-center gap-2 rounded-pill border border-outline-soft bg-surface-2 px-4 py-2 transition-colors focus-within:border-primary focus-within:bg-surface">
            <Search className="h-4 w-4 text-ink-mute" strokeWidth={2.2} />
            <input
              ref={desktopSearchRef}
              type="search"
              placeholder={t("header.search")}
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
              className="w-full bg-transparent text-sm outline-none placeholder:text-ink-mute"
            />
            {/* Keyboard-shortcut hint. Hidden from screen readers
                (``aria-hidden``) because the input itself already
                advertises the shortcut via ``aria-keyshortcuts``. The
                pill is invisible on focus so it doesn't fight the
                caret for attention while the user is typing. */}
            <kbd
              aria-hidden
              title={t("header.searchShortcutHint", {
                defaultValue: "Search shortcut: Ctrl + K",
              })}
              className="hidden shrink-0 select-none items-center gap-0.5 rounded-md border border-outline-soft bg-surface px-1.5 py-0.5 font-mono text-[10px] font-semibold text-ink-mute group-focus-within:invisible lg:inline-flex"
            >
              <span>{isMac ? "⌘" : "Ctrl"}</span>
              <span>K</span>
            </kbd>
          </label>
        </form>

        {/* Right side */}
        <div className="ml-auto flex items-center gap-2 md:ml-0">
          <ThemeToggle />
          {user?.role === "admin" && (
            <Link
              href="/admin"
              className={cn(
                "hidden items-center gap-1.5 rounded-pill border border-outline-soft px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-surface-2 sm:inline-flex",
                pathname?.startsWith("/admin") && "border-primary bg-primary-container text-primary-on-container",
              )}
            >
              <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2.4} />
              {t("header.admin")}
            </Link>
          )}
          {user ? (
            <div className="hidden items-center gap-2 md:flex">
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    className="flex h-10 w-10 items-center justify-center rounded-pill bg-surface-2 text-ink-soft transition-colors hover:bg-surface-3 hover:text-ink data-[state=open]:bg-surface-3 data-[state=open]:text-ink"
                    aria-label={t("header.userMenu")}
                  >
                    <UserIcon className="h-4 w-4" strokeWidth={2.2} />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end"
                    sideOffset={8}
                    className="z-50 min-w-[14rem] origin-top-right animate-slide-down rounded-2xl border border-outline-soft bg-surface p-1 text-sm shadow-e3"
                  >
                    <div className="px-3 py-2">
                      <div className="truncate text-xs uppercase tracking-wider text-ink-mute">
                        {t("header.signedInAs")}
                      </div>
                      <div className="truncate font-semibold text-ink">
                        {user.full_name || user.email}
                      </div>
                    </div>
                    <DropdownMenu.Separator className="my-1 h-px bg-outline-soft" />
                    <DropdownMenu.Item asChild>
                      <Link
                        href="/account"
                        className="flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-ink-soft outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink"
                      >
                        <UserIcon className="h-4 w-4" strokeWidth={2.2} />
                        {t("header.account")}
                      </Link>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item asChild>
                      <Link
                        href="/history"
                        className="flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-ink-soft outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink"
                      >
                        <HistoryIcon className="h-4 w-4" strokeWidth={2.2} />
                        {t("header.downloadHistory")}
                      </Link>
                    </DropdownMenu.Item>
                    {user.role === "admin" && (
                      <DropdownMenu.Item asChild>
                        <Link
                          href="/admin"
                          className="flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-ink-soft outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink"
                        >
                          <ShieldCheck className="h-4 w-4" strokeWidth={2.2} />
                          {t("header.admin")}
                        </Link>
                      </DropdownMenu.Item>
                    )}
                    <DropdownMenu.Separator className="my-1 h-px bg-outline-soft" />
                    <DropdownMenu.Item
                      onSelect={() => { logout(); router.replace("/"); }}
                      className="flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-danger outline-none data-[highlighted]:bg-danger-container data-[highlighted]:text-danger-on-container"
                    >
                      <LogOut className="h-4 w-4" strokeWidth={2.2} />
                      {t("header.signOut")}
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          ) : (
            <Button asChild size="md" variant="filled" className="hidden md:inline-flex">
              <Link href="/login">{t("header.signIn")}</Link>
            </Button>
          )}

          <button
            type="button"
            onClick={() => setDrawer((s) => !s)}
            aria-label={t("header.menu")}
            aria-expanded={drawer}
            className="inline-flex h-10 w-10 items-center justify-center rounded-pill hover:bg-surface-2 md:hidden"
          >
            {drawer ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {drawer && (
        <div className="animate-slide-down md:hidden">
          <div className="container space-y-2 pb-4 pt-1">
            <form onSubmit={submitSearch}>
              <label className="flex w-full items-center gap-2 rounded-pill border border-outline-soft bg-surface-2 px-4 py-2 focus-within:border-primary">
                <Search className="h-4 w-4 text-ink-mute" />
                <input
                  ref={mobileSearchRef}
                  type="search"
                  placeholder={t("common.search")}
                  value={searchValue}
                  onChange={(e) => setSearchValue(e.target.value)}
                  className="w-full bg-transparent text-sm outline-none placeholder:text-ink-mute"
                />
              </label>
            </form>
            <nav className="grid gap-1">
              {PRIMARY_NAV.filter((n) => {
            if (n.authOnly && !user) return false;
            if (n.uploaderOnly && user?.role !== "uploader" && user?.role !== "admin") return false;
            return true;
          }).map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setDrawer(false)}
                    className={cn(
                      "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm",
                      active
                        ? "bg-primary-container text-primary-on-container"
                        : "text-ink-soft hover:bg-surface-2",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {t(item.labelKey)}
                  </Link>
                );
              })}
              {user && (
                <>
                  <Link
                    href="/account"
                    onClick={() => setDrawer(false)}
                    className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-ink-soft hover:bg-surface-2"
                  >
                    <UserIcon className="h-4 w-4" /> {t("header.account")}
                  </Link>
                  <Link
                    href="/history"
                    onClick={() => setDrawer(false)}
                    className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-ink-soft hover:bg-surface-2"
                  >
                    <HistoryIcon className="h-4 w-4" /> {t("header.downloadHistory")}
                  </Link>
                  {user.role === "admin" && (
                    <Link
                      href="/admin"
                      onClick={() => setDrawer(false)}
                      className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-ink-soft hover:bg-surface-2"
                    >
                      <ShieldCheck className="h-4 w-4" /> {t("header.admin")}
                    </Link>
                  )}
                  <button
                    onClick={() => { setDrawer(false); logout(); router.replace("/"); }}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-ink-soft hover:bg-surface-2"
                  >
                    <LogOut className="h-4 w-4" /> {t("header.signOut")}
                  </button>
                </>
              )}
              {!user && (
                <Button asChild size="md" variant="filled" className="mt-2 w-full">
                  <Link href="/login" onClick={() => setDrawer(false)}>{t("header.signIn")}</Link>
                </Button>
              )}
            </nav>
          </div>
        </div>
      )}
    </header>
  );
}
