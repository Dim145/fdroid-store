"use client";

import { useState } from "react";

import { mediaUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

type Props = {
  iconPath: string | null | undefined;
  name: string;
  size?: number;
  className?: string;
  /** Bump to bust the browser cache when the bytes behind a key may have changed. */
  version?: string | number;
  /** Per-app signed token (``AppRead.media_token``); required to render
   *  private-app icons since <img src> tags can't send Authorization. */
  mediaToken?: string | null;
  /** Play Store-ish rounded corners by default. */
  shape?: "rounded" | "square" | "circle";
};

/* App icon with a deterministic gradient fallback. We deliberately don't use
 * next/image so this can be rendered without a configured loader and survives
 * being pulled from a sibling origin. Failed loads gracefully degrade to a
 * letter-monogram on a hue picked from the package/app name. */
export function AppIcon({
  iconPath,
  name,
  size = 56,
  className,
  version,
  mediaToken,
  shape = "rounded",
}: Props) {
  const [failed, setFailed] = useState(false);
  const url = mediaUrl(iconPath, { version, token: mediaToken });

  // 22% radius matches Material You / Play Store app icon styling at any size.
  const radius =
    shape === "circle" ? "9999px" : shape === "square" ? "6px" : "22%";

  if (url && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={`${name} icon`}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className={cn("bg-surface-2 object-cover", className)}
        style={{ width: size, height: size, borderRadius: radius }}
      />
    );
  }

  // Same hash → same hue per app, gives a stable fallback that doesn't jump
  // around on rerenders.
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  const letter = (name.trim().charAt(0) || "?").toUpperCase();

  return (
    <div
      className={cn(
        "flex items-center justify-center font-semibold text-white",
        className,
      )}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: `linear-gradient(135deg, hsl(${hue}, 60%, 45%), hsl(${(hue + 35) % 360}, 70%, 35%))`,
        fontSize: size * 0.42,
        letterSpacing: "-0.03em",
      }}
      aria-label={`${name} icon`}
    >
      {letter}
    </div>
  );
}
