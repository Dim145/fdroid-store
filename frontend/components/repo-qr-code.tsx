"use client";

import { QrCode as QrIcon } from "lucide-react";
import QRCode from "react-qr-code";

import { fdroidDeepLink, useRepoInfo } from "@/lib/repo-store";
import { cn } from "@/lib/utils";

type Props = {
  /** Embed credentials in the QR via HTTP Basic auth in the URL. */
  credentials?: { username: string; secret: string } | null;
  /** Display size in pixels (the QR scales sharp at any size). */
  size?: number;
  className?: string;
  /** Override the auto-fetched fingerprint (e.g. when a parent already has it). */
  fingerprint?: string | null;
  /** Override the repo URL — useful in the setup wizard preview. */
  repoUrl?: string;
  /** Show the encoded URL underneath the QR. */
  showCaption?: boolean;
};

/* Encodes an `fdroidrepo(s)://` deep link as a QR code.
 *
 *   - `fdroidrepos://` is used when the public repo URL is HTTPS
 *   - `fdroidrepo://`  is used when it is plain HTTP
 *
 * Repo URL + fingerprint come from the public /setup/status endpoint via
 * useRepoInfo(), so the QR always reflects the LIVE admin configuration —
 * if the admin changes the public address, the next render picks it up. */
export function RepoQrCode({
  credentials,
  size = 200,
  className,
  fingerprint,
  repoUrl,
  showCaption = false,
}: Props) {
  const repo = useRepoInfo();
  const effectiveFingerprint = fingerprint ?? repo.fingerprint;
  const effectiveRepoUrl = repoUrl ?? repo.url;
  const value = fdroidDeepLink(effectiveRepoUrl, {
    credentials,
    fingerprint: effectiveFingerprint,
  });

  return (
    <div className={cn("inline-flex flex-col items-center gap-2", className)}>
      {/* Locked-white substrate. Some scanners struggle with dark
          backgrounds, so we keep the QR's surroundings white regardless of
          the active theme. */}
      <div className="rounded-2xl bg-white p-3 shadow-e2 ring-1 ring-black/5">
        <QRCode
          value={value}
          size={size}
          viewBox="0 0 256 256"
          bgColor="#FFFFFF"
          fgColor="#0A0A0A"
          level="M"
          aria-label="F-Droid repository QR code"
        />
      </div>
      {showCaption && (
        <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-mute">
          <QrIcon className="h-3 w-3" />
          Scan in F-Droid
        </p>
      )}
    </div>
  );
}
