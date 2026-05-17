"use client";

import { Check, Copy, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";

import { RepoQrCode } from "@/components/repo-qr-code";
import { Button } from "@/components/ui/button";
import { fdroidDeepLink, useRepoInfo } from "@/lib/repo-store";

/* The "Add to F-Droid" invitation. Two paths in: the Open button (works on
 * devices with F-Droid installed, scheme picked from http vs https) and the
 * QR for cross-device handoff (scan from your phone). Both pull the LIVE
 * repo address through useRepoInfo so admin edits propagate immediately. */
export function RepoCta() {
  const repo = useRepoInfo();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(repo.url);
      setCopied(true);
    } catch {/* clipboard blocked */}
  }
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div
      className="surface relative overflow-hidden p-6 md:p-10"
      style={{
        backgroundImage:
          "radial-gradient(70% 90% at 100% 0%, rgb(var(--primary) / 0.16), transparent 70%)",
      }}
    >
      <div className="relative grid items-center gap-8 md:grid-cols-[auto_1fr_auto] md:gap-10">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-container text-primary-on-container">
          <Smartphone className="h-7 w-7" strokeWidth={2} />
        </div>
        <div>
          <h3 className="text-2xl font-bold tracking-tight text-ink md:text-3xl">
            Subscribe with the F-Droid client.
          </h3>
          <p className="mt-1 max-w-xl text-sm text-ink-soft md:text-base">
            Scan the code with your phone, or paste the URL in F-Droid →
            Settings → Repositories → +.
          </p>
          <button
            type="button"
            onClick={copy}
            className="mt-3 inline-flex items-center gap-2 rounded-pill border border-outline-soft bg-surface px-3 py-1.5 font-mono text-xs text-ink-soft transition-colors hover:border-outline hover:text-ink"
          >
            <span className="select-all break-all">{repo.url}</span>
            {copied ? (
              <Check className="h-3.5 w-3.5 text-primary" strokeWidth={2.4} />
            ) : (
              <Copy className="h-3.5 w-3.5" strokeWidth={2.2} />
            )}
          </button>
          <div className="mt-4">
            <Button asChild variant="filled" size="lg">
              <a href={fdroidDeepLink(repo.url, { fingerprint: repo.fingerprint })}>
                Open in F-Droid
              </a>
            </Button>
          </div>
        </div>
        <RepoQrCode size={192} showCaption className="shrink-0" />
      </div>
    </div>
  );
}
