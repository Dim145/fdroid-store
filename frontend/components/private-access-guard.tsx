"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useAuth } from "@/lib/auth-store";
import { useRepoInfo } from "@/lib/repo-store";

/* When the admin flips the repo to private mode, the API endpoints
 * (/apps, /categories, …) start returning 401 for anonymous callers — the
 * SPA used to render the bare layout with empty data on top of that. This
 * guard collapses that case into a clean redirect to /login.
 *
 * Mounted on routes that were anonymous-friendly (home + /(client)/*). The
 * /login page itself is *not* wrapped, otherwise we'd loop. */
export function PrivateAccessGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const repo = useRepoInfo();

  // The redirect can only fire once both stores have settled. While they
  // resolve we render a small spinner instead of the page, otherwise a
  // private-mode visitor would briefly see the public layout before the
  // redirect kicked in.
  const settled = !authLoading && repo.loaded;
  const needsRedirect = settled && !user && !repo.publicMode;

  useEffect(() => {
    if (!needsRedirect) return;
    const here = encodeURIComponent(
      window.location.pathname + window.location.search,
    );
    router.replace(`/login?next=${here}`);
  }, [needsRedirect, router]);

  if (!settled || needsRedirect) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div
          className="h-7 w-7 animate-spin rounded-full border-2 border-outline-soft border-t-primary"
          role="status"
          aria-label="Loading"
        />
      </div>
    );
  }
  return <>{children}</>;
}
