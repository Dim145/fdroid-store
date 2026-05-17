"use client";

import { LayoutDashboard, AppWindow, Users, Settings2, Wand2, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { AuthGuard } from "@/components/auth-guard";
import { SiteHeader } from "@/components/site-header";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard },
  { href: "/admin/apps", label: "Apps & APKs", icon: AppWindow },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/access", label: "Access", icon: ShieldCheck },
  { href: "/admin/repo", label: "Repo config", icon: Settings2 },
  { href: "/admin/setup", label: "Setup wizard", icon: Wand2 },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
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
                Admin
              </div>
              {NAV.map((item) => {
                const Icon = item.icon;
                const active = pathname === item.href;
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
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </aside>
          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </div>
    </AuthGuard>
  );
}
