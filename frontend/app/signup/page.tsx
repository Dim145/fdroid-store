"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation();
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
      {/* Mirror of /login's left rail — calm ``bg-surface`` base with
          radial gradient tints, instead of the saturated chartreuse
          slab of ``bg-primary-container``. See login/page.tsx for the
          rationale. */}
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-outline-soft bg-surface p-10 md:flex">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(60% 50% at 100% 0%, rgb(var(--accent) / 0.10), transparent 70%), radial-gradient(50% 70% at 0% 100%, rgb(var(--primary) / 0.14), transparent 70%)",
          }}
        />
        <Link href="/" className="relative inline-flex items-center gap-2.5 text-ink">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-fg shadow-e1">
            <span className="text-sm font-bold tracking-tight">fS</span>
          </span>
          <span className="text-base font-bold tracking-tight">{t("header.brand")}</span>
        </Link>
        <div className="relative">
          <p className="font-mono text-xs uppercase tracking-widest text-ink-mute">
            {t("auth.signup.heroEyebrow")}
          </p>
          <h1 className="mt-3 whitespace-pre-line text-5xl font-bold tracking-tight text-ink md:text-6xl">
            {t("auth.signup.heroTitle")}
          </h1>
          <p className="mt-4 max-w-md text-ink-soft">
            {t("auth.signup.heroSubtitle")}
          </p>
        </div>
        <div className="relative font-mono text-xs text-ink-mute">v{pkg.version}</div>
      </aside>

      <section className="flex items-center justify-center p-6 md:p-12">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center justify-between md:hidden">
            <Link href="/" className="text-sm font-semibold text-ink-soft hover:text-ink">{t("auth.back")}</Link>
            <ThemeToggle />
          </div>
          <div className="mb-6 hidden md:flex md:justify-end">
            <ThemeToggle />
          </div>
          <h2 className="text-3xl font-bold tracking-tight text-ink">
            {isClosed ? t("auth.signup.closedTitle") : t("auth.signup.title")}
          </h2>
          <p className="mt-1 text-ink-soft">
            {isClosed
              ? t("auth.signup.closedSubtitle")
              : requiresInvite
              ? t("auth.signup.inviteRequiredSubtitle")
              : t("auth.signup.subtitle")}
          </p>
          {isClosed ? (
            <div className="mt-8 space-y-4">
              <Button asChild variant="outlined" size="xl" className="w-full">
                <Link href="/login">{t("auth.signup.backToSignIn")}</Link>
              </Button>
            </div>
          ) : (
          <form onSubmit={onSubmit} className="mt-8 space-y-4">
            {requiresInvite && (
              <Field label={t("auth.signup.inviteLabel")} htmlFor="invite">
                <Input
                  id="invite"
                  required
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  autoComplete="off"
                />
              </Field>
            )}
            <Field label={t("auth.signup.emailLabel")} htmlFor="email">
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label={t("auth.signup.usernameLabel")} htmlFor="username">
              <Input id="username" required value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>
            <Field label={t("auth.signup.fullNameLabel")} htmlFor="fullname">
              <Input id="fullname" value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </Field>
            <Field label={t("auth.signup.passwordLabel")} htmlFor="password">
              <Input id="password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {error && (
              <p className="rounded-xl border border-danger bg-danger-container px-3 py-2 text-sm text-danger-on-container">{error}</p>
            )}
            <Button type="submit" variant="filled" size="xl" className="w-full" disabled={submitting}>
              {submitting ? t("auth.signup.submitting") : t("auth.signup.submit")}
            </Button>
            <p className="text-center text-sm text-ink-soft">
              {t("auth.signup.alreadyHaveAccount")}{" "}
              <Link href="/login" className="font-medium text-primary hover:underline">
                {t("auth.signup.loginLink")}
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
