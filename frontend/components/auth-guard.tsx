"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/lib/auth-store";

type Props = {
  children: React.ReactNode;
  /** Page is admin-only — anyone else gets bounced to /apps. */
  requireAdmin?: boolean;
  /** Page needs upload privileges (``uploader`` or ``admin``).
   *  Plain ``user`` accounts get bounced to /apps. Used by /my-apps
   *  and everything under it (edit, new). */
  requireUploader?: boolean;
};

function canAccess(
  role: string,
  requireAdmin: boolean,
  requireUploader: boolean,
): boolean {
  if (requireAdmin) return role === "admin";
  if (requireUploader) return role === "admin" || role === "uploader";
  return true;
}

export function AuthGuard({
  children,
  requireAdmin = false,
  requireUploader = false,
}: Props) {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      const here = encodeURIComponent(window.location.pathname);
      router.replace(`/login?next=${here}`);
      return;
    }
    if (!canAccess(user.role, requireAdmin, requireUploader)) {
      router.replace("/apps");
    }
  }, [user, loading, requireAdmin, requireUploader, router]);

  if (loading || !user) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!canAccess(user.role, requireAdmin, requireUploader)) return null;
  return <>{children}</>;
}

function Spinner() {
  const { t } = useTranslation();
  return (
    <div
      className="h-6 w-6 animate-spin rounded-full border-2 border-outline-soft border-t-primary"
      role="status"
      aria-label={t("common.loading")}
    />
  );
}
