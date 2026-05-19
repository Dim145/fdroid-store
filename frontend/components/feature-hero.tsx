"use client";

import Link from "next/link";
import { useTranslation } from "react-i18next";

import { AppIcon } from "@/components/app-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type AppSummary } from "@/lib/api";

type Props = {
  app: AppSummary;
  /** Optional override of the kicker badge ("Editor's choice", "Featured today"…) */
  kicker?: string;
};

/* The big banner at the top of the home page. Tints the card with a hue
 * derived from the app name so each featured app feels color-coordinated.
 * Mobile collapses to a stacked layout with the icon on top. */
export function FeatureHero({ app, kicker }: Props) {
  const { t } = useTranslation();
  const kickerLabel = kicker ?? t("featureHero.defaultKicker");
  let h = 0;
  for (let i = 0; i < app.name.length; i++) h = (h * 31 + app.name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;

  return (
    <Link
      href={`/apps/${app.package_name}`}
      className="surface relative block overflow-hidden p-6 md:p-10"
      style={
        {
          backgroundImage: `
            radial-gradient(120% 90% at 100% 0%, hsl(${hue} 70% 50% / 0.18), transparent 60%),
            radial-gradient(80% 70% at 0% 100%, hsl(${(hue + 60) % 360} 60% 50% / 0.10), transparent 60%)
          `,
        } as React.CSSProperties
      }
    >
      <div className="relative grid items-center gap-8 md:grid-cols-[auto_1fr] md:gap-10">
        <AppIcon
          iconPath={app.icon_path}
          name={app.name}
          size={144}
          shape="rounded"
          version={app.updated_at}
          className="shadow-e3"
        />
        <div className="min-w-0">
          <Badge variant="primary" className="uppercase tracking-wider">
            ★ {kickerLabel}
          </Badge>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-ink md:text-4xl">
            {app.name}
          </h2>
          <p className="mt-1 text-sm text-ink-mute md:text-base">
            {app.author_name || app.categories[0]?.name || t("featureHero.selfHostedRelease")}
          </p>
          {app.summary && (
            <p className="mt-3 max-w-2xl text-sm text-ink-soft md:text-base">
              {app.summary}
            </p>
          )}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button variant="filled" size="lg" className="pointer-events-none">
              {t("featureHero.open")}
            </Button>
            {app.suggested_version_name && (
              <Badge variant="soft" className="font-mono">
                v{app.suggested_version_name}
              </Badge>
            )}
            {app.visibility === "private" && (
              <Badge variant="accent">{t("appCard.private")}</Badge>
            )}
            {app.categories.slice(0, 1).map((c) => (
              <Badge key={c.id} variant="outline">{c.name}</Badge>
            ))}
          </div>
        </div>
      </div>
    </Link>
  );
}
