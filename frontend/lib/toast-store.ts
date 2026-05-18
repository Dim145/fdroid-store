"use client";

import { create } from "zustand";

export type ToastVariant = "success" | "error" | "info";

export type ToastItem = {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
};

type State = {
  toasts: ToastItem[];
  push: (variant: ToastVariant, title: string, description?: string) => void;
  dismiss: (id: string) => void;
};

const _useToastStore = create<State>((set) => ({
  toasts: [],
  push: (variant, title, description) =>
    set((s) => ({
      toasts: [
        ...s.toasts,
        {
          id: typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random()}`,
          variant,
          title,
          description,
        },
      ],
    })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Imperative API used outside React components (route handlers, async
 *  callbacks). Inside JSX, ``useToastStore`` works just as well. */
export const toast = {
  success: (title: string, description?: string) =>
    _useToastStore.getState().push("success", title, description),
  error: (title: string, description?: string) =>
    _useToastStore.getState().push("error", title, description),
  info: (title: string, description?: string) =>
    _useToastStore.getState().push("info", title, description),
};

export const useToastStore = _useToastStore;
