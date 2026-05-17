"use client";

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Props = {
  permissions: string[];
  /** Versions whose declared permissions match this version_name are listed
   *  in the subtitle. Optional. */
  versionLabel?: string;
};

/** Shorten ``android.permission.INTERNET`` to ``INTERNET`` for readability,
 *  but keep the full name on hover via the ``title`` attribute. App-private
 *  permissions (e.g. ``org.fdroid.fdroid.permission.UPDATE_REPOS``) stay
 *  fully qualified — they aren't part of the Android system catalog and
 *  the user benefits from seeing the package context. */
function shortLabel(perm: string): string {
  if (perm.startsWith("android.permission.")) {
    return perm.slice("android.permission.".length);
  }
  return perm;
}

const INITIAL_VISIBLE = 12;

export function AppPermissions({ permissions, versionLabel }: Props) {
  const [expanded, setExpanded] = useState(false);
  const sorted = useMemo(() => [...permissions].sort(), [permissions]);

  if (sorted.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This version doesn&apos;t request any permissions.
      </p>
    );
  }

  const visible = expanded ? sorted : sorted.slice(0, INITIAL_VISIBLE);
  const hidden = sorted.length - visible.length;

  return (
    <div className="space-y-3">
      {versionLabel && (
        <p className="text-xs text-muted-foreground">
          {sorted.length} permission{sorted.length === 1 ? "" : "s"} requested by version{" "}
          <span className="font-medium">{versionLabel}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {visible.map((perm) => (
          <Badge
            key={perm}
            variant="outline"
            title={perm}
            className="font-mono text-[11px] font-normal"
          >
            {shortLabel(perm)}
          </Badge>
        ))}
      </div>
      {hidden > 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(true)}
          className="h-auto px-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
        >
          Show {hidden} more…
        </Button>
      )}
      {expanded && sorted.length > INITIAL_VISIBLE && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(false)}
          className="h-auto px-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
        >
          Collapse
        </Button>
      )}
    </div>
  );
}
