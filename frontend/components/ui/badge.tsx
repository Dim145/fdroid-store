import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-pill",
  {
    variants: {
      variant: {
        default:    "bg-primary-container text-primary-on-container",
        primary:    "bg-primary text-primary-fg",
        accent:     "bg-accent-container text-accent-on-container",
        soft:       "bg-surface-2 text-ink-soft",
        outline:    "bg-transparent text-ink-soft border border-outline",
        success:    "bg-primary-container text-primary-on-container",
        warning:    "bg-accent-container text-accent-on-container",
        destructive:"bg-danger-container text-danger-on-container",
        secondary:  "bg-surface-2 text-ink-soft",
        ghost:      "bg-transparent text-ink-mute",
        lime:       "bg-primary text-primary-fg",
        orange:     "bg-accent text-accent-fg",
        gold:       "bg-accent-container text-accent-on-container",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
