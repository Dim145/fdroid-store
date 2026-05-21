/* fdroid-store — media auth Service Worker.
 *
 * Why this exists: the SPA renders private-app icons / screenshots /
 * banners with <img src> tags, which carry NO Authorization header.
 * The backend's media routes refuse anonymous reads of private-app
 * assets (the URLs would otherwise be a package-name oracle, CWE-203),
 * so the owner's own browser was getting 404 on every private-app
 * thumbnail.
 *
 * This worker intercepts same-origin fetches under /fdroid/repo/* and
 * /r/*, replaces the request with one that carries
 *   Authorization: Bearer <jwt>
 * and lets the browser cache the response by its original URL. Result:
 * fully stable URLs (Cache-Control respected) AND authenticated reads
 * for private content.
 *
 * Token is held in memory only and refreshed via postMessage from any
 * controlled tab — see ``lib/media-sw.ts`` on the page side.
 */

let authToken = null;

self.addEventListener("install", () => {
  // Activate the new worker immediately on update; without skipWaiting
  // a freshly-deployed SW would idle until every existing tab closed.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Take control of existing tabs as soon as we activate so the first
  // page load after registration doesn't have to wait for a reload.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "set-token") {
    authToken = typeof data.token === "string" ? data.token : null;
  } else if (data.type === "clear-token") {
    authToken = null;
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }
  // Only same-origin F-Droid repo paths. Everything else (API, SPA
  // assets, third-party requests) goes through unchanged.
  if (url.origin !== self.location.origin) return;
  if (
    !url.pathname.startsWith("/fdroid/repo/")
    && !url.pathname.startsWith("/r/")
  ) return;
  // No token to add → let the browser fetch normally. Public apps
  // still succeed; private ones get the 404 they would have anyway.
  if (!authToken) return;

  // Build a fresh same-origin Request with Authorization. The original
  // <img> fetch is mode='no-cors', which disallows setting arbitrary
  // headers — that's why we construct a new Request explicitly.
  event.respondWith(
    fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: "Bearer " + authToken,
        // Preserve Accept so the browser still gets the format it asked for.
        ...(req.headers.get("accept") ? { Accept: req.headers.get("accept") } : {}),
      },
      mode: "same-origin",
      credentials: "omit",
      cache: "default",
      redirect: "follow",
    }),
  );
});
