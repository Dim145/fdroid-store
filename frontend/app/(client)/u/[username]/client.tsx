"use client";

import { ArrowLeft, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppCard } from "@/components/app-card";
import { Button } from "@/components/ui/button";
import { api, type PublicProfile } from "@/lib/api";
import { cn, formatDate } from "@/lib/utils";

/* ──────────────────────────────────────────────────────────────────────────
 * Public profile — an editorial spread for an uploader. The username is the
 * masthead: deliberately oversized, framed by a thin rule and a column of
 * mono credits in the manner of a print byline. The body is a tight grid of
 * the user's PUBLIC + PUBLISHED apps; private uploads are out of scope by
 * design (only the owner can see them).
 *
 * Each profile is tinted by hashing the username so two uploaders never
 * share the exact same backdrop hue.
 * ────────────────────────────────────────────────────────────────────────── */
export default function ProfileClient() {
  const pathname = usePathname();
  const username = useMemo(() => {
    const m = pathname?.match(/^\/u\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }, [pathname]);

  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!username) return;
    setProfile(null);
    setError(null);
    api.users.profile(username)
      .then(setProfile)
      .catch((e) => setError(e instanceof Error ? e.message : "Profile not found"));
  }, [username]);

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <div className="text-5xl font-bold tracking-tight">No such profile</div>
        <p className="max-w-md text-ink-soft">
          Either this uploader doesn&apos;t exist or they haven&apos;t published any
          public app yet.
        </p>
        <Button asChild variant="filled" className="mt-4">
          <Link href="/apps">
            <ArrowLeft className="h-4 w-4" /> Back to catalogue
          </Link>
        </Button>
      </div>
    );
  }
  if (!profile) {
    return (
      <div className="flex justify-center py-24">
        <div
          className="h-7 w-7 animate-spin rounded-full border-2 border-outline-soft border-t-primary"
          role="status"
          aria-label="Loading"
        />
      </div>
    );
  }

  // Stable username-derived hue, mirroring the AppDetail hero treatment so
  // each profile gets a distinct atmospheric tint without baked-in avatars.
  let h = 0;
  for (let i = 0; i < profile.username.length; i++) {
    h = (h * 31 + profile.username.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(h) % 360;
  const initial = (profile.full_name || profile.username).trim().charAt(0).toUpperCase() || "?";

  return (
    <article className="animate-fade-in">
      <Link
        href="/apps"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" /> Back to apps
      </Link>

      {/* ───────────────── Editorial masthead ───────────────── */}
      <section
        className="relative overflow-hidden rounded-2xl border border-outline-soft bg-surface px-5 pb-6 pt-6 md:px-8 md:pb-7 md:pt-7"
        style={{
          backgroundImage:
            `radial-gradient(70% 80% at 8% 0%, hsl(${hue} 70% 55% / 0.16), transparent 55%),` +
            `radial-gradient(60% 90% at 100% 100%, hsl(${(hue + 80) % 360} 60% 50% / 0.08), transparent 60%)`,
        }}
      >
        {/* faint editorial eyebrow */}
        <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.28em] text-ink-mute">
          <span className="inline-block h-px w-6 bg-ink-mute/40" />
          Profile
          <span className="font-mono normal-case tracking-normal text-ink-mute/80">
            n°{(Math.abs(h) % 9999).toString().padStart(4, "0")}
          </span>
        </div>

        {/* monogram + masthead grid */}
        <div className="mt-4 grid items-center gap-5 md:grid-cols-[auto_1fr] md:gap-6">
          {/* Initial mark — a hand-set monogram tinted with the username hash */}
          <div
            aria-hidden
            className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-outline-soft shadow-e1 md:h-16 md:w-16"
            style={{
              background:
                `radial-gradient(120% 100% at 20% 10%, hsl(${hue} 80% 70% / 0.55), hsl(${(hue + 30) % 360} 70% 45% / 0.85))`,
              color: "white",
            }}
          >
            <span className="text-2xl font-black tracking-tight md:text-3xl">
              {initial}
            </span>
            <span className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-inset ring-white/30" />
          </div>

          {/* Name + byline */}
          <div className="min-w-0">
            <h1 className="break-words text-3xl font-black leading-[0.95] tracking-[-0.03em] text-ink md:text-5xl">
              <span className="text-ink-mute">@</span>
              {profile.username}
            </h1>
            {profile.full_name && (
              <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
                {profile.full_name}
              </p>
            )}
          </div>
        </div>

        {/* Bottom rule + credits row */}
        <div className="mt-5 border-t border-outline-soft pt-4">
          <dl className="grid grid-cols-3 gap-x-6 gap-y-3 text-[10px] uppercase tracking-[0.22em] text-ink-mute">
            <Credit label="Handle">
              <span className="font-mono normal-case tracking-tight text-ink">
                @{profile.username}
              </span>
            </Credit>
            <Credit label="Member since">
              <span className="font-mono normal-case tracking-tight text-ink">
                {formatDate(profile.member_since)}
              </span>
            </Credit>
            <Credit label="Published">
              <span className="font-mono normal-case tracking-tight text-ink">
                {profile.apps.length} {profile.apps.length === 1 ? "app" : "apps"}
              </span>
            </Credit>
          </dl>
        </div>
      </section>

      {/* ───────────────── Published apps ───────────────── */}
      <section className="mt-12">
        <header className="mb-5 flex items-baseline justify-between gap-4">
          <h2 className="text-2xl font-bold tracking-tight text-ink md:text-3xl">
            Published apps
          </h2>
          <span className="font-mono text-xs text-ink-mute">
            {profile.apps.length.toString().padStart(2, "0")} total
          </span>
        </header>

        {profile.apps.length === 0 ? (
          <div className="surface flex flex-col items-center gap-2 px-6 py-16 text-center">
            <Sparkles className="h-6 w-6 text-ink-mute" />
            <p className="text-ink-soft">
              No public apps yet from{" "}
              <span className="font-mono">@{profile.username}</span>.
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:gap-4 lg:grid-cols-4 xl:grid-cols-5">
            {profile.apps.map((app, i) => (
              <li
                key={app.id}
                className={cn(
                  "animate-fade-up opacity-0",
                  "[animation-delay:var(--d)] [animation-fill-mode:forwards]",
                )}
                style={{ ["--d" as string]: `${Math.min(i, 12) * 60}ms` }}
              >
                <AppCard app={app} variant="tile" className="w-full" />
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

function Credit({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="truncate">{label}</dt>
      <dd className="mt-1.5 truncate text-sm">{children}</dd>
    </div>
  );
}
