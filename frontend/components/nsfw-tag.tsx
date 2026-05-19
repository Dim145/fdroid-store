"use client";

import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

type Props = {
  /** When true, render nothing. Lets callers pass ``app.is_nsfw`` directly. */
  active: boolean;
  /** ``sm`` = card overlay (default), ``md`` = detail hero overlay. */
  size?: "sm" | "md";
  className?: string;
};

/* A compact corner stamp that sits at the top-right of an AppIcon, signaling
 * adult content without spending vertical space inside the card body. The
 * caller is responsible for placing this inside a ``relative`` parent — the
 * NsfwTag positions itself absolutely against that. */
export function NsfwTag({ active, size = "sm", className }: Props) {
  const { t } = useTranslation();
  if (!active) return null;
  return (
    <span
      aria-label={t("appDetail.nsfw.tagline")}
      className={cn(
        "pointer-events-none absolute z-10 select-none rounded-md bg-danger",
        "font-mono font-bold uppercase tracking-wider text-danger-fg shadow-e1",
        "ring-1 ring-inset ring-white/30",
        size === "md"
          ? "-right-2 -top-2 px-1.5 py-0.5 text-[10px]"
          : "-right-1 -top-1 px-1 py-px text-[9px] leading-tight",
        className,
      )}
    >
      {t("nsfwTag")}
    </span>
  );
}
