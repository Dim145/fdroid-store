"use client";

import { Activity, AppWindow, Archive, ClipboardList, LayoutDashboard, Plug, Settings2, ShieldCheck, ShieldHalf, Tags, Users, Wand2 } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslation } from "react-i18next";

import { AuthGuard } from "@/components/auth-guard";
import { SiteHeader } from "@/components/site-header";
import { Toaster } from "@/components/toaster";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/admin", labelKey: "admin.nav.overview", icon: LayoutDashboard },
  { href: "/admin/apps", labelKey: "admin.nav.appsApks", icon: AppWindow },
  { href: "/admin/categories", labelKey: "admin.nav.categories", icon: Tags },
  { href: "/admin/users", labelKey: "admin.nav.users", icon: Users },
  { href: "/admin/access", labelKey: "admin.nav.access", icon: ShieldCheck },
  { href: "/admin/repo", labelKey: "admin.nav.repoConfig", icon: Settings2 },
  { href: "/admin/audit", labelKey: "admin.nav.audit", icon: ClipboardList },
  { href: "/admin/jobs", labelKey: "admin.nav.jobs", icon: Activity },
  { href: "/admin/scanning", labelKey: "admin.nav.scanning", icon: ShieldHalf },
  { href: "/admin/proxies", labelKey: "admin.nav.proxies", icon: Plug },
  { href: "/admin/backup", labelKey: "admin.nav.backup", icon: Archive },
  { href: "/admin/setup", labelKey: "admin.nav.setupWizard", icon: Wand2 },
] as const;

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const pathname = usePathname();
  return (
    <AuthGuard requireAdmin>
      <div className="flex min-h-screen flex-col">
        <SiteHeader />
        <div className="container flex flex-1 gap-8 py-6 md:py-10">
          <aside className="hidden w-60 shrink-0 md:block">
            <div className="sticky top-20 space-y-1">
              <div className="eyebrow mb-3 flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                {t("admin.eyebrow")}
              </div>
              {NAV.map((item) => {
                const Icon = item.icon;
                // ``trailingSlash: true`` means the live ``pathname`` is
                // ``/admin/``, but the nav config uses ``/admin`` — strip the
                // trailing slash (except for the root) before comparing so
                // the Overview tab actually lights up when the user is on it.
                const here = (pathname || "/").replace(/\/+$/, "") || "/";
                const target = item.href.replace(/\/+$/, "") || "/";
                // The Overview tab matches the exact ``/admin`` path only —
                // every sub-page (``/admin/apps``, ``/admin/jobs``…) starts
                // with ``/admin``, so a ``startsWith`` rule would keep the
                // Overview row highlighted forever.
                const active =
                  target === "/admin"
                    ? here === "/admin"
                    : here === target || here.startsWith(`${target}/`);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-3 rounded-pill px-4 py-2.5 text-sm font-medium transition-colors",
                      active
                        ? "bg-primary-container text-primary-on-container"
                        : "text-ink-soft hover:bg-surface-2 hover:text-ink",
                    )}
                  >
                    <Icon className="h-4 w-4" strokeWidth={2.2} />
                    {t(item.labelKey)}
                  </Link>
                );
              })}
            </div>
          </aside>
          <main className="min-w-0 flex-1">{children}</main>
        </div>
        <Toaster />
      </div>
    </AuthGuard>
  );
}
