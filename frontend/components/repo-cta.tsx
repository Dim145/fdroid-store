"use client";

import { Check, Copy, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { REPO_URL } from "@/lib/api";

/* Banner-style invitation to subscribe with an F-Droid client. Sits at the
 * bottom of the home page (and anywhere else we want to nudge a sync). */
export function RepoCta() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(REPO_URL);
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
      <div className="relative grid items-center gap-6 md:grid-cols-[auto_1fr_auto]">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-container text-primary-on-container">
          <Smartphone className="h-7 w-7" strokeWidth={2} />
        </div>
        <div>
          <h3 className="text-2xl font-bold tracking-tight text-ink md:text-3xl">
            Get the F-Droid client to install.
          </h3>
          <p className="mt-1 max-w-xl text-sm text-ink-soft md:text-base">
            Paste the URL below in F-Droid → Settings → Repositories → +.
          </p>
          <button
            type="button"
            onClick={copy}
            className="mt-3 inline-flex items-center gap-2 rounded-pill border border-outline-soft bg-surface px-3 py-1.5 font-mono text-xs text-ink-soft transition-colors hover:border-outline hover:text-ink"
          >
            <span className="select-all break-all">{REPO_URL}</span>
            {copied ? (
              <Check className="h-3.5 w-3.5 text-primary" strokeWidth={2.4} />
            ) : (
              <Copy className="h-3.5 w-3.5" strokeWidth={2.2} />
            )}
          </button>
        </div>
        <Button
          asChild
          variant="filled"
          size="xl"
          className="shrink-0 self-stretch md:self-center"
        >
          <a href={`fdroidrepos://${REPO_URL.replace(/^https?:\/\//, "")}`}>
            Open in F-Droid
          </a>
        </Button>
      </div>
    </div>
  );
}
