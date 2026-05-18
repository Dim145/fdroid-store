"use client";

import * as RToast from "@radix-ui/react-toast";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";

import { useToastStore, type ToastItem } from "@/lib/toast-store";
import { cn } from "@/lib/utils";

const VARIANT_STYLES: Record<
  ToastItem["variant"],
  { wrapper: string; iconColor: string; Icon: typeof CheckCircle2 }
> = {
  success: {
    wrapper: "border-primary/40 bg-primary-container text-primary-on-container",
    iconColor: "text-primary",
    Icon: CheckCircle2,
  },
  error: {
    wrapper: "border-danger/40 bg-danger-container text-danger-on-container",
    iconColor: "text-danger",
    Icon: XCircle,
  },
  info: {
    wrapper: "border-outline-soft bg-surface text-ink",
    iconColor: "text-ink-soft",
    Icon: Info,
  },
};

/* Bottom-centred toast stack. Mounted once per layout root; reads from the
 * Zustand store so any module can fire ``toast.success(...)`` without
 * passing a ref through props. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <RToast.Provider swipeDirection="down" duration={4200}>
      {toasts.map((t) => {
        const v = VARIANT_STYLES[t.variant];
        return (
          <RToast.Root
            key={t.id}
            open
            onOpenChange={(open) => { if (!open) dismiss(t.id); }}
            className={cn(
              "pointer-events-auto flex w-[min(92vw,420px)] items-start gap-3 rounded-2xl border px-4 py-3 shadow-e3 backdrop-blur",
              "animate-fade-up",
              v.wrapper,
            )}
          >
            <v.Icon className={cn("mt-0.5 h-5 w-5 shrink-0", v.iconColor)} strokeWidth={2.4} />
            <div className="min-w-0 flex-1">
              <RToast.Title className="text-sm font-semibold">
                {t.title}
              </RToast.Title>
              {t.description && (
                <RToast.Description className="mt-0.5 text-xs opacity-85">
                  {t.description}
                </RToast.Description>
              )}
            </div>
            <RToast.Close
              aria-label="Dismiss"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-pill opacity-60 transition-opacity hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </RToast.Close>
          </RToast.Root>
        );
      })}
      <RToast.Viewport className="fixed bottom-4 left-1/2 z-[60] flex w-fit max-w-full -translate-x-1/2 flex-col items-stretch gap-2 outline-none md:bottom-6" />
    </RToast.Provider>
  );
}
