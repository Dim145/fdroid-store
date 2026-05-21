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

/** Ask every controlled window for a fresh token. Used on the first
 *  fetch after activation when the page hasn't yet pushed via
 *  ``set-token`` — without this, that first <img> burst races the
 *  registration handshake and lands as 404 against private apps. */
async function _solicitTokenFromClients() {
  try {
    const list = await self.clients.matchAll({ type: "window" });
    for (const client of list) {
      client.postMessage({ type: "need-token" });
    }
    // Give the page a brief window to reply with ``set-token``. We
    // don't await a specific reply — the message handler updates
    // ``authToken`` and any near-simultaneous fetch will pick it up.
    for (let i = 0; i < 10 && !authToken; i++) {
      await new Promise((r) => setTimeout(r, 30));
    }
  } catch (_) {
    /* matchAll can throw on insecure contexts; harmless. */
  }
}

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
  // Defense-in-depth: only accept messages from same-origin Window
  // clients. A same-origin XSS would still defeat this (the attacker
  // can grab the JWT from localStorage directly), but cross-origin or
  // SharedWorker-style senders are refused.
  if (event.source && event.source.url) {
    try {
      if (new URL(event.source.url).origin !== self.location.origin) return;
    } catch (_) {
      return;
    }
  }
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
  // No token to add → either the page hasn't pushed one yet (first
  // paint after a hard reload, SW just activated) or the user really
  // is anonymous. Solicit one from any window client and wait briefly;
  // if nothing arrives, let the browser fetch normally (public apps
  // succeed, private ones get the 404 they would have anyway).
  if (!authToken) {
    event.respondWith((async () => {
      await _solicitTokenFromClients();
      if (!authToken) return fetch(event.request);
      return fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: "Bearer " + authToken,
          ...(req.headers.get("accept") ? { Accept: req.headers.get("accept") } : {}),
        },
        mode: "same-origin",
        credentials: "omit",
        cache: "default",
        redirect: "error",
      });
    })());
    return;
  }

  // Build a fresh same-origin Request with Authorization. The original
  // <img> fetch is mode='no-cors', which disallows setting arbitrary
  // headers — that's why we construct a new Request explicitly.
  //
  // ``redirect: "error"`` so a 3xx response from /fdroid/repo/* fails
  // loudly here rather than silently following the redirect. If the
  // backend ever started returning 302s (e.g. an S3-CDN passthrough
  // we'd otherwise want to keep behind us), a cross-origin hop with
  // the Bearer header would leak the JWT to the redirect target.
  // Per Fetch spec the browser strips Authorization on cross-origin
  // redirects, BUT a same-host → other-same-host redirect retains
  // it; explicit "error" closes that hole entirely.
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
      redirect: "error",
    }),
  );
});
