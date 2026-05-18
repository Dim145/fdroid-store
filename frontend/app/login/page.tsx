"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import pkg from "@/package.json";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type AuthMethodsInfo } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";

export default function LoginPage() {
  return (
    <Suspense fallback={<AuthSkeleton />}>
      <LoginForm />
    </Suspense>
  );
}

// Defence against open redirects via ``?next=...``. The cheap
// ``startsWith`` checks missed several browser-tolerated bypasses
// (single backslash, percent-encoded slash, tab/whitespace). Parse the
// value with the standard ``URL`` constructor against our own origin —
// anything that resolves to a different origin is rejected outright.
function safeNext(raw: string | null): string {
  if (!raw || raw.length > 512) return "/apps";
  if (typeof window === "undefined") return "/apps";
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return "/apps";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/apps";
  }
}

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const next = safeNext(search.get("next"));
  const { user, login } = useAuth();

  const [methods, setMethods] = useState<AuthMethodsInfo | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Only relevant when the SSO target server is in invite mode AND the user
  // expects to create an account through it. Existing OIDC users never need it.
  const [oidcInvite, setOidcInvite] = useState("");

  // ``fetchMe`` already runs once at module load from the auth-store
  // bootstrap (see auth-store.ts) — calling it again here just causes a
  // duplicate /me request on every login page mount.
  useEffect(() => { if (user) router.replace(next); }, [user, router, next]);
  useEffect(() => {
    api.authMethods().then(setMethods).catch(() => setMethods({
      local: true,
      oidc: false,
      allow_signup: true,
      oidc_login_url: null,
      public_mode: true,
      registration_policy: "public",
    }));
  }, []);

  // Surface server-side errors returned from the OIDC callback (e.g. invite
  // required, signup closed). The backend redirects back with ?oidc_error=...
  // instead of dumping a raw 400.
  useEffect(() => {
    const e = search.get("oidc_error");
    if (e) setError(e);
  }, [search]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setSubmitting(true);
    try {
      const me = await login(email, password);
      if (me.role === "admin") {
        try {
          const status = await api.setup.status();
          if (!status.setup_complete) { router.replace("/admin/setup"); return; }
        } catch { /* ignore */ }
      }
      router.replace(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  // For invite-mode repos, append ?invite=... to the OIDC login URL so the
  // backend can carry it through the IdP round-trip in the session.
  //
  // Defensive: validate the scheme is http/https so a compromised or
  // misconfigured /auth/methods response can't slip a ``javascript:`` /
  // ``data:`` URL into our <a href>.
  const oidcHref = (() => {
    const base = methods?.oidc_login_url;
    if (!base || !/^https?:\/\//i.test(base)) return null;
    const trimmed = oidcInvite.trim();
    if (!trimmed) return base;
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}invite=${encodeURIComponent(trimmed)}`;
  })();

  return (
    <AuthShell title="Welcome back" lede="Sign in to manage your apps and API keys.">
      {error && !methods?.local && (
        <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{error}</p>
      )}
      {methods?.local && (
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {error && (
            <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{error}</p>
          )}
          <Button type="submit" variant="filled" size="xl" className="w-full" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      )}

      {methods?.oidc && oidcHref && (
        <>
          <Divider />
          {methods.registration_policy === "invite" && (
            <Field label="Invite code (only if you don't have an account yet)" htmlFor="oidc-invite">
              <Input
                id="oidc-invite"
                placeholder="optional for existing accounts"
                value={oidcInvite}
                onChange={(e) => setOidcInvite(e.target.value)}
                autoComplete="off"
              />
            </Field>
          )}
          <Button asChild variant="outlined" size="lg" className="w-full">
            <a href={oidcHref}>Continue with SSO</a>
          </Button>
        </>
      )}

      {methods?.allow_signup && methods.local && (
        <p className="text-center text-sm text-ink-soft">
          New here?{" "}
          <Link href="/signup" className="font-medium text-primary hover:underline">
            Create an account
          </Link>
        </p>
      )}
      {methods && !methods.allow_signup && methods.registration_policy === "closed" && (
        <p className="text-center text-xs text-ink-mute">
          Signups are closed. Ask an administrator for an account.
        </p>
      )}
    </AuthShell>
  );
}

function AuthShell({
  title,
  lede,
  children,
}: {
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <main className="grid min-h-screen md:grid-cols-[1fr_1.1fr]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-primary-container p-10 md:flex">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(60% 50% at 100% 0%, rgb(var(--accent) / 0.18), transparent 70%), radial-gradient(40% 60% at 0% 100%, rgb(var(--primary) / 0.20), transparent 70%)",
          }}
        />
        <Link href="/" className="relative inline-flex items-center gap-2.5 text-primary-on-container">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-fg shadow-e1">
            <span className="text-sm font-bold tracking-tight">fS</span>
          </span>
          <span className="text-base font-bold tracking-tight">fdroid-store</span>
        </Link>
        <div className="relative">
          <p className="font-mono text-xs uppercase tracking-widest text-primary-on-container/70">
            self-hosted · open source · yours
          </p>
          <h1 className="mt-3 text-5xl font-bold tracking-tight text-primary-on-container md:text-6xl">
            Your private app shelf,<br /> on your own server.
          </h1>
          <p className="mt-4 max-w-md text-primary-on-container/80">
            A modern F-Droid repo with the polish of a real app store.
          </p>
        </div>
        <div className="relative font-mono text-xs text-primary-on-container/60">v{pkg.version}</div>
      </aside>

      <section className="flex items-center justify-center p-6 md:p-12">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center justify-between md:hidden">
            <Link href="/" className="text-sm font-semibold text-ink-soft hover:text-ink">← Back</Link>
            <ThemeToggle />
          </div>
          <div className="mb-6 hidden md:flex md:justify-end">
            <ThemeToggle />
          </div>
          <h2 className="text-3xl font-bold tracking-tight text-ink">{title}</h2>
          <p className="mt-1 text-ink-soft">{lede}</p>
          <div className="mt-8 space-y-5">{children}</div>
        </div>
      </section>
    </main>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-sm font-medium text-ink-soft">{label}</Label>
      {children}
    </div>
  );
}

function Divider() {
  return (
    <div className="flex items-center gap-3 text-[11px] uppercase tracking-widest text-ink-mute">
      <span className="h-px flex-1 bg-outline-soft" />
      <span>or</span>
      <span className="h-px flex-1 bg-outline-soft" />
    </div>
  );
}

function AuthSkeleton() {
  return <main className="flex min-h-screen items-center justify-center text-sm text-ink-mute">Loading…</main>;
}
