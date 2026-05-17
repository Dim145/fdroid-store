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
  const { user, loading } = useAuth();

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
      <div className="flex h-40 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (requireAdmin && user.role !== "admin") return null;
  return <>{children}</>;
}

function Spinner() {
  return (
    <div
      className="h-6 w-6 animate-spin rounded-full border-2 border-outline-soft border-t-primary"
      role="status"
      aria-label="Loading"
    />
  );
}
