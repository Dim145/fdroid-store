"use client";

import { cn } from "@/lib/utils";

type Props = {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  /** Accessible label — required when the switch isn't labeled by its row. */
  ariaLabel?: string;
  id?: string;
  className?: string;
};

/* A tactile pill-shaped toggle. The thumb shifts and the track tints when
 * active; when disabled the whole thing dims and refuses clicks. ``role
 * ="switch"`` + ``aria-checked`` keeps it screen-reader-friendly without
 * relying on a hidden checkbox input. */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  ariaLabel,
  id,
  className,
}: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      id={id}
      disabled={disabled}
      onClick={() => !disabled && onCheckedChange(!checked)}
      className={cn(
        "group relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-pill",
        "border border-transparent transition-colors duration-200 ease-m3",
        "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-surface-3",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none inline-block h-5 w-5 rounded-full bg-surface shadow-e2",
          "transition-transform duration-200 ease-m3",
          checked ? "translate-x-[1.375rem]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
