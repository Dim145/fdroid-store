"use client";

import { Rss } from "lucide-react";
import Link from "next/link";
import { useTranslation } from "react-i18next";

import pkg from "@/package.json";
import { useRepoInfo } from "@/lib/repo-store";

export function SiteFooter() {
  const { t } = useTranslation();
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
              <span className="text-base font-bold tracking-tight text-ink">{t("header.brand")}</span>
            </div>
            <p className="mt-3 max-w-xs text-sm text-ink-soft">
              {t("footer.tagline")}
            </p>
          </div>
          <div>
            <div className="eyebrow">{t("footer.browse")}</div>
            {/* ``/apps`` and ``/my-apps`` are already in the top navbar, so
                keep the footer focused on entries that DON'T live there —
                stats, account, and the RSS feeds. */}
            <ul className="mt-3 space-y-2 text-sm">
              <li><Link href="/stats" className="text-ink-soft hover:text-ink">{t("footer.stats")}</Link></li>
              <li><Link href="/account" className="text-ink-soft hover:text-ink">{t("footer.account")}</Link></li>
              <li>
                <a
                  href="/api/v1/feed/new"
                  className="inline-flex items-center gap-1.5 text-ink-soft hover:text-ink"
                  aria-label={t("footer.feedNew")}
                >
                  <Rss className="h-3 w-3" /> {t("footer.feedNew")}
                </a>
              </li>
              <li>
                <a
                  href="/api/v1/feed/updates"
                  className="inline-flex items-center gap-1.5 text-ink-soft hover:text-ink"
                  aria-label={t("footer.feedUpdates")}
                >
                  <Rss className="h-3 w-3" /> {t("footer.feedUpdates")}
                </a>
              </li>
            </ul>
          </div>
          <div>
            <div className="eyebrow">{t("footer.repoUrl")}</div>
            <code className="mt-3 inline-block max-w-full select-all break-all rounded-xl border border-outline-soft bg-surface-2 px-3 py-1.5 font-mono text-xs text-ink">
              {repo.url}
            </code>
            <p className="mt-2 text-xs text-ink-mute">
              {t("footer.pasteHint")}
            </p>
          </div>
        </div>
        <div className="mt-10 flex flex-col items-start justify-between gap-2 border-t border-outline-soft pt-5 text-xs text-ink-mute md:flex-row md:items-center">
          <span>{t("footer.copyright", { year: new Date().getFullYear() })}</span>
          <span className="font-mono">v{pkg.version}</span>
        </div>
      </div>
    </footer>
  );
}
