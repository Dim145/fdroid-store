"use client";

import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

/* ============================================================================
 * Sheet — right-edge slide-in drawer.
 *
 * Used by the APK row in /my-apps/[id] for the RB editor, CVE details and
 * changelog editor. All three were inline-expanding panels that ate vertical
 * space and broke the reading rhythm of the version list; pulling them into
 * a side sheet keeps the row dense while giving each form / table the
 * horizontal room it needs.
 *
 * Aesthetic mirrors the existing screenshot lightbox (deep-ink backdrop with
 * a touch of blur, hairline outline-soft borders, focus-visible ring on the
 * close affordance) so the two overlays read as one design language.
 *
 * Mechanics:
 *   - Portaled into ``document.body`` so the slide-in escapes any parent
 *     ``overflow: hidden`` and can sit above the site header.
 *   - ``motion`` / AnimatePresence handles enter+exit so a click on the
 *     close button slides the panel off-screen instead of popping.
 *   - Escape key and click-on-backdrop both close. Body scroll is locked
 *     while open — restored on unmount even if the parent forgets to clean
 *     up state.
 *   - The first focusable element inside the body (typically the close
 *     button via the header) gets keyboard focus on open, so the dialog is
 *     reachable to keyboard users without sifting through tab order.
 * ============================================================================ */

type SheetSize = "default" | "wide";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** Used for ``aria-labelledby`` — also rendered as the header title. */
  title: React.ReactNode;
  /** Optional second-line subtitle / eyebrow rendered in the header.
   *  Typical content: the APK version pill, the package name, a status chip. */
  eyebrow?: React.ReactNode;
  /** Optional sticky-footer area for primary actions (Save / Cancel etc.). */
  footer?: React.ReactNode;
  /** ``"default"`` = 520 px, ``"wide"`` = 720 px on desktop. Both are full-
   *  width on mobile (under sm). The CVE table benefits from the wider
   *  layout; forms work better at the default. */
  size?: SheetSize;
  children: React.ReactNode;
}

export function Sheet({
  open,
  onClose,
  title,
  eyebrow,
  footer,
  size = "default",
  children,
}: SheetProps) {
  // SSR-safe portal target. During the static export pre-render the body
  // isn't available, so we bail and let the client-side mount re-render
  // us into the portal.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
  }, []);

  // Lock body scroll while open + bind Escape. Mount-once effect keyed on
  // the open flag so we don't keep re-binding on every render.
  React.useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    const orig = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = orig;
    };
  }, [open, onClose]);

  // Auto-focus the close button on open. Wrapped in a microtask so the
  // panel has actually painted before we grab focus (otherwise the focus
  // ring flickers as the motion enter animation interpolates transform).
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      closeRef.current?.focus();
    }, 60);
    return () => window.clearTimeout(id);
  }, [open]);

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="sheet-title"
          className="fixed inset-0 z-[100]"
        >
          {/* Backdrop — same deep-ink + blur recipe as the lightbox, slightly
              lighter so the version list shows through and you remember
              what you're editing. */}
          <motion.div
            aria-hidden
            className="absolute inset-0 bg-bg/[0.78] backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            onClick={onClose}
          />

          {/* Panel — slides in from the right. The drop shadow on the left
              edge tucks under the backdrop for a subtle depth read. */}
          <motion.aside
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              "absolute inset-y-0 right-0 flex w-full flex-col bg-surface text-ink shadow-[-24px_0_60px_-30px_rgb(0_0_0/0.5)]",
              "border-l border-outline-soft",
              size === "wide" ? "sm:max-w-[720px]" : "sm:max-w-[520px]",
            )}
          >
            {/* Header — eyebrow pill, title, close affordance. The eyebrow
                slot is meant for the version chip / package name so users
                always see WHICH APK they're editing inside the sheet. */}
            <header className="flex items-start gap-3 border-b border-outline-soft px-5 py-4 sm:px-6 sm:py-5">
              <div className="min-w-0 flex-1">
                {eyebrow && (
                  <div className="mb-1 flex flex-wrap items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.24em] text-ink-mute">
                    {eyebrow}
                  </div>
                )}
                <h2
                  id="sheet-title"
                  className="text-lg font-semibold leading-tight tracking-tight text-ink sm:text-xl"
                >
                  {title}
                </h2>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="-mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-outline-soft bg-surface text-ink-soft transition-colors hover:border-outline hover:text-ink focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30"
              >
                <X className="h-4 w-4" strokeWidth={2.2} />
              </button>
            </header>

            {/* Body — scrollable region. We deliberately do NOT pad with
                ``space-y-*`` here so each consumer keeps its own rhythm. */}
            <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6 sm:py-6">
              {children}
            </div>

            {footer && (
              <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-outline-soft bg-surface px-5 py-3 sm:px-6 sm:py-4">
                {footer}
              </footer>
            )}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
