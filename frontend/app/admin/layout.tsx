"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { AuthGuard } from "@/components/auth-guard";
import { SiteHeader } from "@/components/site-header";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/apps", label: "Apps & APKs" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/repo", label: "Repo config" },
  { href: "/admin/setup", label: "Setup wizard" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <AuthGuard requireAdmin>
      <div className="flex min-h-screen flex-col">
        <SiteHeader />
        <div className="container flex flex-1 gap-8 py-8">
          <aside className="w-48 shrink-0 space-y-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "block rounded-md px-3 py-2 text-sm transition-colors",
                  pathname === item.href
                    ? "bg-secondary font-medium"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                )}
              >
                {item.label}
              </Link>
            ))}
          </aside>
          <main className="flex-1">{children}</main>
        </div>
      </div>
    </AuthGuard>
  );
}
