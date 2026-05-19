"use client";

import { Moon, Sun, MonitorSmartphone } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

/* Material 3-style segmented toggle for theme preference. Shows three states:
 * light · system · dark. Persists via the ThemeProvider. The segment for the
 * currently-selected preference is filled; the others are ghost icons. */
export function ThemeToggle() {
  const { t } = useTranslation();
  const { preference, setPreference } = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <div
      className={cn(
        "relative inline-flex h-9 items-center rounded-pill border border-outline bg-surface p-0.5 text-ink-soft transition-colors",
      )}
      role="group"
      aria-label={t("theme.label")}
    >
      <Segment
        active={preference === "light"}
        onClick={() => setPreference("light")}
        label={t("theme.light")}
      >
        <Sun className="h-3.5 w-3.5" strokeWidth={2.2} />
      </Segment>
      <Segment
        active={preference === "system"}
        onClick={() => setPreference("system")}
        label={t("theme.system")}
      >
        <MonitorSmartphone className="h-3.5 w-3.5" strokeWidth={2.2} />
      </Segment>
      <Segment
        active={preference === "dark"}
        onClick={() => setPreference("dark")}
        label={t("theme.dark")}
      >
        <Moon className="h-3.5 w-3.5" strokeWidth={2.2} />
      </Segment>
      {/* Keep hook in scope for future menu state. */}
      <span className="sr-only" aria-hidden>{open ? "" : ""}</span>
      <span aria-hidden onClick={() => setOpen(false)} />
    </div>
  );
}

function Segment({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-pill text-current transition-all",
        active
          ? "bg-primary text-primary-fg"
          : "hover:bg-surface-2 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
