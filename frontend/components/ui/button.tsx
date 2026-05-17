import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/* Material 3-style button system. Five flavors mapped to clear roles:
 *   filled    — top-level CTA (Install, Save, Submit)
 *   tonal     — secondary action, lower contrast than filled
 *   outlined  — alternative action that needs structure
 *   text      — tertiary / dense inline actions
 *   elevated  — sits on busy backgrounds where outlined would get lost
 *   danger    — destructive ops (delete, revoke)
 *   icon      — square slot for an icon-only button
 *
 * Sizes follow M3 height tokens with a "pill" variant for the iconic
 * Install CTA. */
const buttonVariants = cva(
  [
    "relative inline-flex items-center justify-center gap-2 font-medium",
    "select-none whitespace-nowrap",
    "transition-[background-color,color,box-shadow,transform] duration-150 ease-m3",
    "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30",
    "disabled:pointer-events-none disabled:opacity-40",
  ].join(" "),
  {
    variants: {
      variant: {
        filled:
          "bg-primary text-primary-fg shadow-e1 hover:shadow-e2 hover:brightness-[1.04] active:brightness-95",
        tonal:
          "bg-primary-container text-primary-on-container hover:brightness-[1.04] active:brightness-95",
        outlined:
          "bg-transparent text-ink border border-outline hover:bg-surface-2",
        text:
          "bg-transparent text-primary hover:bg-primary/8 active:bg-primary/12",
        elevated:
          "bg-surface text-primary shadow-e1 hover:shadow-e2 hover:bg-surface-2",
        danger:
          "bg-danger text-danger-fg shadow-e1 hover:shadow-e2 hover:brightness-[1.04] active:brightness-95",
        ghost:
          "bg-transparent text-ink hover:bg-surface-2",
      },
      size: {
        sm: "h-8 px-3 rounded-pill text-xs",
        md: "h-10 px-5 rounded-pill text-sm",
        lg: "h-11 px-6 rounded-pill text-sm",
        xl: "h-13 px-8 rounded-pill text-base",
        icon: "h-10 w-10 rounded-pill",
        "icon-sm": "h-8 w-8 rounded-pill",
      },
    },
    defaultVariants: { variant: "filled", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
