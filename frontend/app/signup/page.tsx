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

export default function SignupPage() {
  // Wrap so useSearchParams (reads ?invite=…) doesn't block static rendering.
  return (
    <Suspense fallback={null}>
      <SignupInner />
    </Suspense>
  );
}

function SignupInner() {
  const router = useRouter();
  const search = useSearchParams();
  const { signup } = useAuth();
  // Pre-fill invite_code from ?invite=XXX so an admin can hand someone a
  // single URL ("https://repo/signup?invite=XYZ") that lands ready to submit.
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState(search.get("invite") ?? "");
  const [methods, setMethods] = useState<AuthMethodsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setSubmitting(true);
    try {
      await signup({
        email,
        username,
        password,
        full_name: fullName || undefined,
        invite_code: inviteCode.trim() || undefined,
      });
      router.replace("/apps");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signup failed");
    } finally {
      setSubmitting(false);
    }
  }

  // Closed mode: render a friendly explanation instead of a form that the
  // backend would just reject.
  const isClosed = methods != null && (
    !methods.allow_signup || methods.registration_policy === "closed"
  );
  const requiresInvite = methods?.registration_policy === "invite";

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
            publish · sync · install
          </p>
          <h1 className="mt-3 text-5xl font-bold tracking-tight text-primary-on-container md:text-6xl">
            Open an account.<br /> Ship your apps.
          </h1>
          <p className="mt-4 max-w-md text-primary-on-container/80">
            Publish your Android releases on your own F-Droid repo. Manage API
            keys, screenshots, changelogs — all from the same place.
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
          <h2 className="text-3xl font-bold tracking-tight text-ink">
            {isClosed ? "Signups are closed" : "Create your account"}
          </h2>
          <p className="mt-1 text-ink-soft">
            {isClosed
              ? "Ask an administrator to create an account for you."
              : requiresInvite
              ? "An invite code is required to sign up here."
              : "It only takes a moment."}
          </p>
          {isClosed ? (
            <div className="mt-8 space-y-4">
              <Button asChild variant="outlined" size="xl" className="w-full">
                <Link href="/login">Back to sign in</Link>
              </Button>
            </div>
          ) : (
          <form onSubmit={onSubmit} className="mt-8 space-y-4">
            {requiresInvite && (
              <Field label="Invite code" htmlFor="invite">
                <Input
                  id="invite"
                  required
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  autoComplete="off"
                />
              </Field>
            )}
            <Field label="Email" htmlFor="email">
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Username" htmlFor="username">
              <Input id="username" required value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>
            <Field label="Full name (optional)" htmlFor="fullname">
              <Input id="fullname" value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input id="password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {error && (
              <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{error}</p>
            )}
            <Button type="submit" variant="filled" size="xl" className="w-full" disabled={submitting}>
              {submitting ? "Creating…" : "Create account"}
            </Button>
            <p className="text-center text-sm text-ink-soft">
              Already have an account?{" "}
              <Link href="/login" className="font-medium text-primary hover:underline">
                Sign in
              </Link>
            </p>
          </form>
          )}
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
