"use client";

import { Download } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { REPO_URL } from "@/lib/api";
import { cn } from "@/lib/utils";

type Props = {
  /** Direct-download fallback for the latest APK file. */
  apkFileName?: string;
  /** Visual emphasis — XL is the detail-page hero pill. */
  size?: "md" | "lg" | "xl";
  className?: string;
};

/* The signature CTA — the green "Install" pill that anchors any app page.
 * Two stacked actions:
 *   1. fdroidrepos:// deep link to add this repo + the app to F-Droid
 *   2. a smaller "Direct .apk" link for desktop browsers / sideload */
export function InstallPill({ apkFileName, size = "lg", className }: Props) {
  const [hover, setHover] = useState(false);
  const fdLink = `fdroidrepos://${REPO_URL.replace(/^https?:\/\//, "")}`;
  const apkLink = apkFileName ? `${REPO_URL}/${apkFileName}` : null;

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
