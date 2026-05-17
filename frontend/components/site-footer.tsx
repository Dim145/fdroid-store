"use client";

import Link from "next/link";

import { useRepoInfo } from "@/lib/repo-store";

export function SiteFooter() {
  const repo = useRepoInfo();
  return (
    <footer className="mt-20 border-t border-outline-soft">
      <div className="container py-10">
        <div className="grid gap-8 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-fg shadow-e1">
                <span className="text-sm font-bold tracking-tight">fS</span>
              </span>
              <span className="text-base font-bold tracking-tight text-ink">fdroid-store</span>
            </div>
            <p className="mt-3 max-w-xs text-sm text-ink-soft">
              A modern self-hosted F-Droid repository. Browse on the web, sync
              with your F-Droid Android client to install.
            </p>
          </div>
          <div>
            <div className="eyebrow">Browse</div>
            <ul className="mt-3 space-y-2 text-sm">
              <li><Link href="/apps" className="text-ink-soft hover:text-ink">All apps</Link></li>
              <li><Link href="/my-apps" className="text-ink-soft hover:text-ink">My apps</Link></li>
              <li><Link href="/account" className="text-ink-soft hover:text-ink">Account</Link></li>
            </ul>
          </div>
          <div>
            <div className="eyebrow">Repo URL</div>
            <code className="mt-3 inline-block max-w-full select-all break-all rounded-xl border border-outline-soft bg-surface-2 px-3 py-1.5 font-mono text-xs text-ink">
              {repo.url}
            </code>
            <p className="mt-2 text-xs text-ink-mute">
              Paste this in your F-Droid client to subscribe.
            </p>
          </div>
        </div>
        <div className="mt-10 flex flex-col items-start justify-between gap-2 border-t border-outline-soft pt-5 text-xs text-ink-mute md:flex-row md:items-center">
          <span>© {new Date().getFullYear()} fdroid-store · self-hosted</span>
          <span className="font-mono">vol. 01</span>
        </div>
      </div>
    </footer>
  );
}
