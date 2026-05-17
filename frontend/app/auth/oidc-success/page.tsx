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
    if (!access || !refresh) {
      setError("Missing tokens in callback");
      return;
    }
    acceptOidcTokens(access, refresh).then(
      () => router.replace("/apps"),
      (err: unknown) =>
        setError(err instanceof Error ? err.message : "Sign-in failed"),
    );
  }, [acceptOidcTokens, router]);

  return (
    <main className="container flex min-h-screen items-center justify-center">
      <p className="text-muted-foreground">{error ?? "Finishing sign-in…"}</p>
    </main>
  );
}
