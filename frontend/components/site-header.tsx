"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-store";

export function SiteHeader() {
  const router = useRouter();
  const { user, logout } = useAuth();
  return (
    <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur">
      <div className="container flex h-14 items-center justify-between">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground">F</span>
          fdroid-store
        </Link>
        <nav className="flex items-center gap-3 text-sm">
          <Link href="/apps" className="text-muted-foreground hover:text-foreground">
            Apps
          </Link>
          {user && (
            <>
              <Link href="/my-apps" className="text-muted-foreground hover:text-foreground">
                My apps
              </Link>
              <Link href="/history" className="text-muted-foreground hover:text-foreground">
                History
              </Link>
              <Link href="/account" className="text-muted-foreground hover:text-foreground">
                Account
              </Link>
              {user.role === "admin" && (
                <Link href="/admin" className="text-muted-foreground hover:text-foreground">
                  Admin
                </Link>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  logout();
                  router.replace("/");
                }}
              >
                Sign out
              </Button>
            </>
          )}
          {!user && (
            <Button asChild size="sm">
              <Link href="/login">Sign in</Link>
            </Button>
          )}
        </nav>
      </div>
    </header>
  );
}
