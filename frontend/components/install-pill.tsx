"use client";

import { Download } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { fdroidDeepLink, useRepoInfo } from "@/lib/repo-store";
import { cn } from "@/lib/utils";

type Props = {
  /** Direct-download fallback for the latest APK file. */
  apkFileName?: string;
  /** Visual emphasis — XL is the detail-page hero pill. */
  size?: "md" | "lg" | "xl";
  className?: string;
};

/* Signature install CTA. The deep-link scheme matches the configured repo
 * URL (fdroidrepo:// for HTTP, fdroidrepos:// for HTTPS) so we never hand
 * F-Droid a URL on the wrong port. */
export function InstallPill({ apkFileName, size = "lg", className }: Props) {
  const repo = useRepoInfo();
  const [hover, setHover] = useState(false);
  const fdLink = fdroidDeepLink(repo.url, { fingerprint: repo.fingerprint });
  const apkLink = apkFileName ? `${repo.url}/${apkFileName}` : null;

  return (
    <div className={cn("flex flex-col items-stretch gap-2", className)}>
      <Button
        asChild
        variant="filled"
        size={size}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className={cn(
          "group relative overflow-hidden",
          size === "xl" && "h-14 px-8 text-base",
        )}
      >
        <a href={fdLink}>
          <Download
            className={cn(
              "h-4 w-4 transition-transform duration-300",
              hover ? "translate-y-0.5" : "",
            )}
            strokeWidth={2.4}
          />
          <span>Install</span>
        </a>
      </Button>
      {apkLink && (
        <Button asChild variant="tonal" size="sm" className="self-stretch">
          <a href={apkLink} download className="text-xs">
            Or download .apk
          </a>
        </Button>
      )}
    </div>
  );
}
