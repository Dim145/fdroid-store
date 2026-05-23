# APK Source Proxy Protocol — v1

> **Status**: stable. Implementers SHOULD use this version. Major-version
> bumps to v2 will be additive where possible; breaking changes will be
> signalled by `version` in `GET /sources`.

## Why this exists

`fdroid-store` natively speaks to GitHub / GitLab / Gitea release feeds.
Everything else — Patreon, kemono, Play Store, an internal S3 release
bucket, a flat directory of nightly builds on someone's NAS — lives
behind a **source proxy**: a small HTTP service the operator deploys (or
points at) which knows how to talk to those upstreams and exposes them
through a uniform JSON API.

`fdroid-store` itself stays neutral. It carries zero scraping code, zero
upstream-specific authentication, and no policy on what's an acceptable
source. The operator picks the proxies they want; each proxy's author
owns the ToS / legal / maintenance burden for their slice.

Anyone can write a proxy in any language. The protocol is small enough
to implement in an afternoon over an existing project (a few hundred
lines of FastAPI / Express / Echo).

## The shape

```
┌──────────────────┐   1. GET /sources               ┌─────────────────┐
│  fdroid-store    │ ─────────────────────────────▶ │  Source Proxy   │
│                  │   2. POST /resolve              │                 │
│  (worker fetches │ ─────────────────────────────▶ │  · Patreon      │
│   on a cron)     │                                 │  · kemono       │
│                  │   3. GET   <apk_url>            │  · F-Droid      │
│                  │ ─────────────────────────────▶ │  · …            │
└──────────────────┘                                 └─────────────────┘
                                                              │
                                                              ▼
                                                          Upstream
```

The proxy can host any number of providers under a single base URL. One
proxy per upstream-family is the typical deployment (one for forges,
one for Patreon, …) but nothing forces it.

## Transport

- **HTTP/1.1 or HTTP/2**, JSON bodies (`Content-Type: application/json`).
- The proxy MUST be reachable at a single **base URL** (e.g. `https://
  proxy.internal:8000`). All endpoints are relative to that.
- TLS is REQUIRED for production. Loopback / private-net deployments MAY
  use HTTP; the operator-side SSRF guard on `fdroid-store` still applies.
- Authentication from `fdroid-store` to the proxy is a **shared secret**
  carried in the `Authorization: Bearer <token>` header. The proxy MUST
  reject requests without it (or with the wrong token) using `401`. The
  shared secret is configured per-proxy in `fdroid-store`'s admin UI;
  proxies that don't need auth (loopback / private network) MAY accept
  any token, but MUST still parse the header so the API surface stays
  uniform.
- All requests carry `User-Agent: fdroid-store/<version>` and a
  `X-Request-Id` UUID the proxy SHOULD echo in errors for debugging.

## Endpoint summary

| Method | Path                                | Purpose                            |
|--------|-------------------------------------|------------------------------------|
| GET    | `/healthz`                          | Liveness probe                     |
| GET    | `/sources`                          | Capability catalogue               |
| POST   | `/resolve`                          | URL → APK metadata + download link |
| POST   | `/auth/{provider}/begin`            | Start an OAuth dance (optional)    |
| GET    | `/auth/{provider}/callback`         | OAuth callback (optional)          |
| GET    | `<apk_url>` (proxy-issued)          | Stream the APK bytes               |

The `/auth/*` endpoints are only required when at least one provider
declares `auth_kind: "oauth2"`. The `/healthz` endpoint is REQUIRED.

## 1 · `GET /healthz`

Liveness probe. No auth required (so admins can curl it without the
shared secret).

**Response 200**:
```json
{ "ok": true, "version": 1 }
```

Anything other than 200 means the proxy is considered down.

## 2 · `GET /sources`

Returns the proxy's capability catalogue. `fdroid-store` calls this
when an admin adds the proxy (and refreshes it periodically, e.g.
every 5 minutes) and uses the result to render the per-app wizard.

**Request**:
```http
GET /sources HTTP/1.1
Authorization: Bearer <shared_secret>
```

**Response 200**:
```json
{
  "version": 1,
  "name": "Reference F-Droid Proxy",
  "providers": [
    {
      "id": "fdroid",
      "name": "F-Droid-compatible repo",
      "description": "Any repo serving index-v1.jar / index-v2.json.",
      "icon_url": "https://proxy.example.com/static/fdroid.svg",
      "url_hint": "https://f-droid.org/repo",
      "url_pattern": "^https?://.+/repo/?$",
      "auth_kind": "none",
      "supports_search": false
    },
    {
      "id": "patreon",
      "name": "Patreon",
      "description": "APK attachments on paywalled posts.",
      "url_hint": "https://www.patreon.com/<creator>",
      "url_pattern": "^https?://(www\\.)?patreon\\.com/[^/]+/?$",
      "auth_kind": "oauth2",
      "auth_oauth": {
        "begin_path": "/auth/patreon/begin",
        "scopes_hint": ["campaigns.posts"]
      }
    },
    {
      "id": "kemono",
      "name": "kemono.cr",
      "url_hint": "https://kemono.cr/patreon/user/<id>",
      "auth_kind": "api_token",
      "secret_fields": [
        {
          "key": "session_cookie",
          "label": "kemono session cookie (optional, premium)",
          "secret": true,
          "required": false
        }
      ]
    }
  ]
}
```

### Field reference

- `version` (int, required) — protocol version. v1 only at this point.
  Backends that don't recognise the value SHOULD refuse to use the
  proxy.
- `name` (string, optional) — human-readable label for the proxy
  instance (shown in the admin UI). Defaults to the base URL.
- `providers[]` — list of provider descriptors. May be empty (proxy
  alive but no providers configured).

For each provider:

- `id` (string, required) — opaque identifier, stable across releases.
  Lowercase, `[a-z0-9_-]+`. `fdroid-store` stores this on the source row.
- `name` (string, required) — human label, can include spaces / dots.
- `description` (string, optional) — one-line description shown under
  the name.
- `icon_url` (string, optional) — square icon, ≤ 64 × 64 px. Served by
  the proxy or an upstream CDN.
- `url_hint` (string, optional) — placeholder shown in the URL input.
- `url_pattern` (regex, optional) — client-side validation hint. The
  backend doesn't rely on it (the proxy is the only authority on what
  it accepts), but the frontend uses it to red-line invalid input early.
- `auth_kind` (enum, required) — one of:
  - `"none"` — no per-source credentials.
  - `"api_token"` — one or more declared fields rendered as a form
    (see `secret_fields`).
  - `"basic"` — alias for `api_token` with two fields (`username`,
    `password`). The backend renders them as a paired form.
  - `"oauth2"` — full OAuth dance handled by the proxy. See `/auth/*`.
- `secret_fields[]` (array, required when `auth_kind ∈ {api_token, basic}`)
  — what the frontend renders. Each field:
  - `key` (string) — what the backend sends in `secrets` on `/resolve`.
  - `label` (string) — human label.
  - `secret` (bool) — if true, the input is `type=password` and the
    value is masked in the audit log.
  - `required` (bool, default `true`).
  - `placeholder` (string, optional).
- `auth_oauth` (object, required when `auth_kind: "oauth2"`):
  - `begin_path` (string) — relative URL to start the dance.
  - `scopes_hint[]` (array of strings, optional) — informational, shown
    in the UI before the user is redirected.
- `supports_search` (bool, optional) — if true, `POST /resolve` MAY
  accept a `query` field instead of a `url`. Not yet wired in the
  backend; reserved for v2.

## 3 · `POST /resolve`

The workhorse. Given a source URL the user pasted, return either the
latest APK (with a download link), `304` (nothing newer than what the
caller already saw), or an error.

**Request**:
```http
POST /resolve HTTP/1.1
Authorization: Bearer <shared_secret>
Content-Type: application/json
X-Request-Id: 8e0b…

{
  "provider": "patreon",
  "url": "https://www.patreon.com/creator-x",
  "last_release_id": "post-12345",
  "secrets": {
    "credential_id": "uuid-1234-…"
  }
}
```

- `provider` (string, required) — the `id` from `/sources`.
- `url` (string, required) — the source URL. The proxy MAY reject it
  (`400 bad_url`).
- `last_release_id` (string, optional) — the proxy-supplied id from the
  previous successful resolve. If the proxy decides nothing has changed,
  it returns `304`. Pass `null` (or omit) for first-time scans.
- `secrets` (object, optional) — per-source credentials. For OAuth
  providers the only key is typically `credential_id` (the opaque id
  returned by `/auth/*/callback`). For `api_token` / `basic`, the keys
  match the `secret_fields[].key` declarations.

**Response 200** — a newer release is available:
```json
{
  "release_id": "post-67890",
  "package_name": "com.example.app",
  "version_name": "1.2.3",
  "version_code": 10203,
  "published_at": "2026-05-23T12:00:00Z",
  "apk_url": "https://proxy.example.com/dl/abc123",
  "apk_size_bytes": 12345678,
  "apk_sha256_hint": "fde43c8…",
  "apk_headers": { "Authorization": "Bearer …" },
  "expires_at": "2026-05-23T12:05:00Z"
}
```

- `release_id` (string, required) — opaque to `fdroid-store`. Stored as
  `last_release_id` for the next poll. Stable per logical release.
- `package_name` (string, required) — Android `package` from the APK
  manifest. The backend uses it to enforce the cross-app signer pin and
  match against the App row.
- `version_name`, `version_code` (string + int, required) — what the
  upstream advertises. Authoritative APK metadata is re-parsed
  server-side from the downloaded bytes, so a lying proxy can only
  cause an upload to be rejected, not corrupt a row.
- `published_at` (ISO-8601, optional) — for ordering and display.
- `apk_url` (string, required) — where the backend fetches the bytes.
  - MAY be on the proxy's own domain (`https://proxy.example.com/dl/…`).
    The proxy streams the APK back, hiding upstream credentials.
  - MAY be an external URL (a signed Patreon S3 URL, an upstream CDN).
    The backend hits it directly. **The backend ALWAYS runs SSRF
    defences on this URL** — RFC 1918 / loopback / metadata IPs are
    refused regardless of who supplied them.
- `apk_size_bytes` (int, optional) — pre-flight check against the
  admin-configured upload cap. If supplied and over the cap, the
  backend skips the download entirely.
- `apk_sha256_hint` (hex, optional) — if supplied, the backend
  verifies the downloaded bytes against it before proceeding. Catches
  proxy↔upstream tampering and on-disk corruption.
- `apk_headers` (object, optional) — extra request headers the backend
  attaches when fetching `apk_url`. Useful for `Authorization` on
  upstream signed URLs that the proxy doesn't want to mint at resolve
  time.
- `expires_at` (ISO-8601, optional) — when `apk_url` stops being valid.
  If the backend can't download before this, it re-issues `/resolve`.

**Response 304** — no newer release:
```http
HTTP/1.1 304 Not Modified
```
Empty body. The backend stamps `last_scan_at` and moves on.

**Response 401** — `secrets` are invalid (token expired, OAuth scope
revoked):
```json
{ "error": "auth_failed", "message": "Patreon access token expired" }
```
The backend marks the source `last_status: error` with a clear message,
stops polling until the user re-authenticates.

**Response 404** — no APK found at this URL (creator deleted the post,
no `*.apk` attachment, etc.):
```json
{ "error": "no_apk", "message": "Creator's latest post has no APK attachment" }
```

**Response 429** — upstream rate-limited the proxy:
```json
{ "error": "rate_limited", "retry_after": 3600 }
```
The backend respects `retry_after` (seconds) before the next attempt.

**Response 400 / 502 / 500** — bad input, upstream failure, proxy
internal error. Body shape is the same `{error, message}`.

## 4 · `POST /auth/{provider}/begin`

Called by the **user's browser** (not by `fdroid-store`'s backend) at
the start of an OAuth dance. The backend issues a popup-window
navigation to:

```
<proxy_base>/auth/{provider}/begin?
    return_to=<fdroid_callback_url>&
    state=<random_token>
```

- `return_to` — fully-qualified URL on `fdroid-store` where the popup
  will be redirected once the proxy is done.
- `state` — opaque random token. Echoed back on the return so the
  backend can match the response to the initiating request.

The proxy:
1. Validates `return_to` against an admin-configured allow-list. (The
   list is configured on the proxy side at deploy time — e.g.
   `https://fdroid.example.com`.)
2. Saves `(state, return_to)` to a short-lived cache (session, Redis…).
3. Redirects the browser to the upstream IdP's authorize URL with its
   own callback URL.

## 5 · `GET /auth/{provider}/callback`

The IdP's redirect lands here.

The proxy:
1. Reads the `state` query parameter, looks up the cached `return_to`.
2. Exchanges the `code` for an access + refresh token.
3. Stores them internally, keyed by a fresh `credential_id` (UUID).
4. Redirects the browser to:
   ```
   <return_to>?credential_id=<uuid>&state=<original_state>
   ```

`fdroid-store` then stores `credential_id` in `ApkProxySource.
secrets_encrypted.credential_id` and uses it on every `/resolve`.

The proxy is responsible for refreshing the OAuth token when it
expires. `fdroid-store` only ever sees the `credential_id`.

## 6 · `GET <apk_url>` — downloading the APK

The `apk_url` from `/resolve` is opaque to the backend. Whether it
lives on the proxy or upstream is entirely up to the proxy author. The
backend:

1. Validates the URL through the standard SSRF guard (no loopback,
   no metadata IPs, HTTPS only outside loopback, no redirects to
   blocked ranges).
2. Issues a `GET` with the headers from `apk_headers` (if any) plus a
   standard `User-Agent`.
3. Streams the response body to a `tempfile.NamedTemporaryFile`,
   refusing anything over the admin-set upload cap.
4. If `apk_sha256_hint` was set, recomputes SHA-256 and rejects on
   mismatch (`fdroid-store` logs an audit event and marks the source
   `error`).
5. Re-parses the manifest server-side with androguard. The proxy-supplied
   `package_name` / `version_code` are advisory; the values stored on
   the `Apk` row come from the actual parsed manifest.
6. Runs the regular ingest pipeline: ClamAV scan (if enabled),
   cross-app signer pin check, retention eviction, reindex queue.

## Error model

Every JSON error response uses:
```json
{ "error": "<code>", "message": "<human-readable>" }
```

Codes the backend recognises:

| Code            | HTTP | Behaviour                                          |
|-----------------|------|----------------------------------------------------|
| `bad_request`   | 400  | Source row marked `error`, won't retry until edit  |
| `auth_failed`   | 401  | Source row marked `auth_required`, no auto-retry   |
| `not_found`     | 404  | Source row marked `error: no APK at URL`, no auto-retry |
| `no_apk`        | 404  | Same as `not_found` but distinguishes "URL OK, no .apk"  |
| `rate_limited`  | 429  | Honours `retry_after`, retries after the delay     |
| `upstream`      | 502  | Transient error, exponential backoff up to 1 day   |
| `internal`      | 500  | Same as `upstream` — proxy bug                     |

## Security considerations

### `fdroid-store` treats the proxy as untrusted

The proxy can lie about anything:
- The `apk_url` it returns is run through the SSRF guard. A proxy can't
  exfiltrate from the backend's network by handing back `http://169.254.
  169.254/…`.
- The `package_name` / `version_code` are advisory. The authoritative
  values come from re-parsing the downloaded bytes.
- The cross-app signer pin (`PackageSignerPin`) is enforced after the
  parse. A proxy can't push an APK signed by a different cert than the
  package's first publisher.
- The admin-set upload cap is enforced during streaming. A proxy can't
  exhaust disk by claiming `apk_size_bytes: 1024` then streaming a 50 GB
  body.

### The proxy treats `fdroid-store` as untrusted too

- The shared secret in `Authorization: Bearer` is the only auth. The
  proxy SHOULD log + rate-limit auth failures.
- The `secrets` blob in `/resolve` carries credentials the user
  supplied. The proxy SHOULD redact them from logs.
- The proxy MUST NOT echo the secret back in any response (the backend
  re-encrypts and stores it as bytes, never displaying it in the UI).

### OAuth state

`state` round-trips through both `fdroid-store` and the proxy. The
backend MUST refuse a callback whose `state` doesn't match the one it
generated. The proxy SHOULD validate `return_to` against its own
configured allow-list — otherwise a malicious actor could trick the
proxy into redirecting elsewhere with a real OAuth credential.

### Signing key reuse

The downloaded APK is verified the same way as any other upload — the
APK's signing certificate must match the first-published cert for that
package (`PackageSignerPin`). A proxy can't push a fork of `com.example.
app` signed by a different developer; the cross-app pin survives App
deletion and the signer fingerprint is permanent per Android package
name.

## Versioning

This spec is **v1**. Future revisions will:

- Add fields **only as additive optional** within v1.
- Introduce v2 only for breaking changes, signalled by `GET /sources` →
  `version: 2`. The backend will refuse proxies with `version > <max
  supported>`.
- Keep the `version` field as the negotiation point. Don't probe.

## Reference implementation

`fdroid-store` ships an **F-Droid source proxy** in `proxy/` as a
reference, enabled by the `proxy-fdroid` compose profile. It implements
the spec end-to-end against any F-Droid-compatible repo (the official
F-Droid one, IzzyOnDroid, the Guardian Project, the user's own
`fdroid-store` instance, etc.). Read it as the canonical example of a
v1 implementation.

```bash
docker compose --profile proxy-fdroid up -d
# proxy now reachable at http://fdroid-proxy:8000 from the worker network
```

The proxy code (~ 400 lines) lives at `proxy/fdroid/` and is MIT-licensed
just like the rest of the project.
