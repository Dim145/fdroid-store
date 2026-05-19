"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { groupPermissions } from "@/lib/android-permissions";

type Props = {
  permissions: string[];
  /** Show "X permissions · vY" header above the groups when given. */
  versionLabel?: string;
};

/* Play-Store-style grouping: every permission is bucketed under a
 * human-named category (Contacts, Storage, Camera, …) and rendered as a
 * short sentence. Anything we don't have a curated translation for falls
 * into "Other" with a best-effort humanisation of its constant name. */
export function AppPermissions({ permissions, versionLabel }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const groups = useMemo(() => groupPermissions(permissions), [permissions]);
  const totalCount = permissions.length;

  if (totalCount === 0) {
    return <p className="text-sm italic text-ink-mute">{t("permissions.none")}</p>;
  }

  // Show the first two columns of groups by default — that covers most apps.
  // Anything beyond that lives behind "Show all".
  const INITIAL_GROUPS = 4;
  const visibleGroups = expanded ? groups : groups.slice(0, INITIAL_GROUPS);
  const hiddenGroups = groups.length - visibleGroups.length;

  return (
    <div className="space-y-4">
      {versionLabel && (
        <p className="font-mono text-xs text-ink-mute">
          {t("permissions.summary", {
            count: totalCount,
            groups: groups.length,
            groupWord: t("permissions.group", { count: groups.length }),
            version: versionLabel,
          })}
        </p>
      )}

      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
        {visibleGroups.map(({ key, group, items }) => {
          const Icon = group.icon;
          return (
            <section key={key} className="min-w-0">
              <header className="mb-2 flex items-center gap-2.5 text-ink">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-pill bg-surface-2 text-ink-soft">
                  <Icon className="h-3.5 w-3.5" strokeWidth={2.2} />
                </span>
                <h4 className="text-sm font-semibold tracking-tight">
                  {group.label}
                </h4>
                <span className="font-mono text-[10px] text-ink-mute">
                  ×{items.length}
                </span>
              </header>
              <ul className="space-y-1 pl-9 text-sm leading-relaxed text-ink-soft">
                {items.map((p) => (
                  <li
                    key={p.raw}
                    title={p.raw}
                    className="relative before:absolute before:-left-3.5 before:top-2 before:h-1 before:w-1 before:rounded-full before:bg-ink-mute"
                  >
                    {p.text}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      {hiddenGroups > 0 && (
        <Button variant="text" size="sm" onClick={() => setExpanded(true)} className="px-0">
          {t("permissions.showMore", { count: hiddenGroups })}
        </Button>
      )}
      {expanded && groups.length > INITIAL_GROUPS && (
        <Button variant="text" size="sm" onClick={() => setExpanded(false)} className="px-0">
          {t("permissions.showLess")}
        </Button>
      )}
    </div>
  );
}
