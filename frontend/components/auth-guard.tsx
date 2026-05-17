"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useAuth } from "@/lib/auth-store";

type Props = {
  children: React.ReactNode;
  requireAdmin?: boolean;
};

export function AuthGuard({ children, requireAdmin = false }: Props) {
  const router = useRouter();
  const { user, loading, fetchMe } = useAuth();

  useEffect(() => {
    if (user === null && !loading) {
      // Either we have never loaded, or we lost the session. Try to (re)hydrate.
      fetchMe();
    }
  }, [user, loading, fetchMe]);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      const here = encodeURIComponent(window.location.pathname);
      router.replace(`/login?next=${here}`);
      return;
    }
    if (requireAdmin && user.role !== "admin") {
      router.replace("/apps");
    }
  }, [user, loading, requireAdmin, router]);

  if (loading || !user) {
    return (
      <div className="flex h-32 items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (requireAdmin && user.role !== "admin") {
    return null;
  }
  return <>{children}</>;
}
