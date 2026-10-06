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
/* What the pages told us: "unknown" until a controlled page answers (the
 * browser stops idle workers, wiping this memory), then "user" or
 * "anonymous". The explicit anonymous state is what spares an anonymous
 * visitor a token round-trip (and its ~300 ms wait) on every image. */
let authState = "unknown";
/* Token changes — and the cache purge they may trigger — run one after
 * another on this chain; fetches wait for it, so none reads the media
 * cache halfway through an account switch. */
let authChange = Promise.resolve();
/* Shared ``need-token`` round-trip, so a burst of <img> fetches asks once. */
let solicitation = null;
/* Bumped on every token change: a response fetched under an older value
 * is not written to the cache (it may belong to the previous user). */
let cacheGeneration = 0;

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
 *   • A clear privacy boundary — the cache is only read while a token is
 *     set, and purged when that token is cleared (logout) or replaced by
 *     another user's, so user A's private-app thumbnails can't bleed into
 *     an anonymous visitor's or user B's session on a shared browser.
 *   • Freshness honouring whatever ``max-age`` the backend sent.
 *
 * Bump ``CACHE_VERSION`` whenever the cache shape changes so old
 * entries get evicted on next activation. */
const CACHE_VERSION = "v1";
const MEDIA_CACHE = "fdroid-media-" + CACHE_VERSION;
/* Entry in MEDIA_CACHE naming the user whose token filled it (the JWT
 * ``sub``). Unlike ``authToken`` it survives the worker being stopped,
 * so a logout or account switch still purges after a restart. */
const OWNER_KEY = "/__fdroid-media-owner__";

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

/** Ask every controlled window for the token. Used while ``authState``
 *  is still "unknown" (first fetches after activation or a worker
 *  restart, before any page pushed ``set-token`` / ``clear-token``) —
 *  without this, that first <img> burst races the registration handshake
 *  and lands as 404 against private apps. Concurrent callers share one
 *  round-trip. */
function _solicitTokenFromClients() {
  if (!solicitation) {
    solicitation = (async () => {
      try {
        const list = await self.clients.matchAll({ type: "window" });
        if (list.length === 0) return;
        for (const client of list) {
          client.postMessage({ type: "need-token" });
        }
        // Give the page a brief window to reply. We don't await a
        // specific reply — the message handler settles ``authState``
        // (to "user" or "anonymous") and we stop as soon as it does.
        for (let i = 0; i < 10 && authState === "unknown"; i++) {
          await new Promise((r) => setTimeout(r, 30));
        }
      } catch (_) {
        /* matchAll can throw on insecure contexts; harmless. */
      }
    })().finally(() => { solicitation = null; });
  }
  return solicitation;
}

/** ``sub`` claim of a JWT — who the token belongs to. Read without
 *  verification: it only decides whether the cache changes hands. */
function _tokenSubject(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(part + "===".slice((part.length + 3) % 4)));
    return claims && claims.sub != null ? String(claims.sub) : null;
  } catch (_) {
    return null;
  }
}

/** Owner recorded in the media cache: null when there is no cache, "" when
 *  one exists without an owner entry (written by an older worker, or
 *  re-created after an eviction) — i.e. owner unknown. */
async function _cacheOwner() {
  if (!(await caches.has(MEDIA_CACHE))) return null;
  const cache = await caches.open(MEDIA_CACHE);
  const hit = await cache.match(OWNER_KEY);
  return hit ? hit.text() : "";
}

/** Apply a ``set-token`` / ``clear-token`` from a page. The media cache
 *  is purged only when it changes hands: a token that was set is cleared
 *  (logout), or a token for another user replaces it. An anonymous
 *  visitor answering ``need-token`` with ``clear-token`` costs nothing. */
async function _applyToken(token) {
  if (token) {
    if (token === authToken && authState === "user") return;
    // Responses already in flight were fetched for the previous token:
    // they must not land in a cache that may be changing hands.
    cacheGeneration++;
    // An undecodable token gets an identity of its own, so it never
    // inherits a cache it can't be proven to own.
    const owner = _tokenSubject(token) || "?" + Date.now();
    try {
      const previous = await _cacheOwner();
      if (previous !== null && previous !== owner) {
        await caches.delete(MEDIA_CACHE);
      }
      if (previous !== owner) {
        const cache = await caches.open(MEDIA_CACHE);
        await cache.put(OWNER_KEY, new Response(owner));
      }
    } catch (_) {
      /* CacheStorage unavailable — then nothing is cached to protect */
    }
    authToken = token;
    authState = "user";
    return;
  }
  if (authState === "anonymous") return;
  cacheGeneration++;
  const wasUser = authState === "user";
  authToken = null;
  authState = "anonymous";
  try {
    // After a worker restart the memory says "unknown": the owner entry
    // tells whether a signed-in session filled the cache.
    if (wasUser || (await _cacheOwner()) !== null) {
      // Otherwise, on a shared browser (kiosk, multi-user laptop), user
      // A's private-app thumbnails would still sit in CacheStorage for
      // whoever logs in next — a thin but real cross-account leak.
      await caches.delete(MEDIA_CACHE);
    }
  } catch (_) {
    /* best effort */
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
  let token;
  if (data.type === "set-token") {
    token = typeof data.token === "string" && data.token ? data.token : null;
  } else if (data.type === "clear-token") {
    token = null;
  } else {
    return;
  }
  const change = authChange.then(() => _applyToken(token));
  // Never let one failed purge wedge every later fetch on the chain.
  authChange = change.catch(() => { /* best effort */ });
  if (event.waitUntil) event.waitUntil(authChange);
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
    // Don't know yet whether this browser is signed in (the page hasn't
    // pushed a token since the worker started) → ask any window client
    // and wait briefly. Once a page answered — token or explicit
    // ``clear-token`` — later fetches skip this entirely.
    await authChange;
    if (authState === "unknown") {
      await _solicitTokenFromClients();
      await authChange;
    }
    const token = authState === "user" ? authToken : null;
    if (!token) {
      // Anonymous (or no answer): plain fetch, no auth header, and the
      // media cache stays out of it — it holds what a token was allowed
      // to see. Public apps succeed, private ones get the 404 they would
      // have anyway; nothing here is cached, so that 404 can't poison
      // the slot for the same URL once we DO have a token.
      return fetch(event.request);
    }

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

    const generation = cacheGeneration;
    const response = await _fetchWithAuth(url, req, token);

    // Cache successful, cacheable responses. Clone before storing —
    // a Response body is one-shot, and the caller still needs it.
    // Failures (404 on a private asset before login, 5xx, …) are
    // never cached, nor is anything fetched before a token change.
    if (cacheable && response && response.ok) {
      const cache = await caches.open(MEDIA_CACHE).catch(() => null);
      if (cache && generation === cacheGeneration) {
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
