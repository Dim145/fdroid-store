"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { fdroidDeepLink, useRepoInfo } from "@/lib/repo-store";
import { cn } from "@/lib/utils";

type Mode = "deeplink" | "download";

type Props = {
  /** Direct-download fallback for the latest APK file. */
  apkFileName?: string;
  /** APK row id, used to exchange the user's JWT for a signed download URL
   *  in private mode (anchor clicks carry no Authorization header). */
  apkId?: string;
  /** Visual emphasis — XL is the detail-page hero pill. */
  size?: "md" | "lg" | "xl";
  /** ``deeplink`` (default) renders the F-Droid Install pill plus a small
   *  "Or download .apk" fallback — the right shape on a mobile device that
   *  actually has an F-Droid client. ``download`` renders a single big pill
   *  that directly downloads the APK — the only useful action on desktop,
   *  where the fdroidrepo:// scheme is a dead end. */
  mode?: Mode;
  className?: string;
};

/* Signature install CTA. The deep-link scheme matches the configured repo
 * URL (fdroidrepo:// for HTTP, fdroidrepos:// for HTTPS) so we never hand
 * F-Droid a URL on the wrong port. */
export function InstallPill({
  apkFileName,
  apkId,
  size = "lg",
  mode = "deeplink",
  className,
}: Props) {
  const { t } = useTranslation();
  const repo = useRepoInfo();
  const { user } = useAuth();
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const fdLink = fdroidDeepLink(repo.url, { fingerprint: repo.fingerprint });
  const apkLink = apkFileName ? `${repo.url}/${apkFileName}` : null;

  async function onClickApk(e: React.MouseEvent<HTMLAnchorElement>) {
    // Anonymous + public mode: the direct URL works, let the browser
    // handle the click. Logged-in users in private mode need a signed
    // URL — anchor clicks carry no Authorization header otherwise.
    if (!user || !apkId) return;
    e.preventDefault();
    setBusy(true);
    try {
      const { url } = await api.apps.downloadUrl(apkId);
      // Reject anything that isn't a same-origin or http(s) URL — defence
      // against a misconfigured ``config.address`` smuggling a
      // ``javascript:`` URI through the API response (CWE-79).
      if (!/^https?:\/\//i.test(url) && !url.startsWith("/")) {
        throw new Error("unsafe download URL");
      }
      window.location.href = url;
    } catch {
      // Fall through to the raw URL — the browser then prompts for
      // Basic-auth in private mode, which at least surfaces the failure
      // instead of looking broken.
      if (apkLink) window.location.href = apkLink;
    } finally {
      setBusy(false);
    }
  }

  // Desktop / "download-only" mode: a single big green pill that fires the
  // same signed-URL flow as the small fallback button.
  if (mode === "download") {
    if (!apkLink) return null;
    return (
      <Button
        asChild
        variant="filled"
        size={size}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        disabled={busy}
        className={cn(
          "group relative overflow-hidden",
          size === "xl" && "h-14 px-8 text-base",
          className,
        )}
      >
        <a href={apkLink} onClick={onClickApk} download>
          <Download
            className={cn(
              "h-4 w-4 transition-transform duration-300",
              hover ? "translate-y-0.5" : "",
            )}
            strokeWidth={2.4}
          />
          <span>{busy ? "…" : t("appDetail.downloadApk")}</span>
        </a>
      </Button>
    );
  }

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
          <span>{t("appDetail.install")}</span>
        </a>
      </Button>
      {apkLink && (
        <Button asChild variant="tonal" size="sm" className="self-stretch" disabled={busy}>
          <a href={apkLink} onClick={onClickApk} download className="text-xs">
            {busy ? "…" : t("appDetail.orDownloadApk")}
          </a>
        </Button>
      )}
    </div>
  );
}
