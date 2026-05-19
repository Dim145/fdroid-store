import type { Config } from "tailwindcss";

const config: Config = {
  // We toggle dark mode via a data attribute on <html> so the inline script
  // in layout.tsx can decide the theme before the first paint (no FOUC).
  darkMode: ["class", '[data-theme="dark"]'],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: { DEFAULT: "1rem", lg: "1.5rem", xl: "2rem" },
      screens: { "2xl": "1440px" },
    },
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        /* --- Material 3-ish semantic colors -----------------------------
           All values are exposed via CSS variables so we can swap light/dark
           without rebuilding. Tailwind utilities reference them by name. */
        bg: "rgb(var(--bg) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        "surface-2": "rgb(var(--surface-2) / <alpha-value>)",
        "surface-3": "rgb(var(--surface-3) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        "ink-soft": "rgb(var(--ink-soft) / <alpha-value>)",
        "ink-mute": "rgb(var(--ink-mute) / <alpha-value>)",
        outline: "rgb(var(--outline) / <alpha-value>)",
        "outline-soft": "rgb(var(--outline-soft) / <alpha-value>)",

        primary: {
          DEFAULT: "rgb(var(--primary) / <alpha-value>)",
          fg: "rgb(var(--primary-fg) / <alpha-value>)",
          container: "rgb(var(--primary-container) / <alpha-value>)",
          "on-container": "rgb(var(--primary-on-container) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          fg: "rgb(var(--accent-fg) / <alpha-value>)",
          container: "rgb(var(--accent-container) / <alpha-value>)",
          "on-container": "rgb(var(--accent-on-container) / <alpha-value>)",
        },
        danger: {
          DEFAULT: "rgb(var(--danger) / <alpha-value>)",
          fg: "rgb(var(--danger-fg) / <alpha-value>)",
          container: "rgb(var(--danger-container) / <alpha-value>)",
          "on-container": "rgb(var(--danger-on-container) / <alpha-value>)",
        },

        // shadcn aliases preserved for any leftover imports.
        background: "rgb(var(--bg) / <alpha-value>)",
        foreground: "rgb(var(--ink) / <alpha-value>)",
        border: "rgb(var(--outline-soft) / <alpha-value>)",
        input: "rgb(var(--outline) / <alpha-value>)",
        ring: "rgb(var(--primary) / <alpha-value>)",
        card: {
          DEFAULT: "rgb(var(--surface) / <alpha-value>)",
          foreground: "rgb(var(--ink) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "rgb(var(--surface-2) / <alpha-value>)",
          foreground: "rgb(var(--ink-soft) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "rgb(var(--surface-2) / <alpha-value>)",
          foreground: "rgb(var(--ink) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "rgb(var(--danger) / <alpha-value>)",
          foreground: "rgb(var(--danger-fg) / <alpha-value>)",
        },
        accent2: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          foreground: "rgb(var(--accent-fg) / <alpha-value>)",
        },
      },
      borderRadius: {
        none: "0px",
        sm: "8px",
        DEFAULT: "12px",
        md: "12px",
        lg: "16px",
        xl: "20px",
        "2xl": "24px",
        "3xl": "28px",
        pill: "9999px",
      },
      boxShadow: {
        /* M3 elevation levels (light). Dark variants are CSS-overridden. */
        e1: "var(--shadow-1)",
        e2: "var(--shadow-2)",
        e3: "var(--shadow-3)",
        e4: "var(--shadow-4)",
        ring: "0 0 0 4px rgb(var(--primary) / 0.18)",
        "ring-danger": "0 0 0 4px rgb(var(--danger) / 0.18)",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "fade-up": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-down": {
          from: { transform: "translateY(-8px)", opacity: "0" },
          to: { transform: "translateY(0)", opacity: "1" },
        },
        "slide-in-right": {
          from: { transform: "translateX(24px)", opacity: "0" },
          to: { transform: "translateX(0)", opacity: "1" },
        },
        ripple: {
          "0%": { transform: "scale(0)", opacity: "0.35" },
          "100%": { transform: "scale(2.2)", opacity: "0" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.35s ease-out both",
        "fade-up": "fade-up 0.5s cubic-bezier(0.22, 1, 0.36, 1) both",
        "slide-down": "slide-down 0.25s ease-out both",
        "slide-in-right": "slide-in-right 0.28s cubic-bezier(0.22, 1, 0.36, 1) both",
      },
      transitionTimingFunction: {
        // Material standard easing — used by interactive components.
        m3: "cubic-bezier(0.2, 0, 0, 1)",
      },
    },
  },
  plugins: [],
};
export default config;
