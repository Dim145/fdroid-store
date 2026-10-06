"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "@/lib/api";
import { takeOidcHandoff, useAuth } from "@/lib/auth-store";
import { safeNext } from "@/lib/utils";

export default function OidcSuccessPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const { acceptOidcTokens } = useAuth();
  const [failed, setFailed] = useState(false);
  // The code is single-use: a second run of the effect (StrictMode mounts
  // twice in dev) must not try to redeem it again.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("code");
    // Strip the fragment immediately so the code doesn't linger in browser
    // history, the address bar, copy-paste of the URL, or any extension /
    // analytics script that reads ``window.location`` after we mount.
    window.history.replaceState(null, "", window.location.pathname);
    // The callback only hands out a one-time code; it is worth tokens only
    // together with the nonce this tab stashed before leaving for the
    // identity provider. No nonce means the flow didn't start here (a
    // crafted link, another tab): nothing to redeem.
    const { nonce, next } = takeOidcHandoff();
    if (!code || !nonce) {
      setFailed(true);
      return;
    }
    api.oidcExchange(code, nonce)
      .then((tokens) => acceptOidcTokens(tokens.access_token, tokens.refresh_token))
      .then(
        () => router.replace(safeNext(next)),
        () => setFailed(true),
      );
  }, [acceptOidcTokens, router]);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="surface flex flex-col items-center gap-3 p-8 text-center">
        {failed ? (
          <>
            <p className="text-danger">{t("auth.login.oidcErrors.generic")}</p>
            <Link href="/login" className="text-sm font-medium text-primary hover:underline">
              {t("auth.oidcSuccess.backToLogin")}
            </Link>
          </>
        ) : (
          <>
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-outline-soft border-t-primary" role="status" />
            <p className="text-sm text-ink-soft">{t("auth.oidcSuccess.finishing")}</p>
          </>
        )}
      </div>
    </main>
  );
}
