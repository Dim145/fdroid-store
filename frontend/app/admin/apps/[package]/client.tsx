"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";

/* Client-side redirect that converts ``/admin/apps/<pkg>/`` → the
 * canonical ``/admin/apps/?app=<pkg>`` deeplink. The dynamic segment
 * is read from ``usePathname`` (rather than ``useParams``) because the
 * static export bakes the param to the ``__dynamic`` placeholder used
 * at build time — only the live URL carries the real package name. */
export default function AdminAppRedirect() {
  const router = useRouter();
  const pathname = usePathname();
  const pkg = useMemo(() => {
    const m = pathname?.match(/^\/admin\/apps\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }, [pathname]);

  useEffect(() => {
    if (!pkg) {
      router.replace("/admin/apps");
      return;
    }
    router.replace(`/admin/apps?app=${encodeURIComponent(pkg)}`);
  }, [pkg, router]);

  // Render nothing — the visit is over before the user can perceive it.
  return null;
}
