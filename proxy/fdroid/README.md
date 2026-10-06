# Reference F-Droid source proxy

A ~350-line FastAPI service that implements the
[APK source proxy v1 protocol](../../docs/proxy-protocol.md) over any
F-Droid-compatible repository (the official `f-droid.org`, IzzyOnDroid,
the Guardian Project, another `fdroid-store` instance, …).

This is the reference implementation that ships with `fdroid-store` as
an opt-in compose profile. It exists for two reasons:

1. **You can use it as-is**: drop a "F-Droid mirror" source on any of
   your apps to track a release published on another F-Droid repo.
2. **It's the canonical example**: anyone writing a proxy for Patreon,
   the Play Store, an internal artefact registry, … can copy the shape
   and patterns from here (~350 lines, one file).

## URL format the user pastes

Pasted into the per-app wizard on `fdroid-store`:

```
<repo_index_url>#<package_name>
```

Two equivalent forms are accepted (the fragment is preferred because
it never leaks into the index-fetch request):

| Form                                                | Notes                              |
|-----------------------------------------------------|------------------------------------|
| `https://f-droid.org/repo#org.fdroid.fdroid`        | Recommended                        |
| `https://f-droid.org/repo?package=org.fdroid.fdroid`| Fallback when fragments are eaten  |

The `<repo_index_url>` is whatever the upstream serves the
`/index-v1.jar` at — `https://f-droid.org/repo`, `https://apt.izzysoft.
de/fdroid/repo`, `https://guardianproject.info/fdroid/repo`, etc.

## How it works

Per `POST /resolve`:

1. Parse the URL into `(repo_url, package_name)`.
2. Fetch `<repo_url>/index-v1.jar` (capped at 32 MB, 120 s overall),
   connecting only to public addresses (see *Limits + caveats*).
3. Open it as a ZIP, read `index-v1.json` out of it (capped at 256 MB
   decompressed).
4. Find `packages[<package_name>]`, pick the entry with the highest
   `versionCode`.
5. Return `release_id = "<package>@<versionCode>"`, `package_name`,
   `version_name`, `version_code`, `apk_url = <repo>/<apkName>`,
   plus the SHA-256 hint and the file size from the index.

We deliberately do NOT verify the JAR signature — the F-Droid client
already does that on the device, and the calling `fdroid-store` re-
parses the APK manifest server-side and enforces its own cross-app
signer pin. The proxy's job is just to point at the right bytes.

The proxy is **stateless**: every `/resolve` re-fetches the index.
F-Droid indexes are small (~12 MB for the official one, <1 MB for most
third-party repos) so this is cheap, and statelessness means there's
no cache invalidation bug to chase when a new release is published.

## Running it

### Via the fdroid-store compose stack (recommended)

The stock `docker-compose.yml` ships this proxy under the `proxy-fdroid`
profile:

```bash
# .env
PROXY_FDROID_SECRET=<shared secret matching what you'll set in fdroid-store>

# bring it up alongside the regular stack
docker compose --profile proxy-fdroid up -d
```

Then in `fdroid-store`'s admin UI, go to **/admin/proxies →
Add proxy**:

- **Name**: `F-Droid mirror` (or whatever you want to call it)
- **Base URL**: `http://proxy-fdroid:8000` (compose service name)
- **Shared secret**: same value as `PROXY_FDROID_SECRET`

The admin UI will immediately probe `/healthz` + cache `/sources`. The
per-app wizard on `/my-apps/[id]` then has an `fdroid` provider
available.

### Standalone

```bash
docker run --rm -p 8000:8000 \
    -e PROXY_SHARED_SECRET=$(openssl rand -hex 32) \
    ghcr.io/dim145/fdroid-store-proxy-fdroid:latest
```

Or from source (same pinned versions as the image; `requirements.in`
lists the direct deps and how to regenerate the lock):

```bash
pip install -r requirements.txt
PROXY_SHARED_SECRET=$(openssl rand -hex 32) \
    uvicorn main:app --host 0.0.0.0 --port 8000
```

## Configuration

| Env var                         | Default | Notes |
|---------------------------------|---------|-------|
| `PROXY_SHARED_SECRET`           | empty   | Bearer token the calling fdroid-store sends. Empty = open mode (still parses the header) and a WARNING at startup. In the compose stack, set `PROXY_FDROID_SECRET` in `.env` instead. |
| `PROXY_MAX_INDEX_JSON_MB`       | `256`   | Cap on the decompressed `index-v1.json` (zip-bomb guard). |
| `PROXY_FETCH_DEADLINE_SECONDS`  | `120`   | Wall-clock budget for one index download, redirects included. |
| `PROXY_MAX_CONCURRENT_FETCHES`  | `2`     | Index fetch + parse running at once (each can take a few hundred MB for a big repo); further `/resolve` calls wait. |

The compose service also gets `mem_limit` / `pids_limit`
(`PROXY_FDROID_MEM_LIMIT`, default `2g`; `PROXY_FDROID_PIDS_LIMIT`,
default `128`).

## Limits + caveats

- **Index size caps**: 32 MB for the downloaded jar, 256 MB for the
  `index-v1.json` inside it. Larger indexes are refused with a
  `502 too_large` error. The official F-Droid jar is ~12 MB; the caps
  exist for hostile / misconfigured upstreams.
- **Public upstreams only**: the repo host (and every redirect hop) must
  resolve to public unicast addresses only — private, loopback,
  link-local / cloud-metadata, CGNAT, ULA, … are refused, including when
  disguised as IPv4-mapped, 6to4 or NAT64 IPv6 addresses. The connection
  goes to the exact address that was checked (no second DNS lookup, so
  DNS rebinding can't swap it), with the hostname kept for `Host` and TLS.
- **No fragment-only URLs**: a `<repo>` without `#<package>` or
  `?package=<package>` is rejected with `400 bad_request`. The
  package_name must be expressed in the URL because the protocol's
  `/resolve` body has no separate field for it.
- **No multi-package per source**: one source row in `fdroid-store`
  imports one package. To track 10 apps from f-droid.org, register
  10 separate sources. (This matches the cardinality of `GithubSource`
  too — one app per source row.)
- **The "added" timestamp is best-effort**: F-Droid indexes ship
  `added` as epoch milliseconds. Some third-party repos omit it, in
  which case `published_at` is `null`.
