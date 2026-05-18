"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useAuth } from "@/lib/auth-store";

export default function OidcSuccessPage() {
  const router = useRouter();
  const { acceptOidcTokens } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    const access = params.get("access_token");
    const refresh = params.get("refresh_token");
    // Strip the fragment immediately so the tokens don't linger in browser
    // history, the address bar, copy-paste of the URL, or any extension /
    // analytics script that reads ``window.location`` after we mount.
    window.history.replaceState(null, "", window.location.pathname);
    if (!access || !refresh) { setError("Missing tokens in callback"); return; }
    acceptOidcTokens(access, refresh).then(
      () => router.replace("/apps"),
      (err: unknown) => setError(err instanceof Error ? err.message : "Sign-in failed"),
    );
  }, [acceptOidcTokens, router]);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="surface flex flex-col items-center gap-3 p-8 text-center">
        {error ? (
          <p className="text-danger">{error}</p>
        ) : (
          <>
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-outline-soft border-t-primary" role="status" />
            <p className="text-sm text-ink-soft">Finishing sign-in…</p>
          </>
        )}
      </div>
    </main>
  );
}
