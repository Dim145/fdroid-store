"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { api, type AppSummary } from "@/lib/api";

/* Editorial ticker — a continuously-scrolling band of the most-recently-
 * updated apps. Sits between the header and the page content as the
 * site's signature movement.
 *
 * Implementation note: we duplicate the items inline so the CSS keyframe
 * can translate by exactly -50% and produce a seamless loop. The animation
 * pauses on hover via CSS so the user can read it. */
export function Marquee() {
  const [items, setItems] = useState<AppSummary[]>([]);

  useEffect(() => {
    api.apps
      .list()
      .then((apps) => setItems(apps.slice(0, 18)))
      .catch(() => setItems([]));
  }, []);

  if (items.length === 0) return null;

  const display = [...items, ...items];

  return (
    <div className="group relative overflow-hidden border-y border-ink bg-ink text-bg">
      <div className="pointer-events-none absolute left-0 top-0 z-10 h-full w-12 bg-gradient-to-r from-ink to-transparent" />
      <div className="pointer-events-none absolute right-0 top-0 z-10 h-full w-12 bg-gradient-to-l from-ink to-transparent" />
      <div className="flex animate-marquee whitespace-nowrap py-2.5 will-change-transform group-hover:[animation-play-state:paused]">
        {display.map((app, i) => (
          <Link
            key={`${app.id}-${i}`}
            href={`/apps/${app.package_name}`}
            className="mx-6 inline-flex items-center gap-3 font-mono text-[11px] tracking-widest uppercase opacity-80 transition-opacity hover:opacity-100"
          >
            <span className="text-lime">▸</span>
            <span>{app.name}</span>
            <span className="text-ink-fade">·</span>
            <span className="text-ink-fade">
              v{app.suggested_version_name ?? "—"}
            </span>
            <span className="text-ink-fade">·</span>
            <span className="text-ink-fade">{app.package_name}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
