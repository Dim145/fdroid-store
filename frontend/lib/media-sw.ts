"use client";

/* Page-side glue for the media Service Worker.
 *
 * Registers ``/sw.js`` once, then pushes the current JWT to it whenever
 * the auth store mints / rotates / clears one. The worker replays
 * <img> requests with the token on the Authorization header, leaving
 * the URL fully cacheable. See ``public/sw.js`` for the worker itself.
 */

import { getAccessToken } from "@/lib/api";

let registered = false;

/** Idempotent. Safe to call from multiple places — only the first call
 *  actually registers; subsequent calls are no-ops. */
export function registerMediaSW(): void {
  if (typeof window === "undefined") return;
  if (registered) return;
  if (!("serviceWorker" in navigator)) return;
  registered = true;

  // Kill-switch escape hatch — append ``?nosw=1`` to any URL to
  // unregister the worker. Useful when a buggy ``sw.js`` ships and
  // bricks every controlled tab without a manual DevTools intervention.
  try {
    if (new URLSearchParams(window.location.search).get("nosw") === "1") {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((r) => r.unregister());
      });
      return;
    }
  } catch (_) { /* malformed query — fall through and register normally */ }

  navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then(() => navigator.serviceWorker.ready)
    .then(() => pushTokenToSW())
    .catch((err) => {
      // SW registration failing is non-fatal — private app images
      // simply won't render. Keep the failure visible in the console
      // so it's diagnosable without breaking the page.
      // eslint-disable-next-line no-console
      console.warn("media SW registration failed:", err);
    });

  // The SW asks for the token when it intercepts a fetch before the
  // page has had a chance to push one (first paint after a hard reload).
  // Answer the request so the in-flight fetch can be authenticated.
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data && event.data.type === "need-token") {
      pushTokenToSW();
    }
  });

  // Re-push on controller change — when a fresh SW activates (e.g.
  // first install, hot update), ``controller`` flips and the previous
  // in-memory token is gone. Without this, the new SW would have to
  // rely on its own ``need-token`` solicitation for several seconds.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    pushTokenToSW();
  });
}

/** Send the current JWT to the SW. Called on first registration, after
 *  login / signup / refresh / OIDC, and on logout (with null). */
export function pushTokenToSW(): void {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  const controller = navigator.serviceWorker.controller;
  if (!controller) return;
  const token = getAccessToken();
  controller.postMessage({
    type: token ? "set-token" : "clear-token",
    token: token || null,
  });
}
