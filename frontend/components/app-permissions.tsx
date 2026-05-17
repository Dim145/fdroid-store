"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  permissions: string[];
  versionLabel?: string;
};

function shortLabel(perm: string): string {
  if (perm.startsWith("android.permission.")) return perm.slice("android.permission.".length);
  return perm;
}

function isSystem(perm: string): boolean {
  return perm.startsWith("android.permission.");
}

const INITIAL_VISIBLE = 14;

export function AppPermissions({ permissions, versionLabel }: Props) {
  const [expanded, setExpanded] = useState(false);
  const sorted = useMemo(() => [...permissions].sort(), [permissions]);

  if (sorted.length === 0) {
    return <p className="text-sm text-ink-mute italic">This version requests no permissions.</p>;
  }

  const visible = expanded ? sorted : sorted.slice(0, INITIAL_VISIBLE);
  const hidden = sorted.length - visible.length;

  return (
    <div className="space-y-3">
      {versionLabel && (
        <p className="font-mono text-xs text-ink-mute">
          {sorted.length} permission{sorted.length === 1 ? "" : "s"} · v{versionLabel}
        </p>
      )}
      <ul className="flex flex-wrap gap-1.5">
        {visible.map((perm) => (
          <li
            key={perm}
            title={perm}
            className={cn(
              "chip cursor-default",
              !isSystem(perm) && "data-[active=true]",
            )}
            data-active={!isSystem(perm)}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                isSystem(perm) ? "bg-ink-mute" : "bg-accent",
              )}
            />
            <span className="font-mono text-[11px]">{shortLabel(perm)}</span>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <Button variant="text" size="sm" onClick={() => setExpanded(true)} className="px-0">
          + show {hidden} more
        </Button>
      )}
      {expanded && sorted.length > INITIAL_VISIBLE && (
        <Button variant="text" size="sm" onClick={() => setExpanded(false)} className="px-0">
          – show less
        </Button>
      )}
    </div>
  );
}
