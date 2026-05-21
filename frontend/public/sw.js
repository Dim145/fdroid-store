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

/* Explicit ``CacheStorage`` bucket for media. The previous
 * ``fetch(url, {cache: "default"})`` relied on Chrome's HTTP cache to
 * keep icons / screenshots across page navigations, but Chrome treats
 * an ``Authorization``-bearing request conservatively and never reuses
 * the response on a follow-up — every <img> on /my-apps/[id] after a
 * round-trip via /apps/[package] was a cold network hit.
 *
 * Owning the cache here gives us:
 *   • Real reuse across navigations (the SW serves the bytes directly,
 *     no HTTP round-trip).
 *   • A clear privacy boundary — purge on ``clear-token`` (logout) so
 *     user A's private-app thumbnails can't bleed into user B's
 *     session on a shared browser.
 *   • Freshness honouring whatever ``max-age`` the backend sent.
 *
 * Bump ``CACHE_VERSION`` whenever the cache shape changes so old
 * entries get evicted on next activation. */
const CACHE_VERSION = "v1";
const MEDIA_CACHE = "fdroid-media-" + CACHE_VERSION;

/* Index files MUST revalidate per request (the backend sets
 * ``no-cache, must-revalidate`` on them), so we never cache them.
 * APKs are huge and downloaded once per install, so caching them in
 * a long-lived bucket would burn user disk for no win — let the
 * browser's HTTP cache handle those if it wants. */
function _isCacheable(pathname) {
  const name = pathname.split("/").pop().toLowerCase();
  if (name === "index-v1.jar" || name === "index-v2.json" || name === "entry.jar") return false;
  if (name.endsWith(".apk")) return false;
  return true;
}

/* Is a cached response still within its ``max-age``? Cache-Control on
 * media reads ``private, max-age=86400`` — 24 h. After that, we
 * refetch. Falls back to "fresh" when the response lacks the headers
 * we'd need to decide — better an extra hour of cache than a refetch
 * storm on a missing-header edge case. */
function _isFresh(cached) {
  if (!cached) return false;
  const dateStr = cached.headers.get("date");
  if (!dateStr) return true;
  const cc = cached.headers.get("cache-control") || "";
  const m = cc.match(/max-age=(\d+)/);
  if (!m) return true;
  const ageSec = (Date.now() - new Date(dateStr).getTime()) / 1000;
  return ageSec < parseInt(m[1], 10);
}

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
    // Purge the media cache on logout. Otherwise, on a shared browser
    // (kiosk, multi-user laptop), user A's private-app thumbnails
    // would still be served from CacheStorage to whoever logs in next
    // for the same URL — a thin but real cross-account leak.
    caches.delete(MEDIA_CACHE).catch(() => { /* best effort */ });
  }
});

/* Network fetch with Authorization header. The original ``<img>``
 * fetch is ``mode: 'no-cors'``, which disallows setting arbitrary
 * headers — that's why we construct a new Request explicitly.
 *
 * ``redirect: "error"`` so a 3xx response from /fdroid/repo/* fails
 * loudly here rather than silently following the redirect. Per Fetch
 * spec the browser strips Authorization on cross-origin redirects,
 * BUT a same-host → other-same-host redirect retains it; explicit
 * "error" closes that leak hole entirely. */
function _fetchWithAuth(url, req, token) {
  return fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: "Bearer " + token,
      // Preserve Accept so the browser still gets the format it asked for.
      ...(req.headers.get("accept") ? { Accept: req.headers.get("accept") } : {}),
    },
    mode: "same-origin",
    credentials: "omit",
    cache: "default",
    redirect: "error",
  });
}

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

  // Cache lookup key — the URL only, not the Request. The original
  // request is ``mode: no-cors`` with no Authorization, our network
  // fetch has Bearer; using just the URL string makes both shapes
  // share the same cache slot.
  const cacheKey = url.toString();
  const cacheable = _isCacheable(url.pathname);

  event.respondWith((async () => {
    // Cache-first when we can. The cache lives across pages and
    // across SW restarts, so a navigation that revisits an app's
    // screenshots after seeing them on /apps/[package] hits memory
    // (or disk) instead of the network.
    if (cacheable) {
      const cache = await caches.open(MEDIA_CACHE).catch(() => null);
      if (cache) {
        const hit = await cache.match(cacheKey);
        if (hit && _isFresh(hit)) return hit;
      }
    }

    // No token to add → either the page hasn't pushed one yet (first
    // paint after a hard reload, SW just activated) or the user
    // really is anonymous. Solicit one from any window client and
    // wait briefly; if nothing arrives, let the browser fetch
    // normally (public apps succeed, private ones get the 404 they
    // would have anyway).
    let token = authToken;
    if (!token) {
      await _solicitTokenFromClients();
      token = authToken;
    }
    if (!token) {
      // Anonymous bypass — no auth header. Don't cache this either,
      // because the 404 we'd get on a private asset shouldn't poison
      // the cache for the same URL once we DO have a token.
      return fetch(event.request);
    }

    const response = await _fetchWithAuth(url, req, token);

    // Cache successful, cacheable responses. Clone before storing —
    // a Response body is one-shot, and the caller still needs it.
    // Failures (404 on a private asset before login, 5xx, …) are
    // never cached.
    if (cacheable && response && response.ok) {
      const cache = await caches.open(MEDIA_CACHE).catch(() => null);
      if (cache) {
        // ``cache.put`` is async but we don't need to await it before
        // returning the response to the caller — the body is already
        // cloned and the page can start decoding the image while the
        // cache write completes in the background.
        cache.put(cacheKey, response.clone()).catch(() => { /* quota etc — best effort */ });
      }
    }
    return response;
  })());
});
