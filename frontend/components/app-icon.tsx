"use client";

import { useState } from "react";

import { mediaUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

type Props = {
  iconPath: string | null | undefined;
  name: string;
  size?: number;
  className?: string;
  /** Cache-buster — bump when the underlying icon may have changed. */
  version?: string | number;
};

/** Square app icon with a deterministic monogram fallback if the image fails
 *  to load (or is missing). Renders an <img> so it works without next/image. */
export function AppIcon({ iconPath, name, size = 48, className, version }: Props) {
  const [failed, setFailed] = useState(false);
  const url = mediaUrl(iconPath, version);

  if (url && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={`${name} icon`}
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
        className={cn("rounded-md bg-muted object-cover", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  // Deterministic background colour from the name so the placeholder is stable
  // per app instead of jumping around on each render.
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  const letter = (name.trim().charAt(0) || "?").toUpperCase();

  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-md font-semibold text-white",
        className,
      )}
      style={{
        width: size,
        height: size,
        backgroundColor: `hsl(${hue}, 55%, 45%)`,
        fontSize: size * 0.45,
      }}
      aria-label={`${name} icon`}
    >
      {letter}
    </div>
  );
}
