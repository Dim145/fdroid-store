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
    // Convert any ``shadow-e[1-3]`` Tailwind utility on ``className``
    // into the equivalent ``filter: drop-shadow(…)`` *inline*. Two
    // reasons:
    //
    //   1. ``box-shadow`` draws on the element's rectangular bounding
    //      box, ignoring the PNG's alpha channel. On an adaptive-icon
    //      foreground (F-Droid Client and most modern apps — robot on
    //      a transparent square) that produces a visible rounded-
    //      square halo around the icon, which reads as a "card frame"
    //      sitting behind the artwork. It's worst in light mode, where
    //      the dark halo against the lighter card is unmistakable.
    //   2. ``filter: drop-shadow()`` follows the alpha — the shadow
    //      hugs the actual robot + panel silhouette and the rectangular
    //      halo vanishes.
    //
    // The downside of ``drop-shadow`` for opaque legacy rasters is
    // identical visual to ``box-shadow``, so swapping is a strict
    // improvement for adaptive icons and a no-op for legacy ones.
    const shadowMatch = (className || "").match(/\bshadow-e([123])\b/);
    const shadowLevel = shadowMatch ? Number(shadowMatch[1]) : 0;
    // Cleaned className with the shadow utility stripped — we'll set
    // the equivalent filter inline below.
    const cleanedClass = (className || "").replace(/\bshadow-e[123]\b/g, "").trim();
    // Single drop-shadow per level — picks the heavier of the two
    // box-shadow layers we used to stack, which reads almost
    // identically against the card surface when the artwork has
    // opaque corners. Values are themed via the existing CSS vars on
    // ``--shadow-*``: those store box-shadow strings, so we hard-code
    // the drop-shadow analogues here instead of re-parsing the var.
    const dropShadowByLevel: Record<number, string> = {
      1: "drop-shadow(0 1px 2px rgb(0 0 0 / 0.22))",
      2: "drop-shadow(0 2px 6px rgb(0 0 0 / 0.28))",
      3: "drop-shadow(0 6px 14px rgb(0 0 0 / 0.32))",
    };
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
        // No ``bg-*`` here on purpose — see comment above on alpha
        // bleed-through. ``border-radius`` is kept for opaque legacy
        // rasters that would otherwise sit as a sharp square.
        className={cn("object-cover", cleanedClass)}
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          filter: shadowLevel ? dropShadowByLevel[shadowLevel] : undefined,
        }}
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
