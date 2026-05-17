"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

type Mode = "light" | "dark";

type ThemeContextValue = {
  mode: Mode;
  /** What the user picked: an explicit mode, or "system" which follows the OS. */
  preference: Mode | "system";
  setPreference: (next: Mode | "system") => void;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = "theme";

function readSystem(): Mode {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStored(): Mode | "system" {
  if (typeof window === "undefined") return "system";
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === "light" || v === "dark") return v;
  return "system";
}

/* The provider reads the user's stored preference (or falls back to the OS).
 * It writes the resolved mode to the <html data-theme> attribute on every
 * change, and listens for OS-level changes when the user is on "system".
 *
 * The pre-paint script in layout.tsx already sets the initial attribute, so
 * the provider's mount-effect is a no-op visually — but it keeps React state
 * in sync with the DOM and wires up the live OS listener. */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<Mode | "system">("system");
  const [mode, setMode] = useState<Mode>("light");

  // Hydrate from storage + initial OS read.
  useEffect(() => {
    const pref = readStored();
    setPreferenceState(pref);
    const resolved = pref === "system" ? readSystem() : pref;
    setMode(resolved);
    document.documentElement.setAttribute("data-theme", resolved);
  }, []);

  // Live-follow the OS when the user is on "system".
  useEffect(() => {
    if (preference !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      const next: Mode = e.matches ? "dark" : "light";
      setMode(next);
      document.documentElement.setAttribute("data-theme", next);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [preference]);

  const setPreference = useCallback((next: Mode | "system") => {
    setPreferenceState(next);
    if (next === "system") {
      localStorage.removeItem(STORAGE_KEY);
      const resolved = readSystem();
      setMode(resolved);
      document.documentElement.setAttribute("data-theme", resolved);
    } else {
      localStorage.setItem(STORAGE_KEY, next);
      setMode(next);
      document.documentElement.setAttribute("data-theme", next);
    }
  }, []);

  const toggle = useCallback(() => {
    setPreference(mode === "dark" ? "light" : "dark");
  }, [mode, setPreference]);

  return (
    <ThemeContext.Provider value={{ mode, preference, setPreference, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Safe fallback for places that mount before the provider hydrates.
    return {
      mode: "light",
      preference: "system",
      setPreference: () => {},
      toggle: () => {},
    };
  }
  return ctx;
}
