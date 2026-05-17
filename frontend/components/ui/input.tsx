import * as React from "react";

import { cn } from "@/lib/utils";

/* M3 outlined text field — rounded, ample padding, primary-focused outline. */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-12 w-full rounded-xl border border-outline bg-surface px-4 py-2.5",
        "text-[15px] text-ink placeholder:text-ink-mute",
        "file:mr-3 file:rounded-pill file:border-0 file:bg-primary file:px-3 file:py-1 file:text-xs file:font-medium file:text-primary-fg",
        "transition-[border-color,box-shadow] duration-150 ease-m3",
        "focus-visible:outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/20",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input };
