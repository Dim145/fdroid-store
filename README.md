# fdroid-store

A self-hosted [F-Droid](https://f-droid.org) repository with a modern admin
panel and a client area for users. Designed to be a simpler, opinionated
alternative to [Repomaker](https://gitlab.com/fdroid/repomaker).

- 🟢 **Compatible with the F-Droid client** — speaks the standard
  `index-v1.jar` + `index-v2.json` protocol (both built side-by-side).
- 🟢 **Two-zone frontend** — a *client area* (account, history, API keys,
  TOTP, manage your own apps) and an *admin area* (moderate, configure
  repo, jobs, audit log, scans, stats).
- 🟢 **Filesystem _or_ S3 storage** — switchable via a single env var.
- 🟢 **Local auth, OIDC, _and_ TOTP MFA** — Keycloak / Authentik / Google /
  GitLab / whichever OpenID Connect provider you prefer; optional
  second-factor TOTP per account.
- 🟢 **Hybrid access** — apps can be `public` (in the regular repo URL) or
  `private` (only available to users who pass an API key as HTTP Basic
  auth, which the F-Droid Android client supports out of the box).
- 🟢 **CI publishing** — per-app deploy tokens (`fdci_…`) for CI runners
  to push new APKs without handing over a full account credential.
- 🟢 **Multi-forge auto-ingest** — attach a **GitHub, GitLab, or
  Gitea/Forgejo** (self-hosted) repository to an app and the worker
  fetches new release APKs automatically. Per-source PAT stored
  encrypted at rest (Fernet).
- 🟢 **Retention cap** — repo-wide default + admin per-app override
  (tighten-only). FIFO eviction by `versionCode`, never touches the
  suggested version.
- 🟢 **Setup wizard** — generate or import your repo signing keystore
  from the UI on first run.
- 🟢 **Optional ClamAV** — opt-in compose profile streams every upload
  through clamd; manual + scheduled rescans.
- 🟢 **i18n** — English + French ship in-tree.

## Stack

| Layer | Tech |
|---|---|
| Backend | Python 3.13 · FastAPI · SQLAlchemy 2 (async) · Alembic · PostgreSQL 16 · Redis 7 · arq |
| Auth / crypto | pwdlib (argon2 + legacy bcrypt) · PyJWT · Authlib (OIDC) · pyotp (TOTP) · Fernet (PAT at rest) |
| F-Droid tooling | androguard (manifest parsing) · apksigner (cert SHA-256) · jarsigner / keytool (repo signing) |
| Frontend | Next.js 16 (App Router, static export) · React 19 · TypeScript · Tailwind 4 · Radix UI · Zustand · i18next |
| Storage | Local FS or any S3-compatible object store (MinIO, Wasabi, Backblaze, …) |
| Hardening | slowapi rate limits · nginx-emitted CSP/HSTS · SSRF guards on forge fetches · read-only containers |
| Deploy | Docker Compose (single-host) — easily portable to k8s |

## Quick start

```bash
git clone <this-repo> fdroid-store
cd fdroid-store
cp .env.example .env
# Edit .env — at minimum set SECRET_KEY and INITIAL_ADMIN_PASSWORD

# Pulls prebuilt images from ghcr.io/dim145/*
docker compose up -d

# To enable on-upload ClamAV scanning, opt in via the profile:
docker compose --profile clamav up -d
```

Once everything is up:

| Component | URL | Notes |
|---|---|---|
| Frontend (admin + client UI) | http://localhost:3000 | static SPA served by nginx |
| Backend API (Swagger in dev) | http://localhost:8000/api/docs | disabled when `ENVIRONMENT=production` |
| F-Droid repo (point F-Droid client here) | http://localhost:8080/fdroid/repo | public variant by default |

Sign in with the initial admin credentials from `.env`, then:

1. **`/admin/setup`** — Run the setup wizard. Pick *Generate* to create a
   fresh keystore, or *Import* to upload an existing `.p12` / `.jks`.
2. **`/admin/apps`** — Create / publish apps and upload APKs (or attach
   a GitHub / GitLab / Gitea source for auto-ingest).
3. **`/admin/repo`** — Trigger the first reindex.
4. Add the F-Droid URL above to the F-Droid app on your phone.

## Configuration cheatsheet

All settings live in `.env` (see `.env.example` for the full annotated list).
The most important ones:

```bash
# --- secrets -----------------------------------------------------------------
SECRET_KEY=<run: python -c 'import secrets;print(secrets.token_urlsafe(64))'>
INITIAL_ADMIN_EMAIL=you@example.com
INITIAL_ADMIN_PASSWORD=change-me-now

# --- public URLs (the F-Droid client + browser hit these) --------------------
PUBLIC_REPO_URL=https://apks.your-domain.tld/fdroid/repo
PUBLIC_APP_URL=https://apks.your-domain.tld
PUBLIC_API_URL=https://apks.your-domain.tld

# --- storage backend ---------------------------------------------------------
STORAGE_BACKEND=local        # or "s3"
LOCAL_STORAGE_PATH=/data/storage
# S3 / MinIO / etc.
S3_ENDPOINT_URL=https://s3.eu-west-3.amazonaws.com
S3_BUCKET=my-fdroid-bucket
S3_ACCESS_KEY=AKIA…
S3_SECRET_KEY=…

# --- auth --------------------------------------------------------------------
AUTH_METHODS=local,oidc       # or just "local" / just "oidc"
ALLOW_SIGNUP=true
OIDC_ISSUER=https://auth.example.com/realms/myrealm
OIDC_CLIENT_ID=fdroid-store
OIDC_CLIENT_SECRET=…
OIDC_ADMIN_CLAIM=groups=fdroid-admins   # optional: auto-promote on group match
# Reject callbacks whose ``email_verified`` claim is False or missing.
# Default true (anti-takeover). Set to false ONLY for IdPs that don't
# emit the claim (Defguard, some Keycloak realms).
OIDC_REQUIRE_EMAIL_VERIFIED=true

# --- optional: ClamAV (only used when the ``clamav`` profile is up) ----------
CLAMAV_HOST=clamav
CLAMAV_PORT=3310
CLAMAV_MAX_STREAM_MB=100

# --- optional: Trivy CVE/SBOM (only used when the ``trivy`` profile is up) ---
# Empty / unset → CVE/SBOM feature disabled, worker short-circuits to SKIPPED.
TRIVY_SERVER_URL=http://trivy:4954

# --- backup worker scratch dir ----------------------------------------------
# Bind a persistent volume here (the stock compose mounts ``backup_tmp``).
# The default ``/tmp`` tmpfs is 512 MB and too small for real-sized repos.
BACKUP_TMP_DIR=/data/backup-tmp

# --- optional: forge tokens (per-source PATs override these in the UI) -------
GITHUB_TOKEN=ghp_…
GITLAB_TOKEN=glpat-…
GITEA_TOKEN=…
```

## How the F-Droid index works here

The worker maintains **two** index variants under the storage prefix `repo/`:

- `repo/public/` — only **PUBLIC + PUBLISHED** apps.
- `repo/private/` — same as public **plus** PRIVATE apps.

The `/fdroid/repo/` HTTP endpoint serves whichever variant matches the
caller's credentials:

| Caller | Auth header sent | Index served |
|---|---|---|
| Anonymous F-Droid client | none | public |
| Logged-in F-Droid client (Basic auth, password = API key) | `Authorization: Basic <base64>` | private |

The Android F-Droid app supports the `https://anyuser:<api_key>@host/...`
URL form — that is the supported way to access private apps.

**Downloads always stream through the backend**, regardless of storage
backend. The earlier "302 to S3" shortcut bypassed audit, access checks
and rate limits, and broke against S3 backends that refuse anonymous
reads (Garage, private MinIO). `S3_PUBLIC_BASE_URL` is kept in the
schema for backward compatibility but no longer affects the download
path. Browser caches get sensible `Cache-Control` headers:
`no-cache` for index files, `max-age=1d` for icons/screenshots,
`immutable` for APKs (versionCode is in the filename).

## Auth modes

| Mode | Credential | Use case |
|---|---|---|
| Local password | argon2 (legacy bcrypt rows still verify) | normal browser sessions |
| OIDC | external IdP via Authlib | SSO with Keycloak, Google, etc. |
| TOTP | RFC 6238 (`pyotp`), QR enrolment under `/account` | optional second factor for local logins |
| WebAuthn / passkey | FIDO2 credential bound to the relying-party `PUBLIC_APP_URL` | passwordless sign-in, or MFA on top of a password. Per-role force toggles on `/admin/access`. |
| Personal API key | `fdr_<prefix>_<secret>` | F-Droid Basic-auth on private repo, CI scripts you own |
| Per-app deploy token | `fdci_<prefix>_<secret>` | CI runners that only need APK upload on a single app |
| Signed download URL | itsdangerous-signed, time-bounded | sharing a single private APK without an account |

Refresh tokens rotate on use (`jti` persisted) and can be revoked from
**Account → Sessions**.

## Publishing from CI

Each app has a **CI Publication** panel under
`/my-apps/{id}` that lets the owner (or co-maintainer) mint a deploy
token. The reveal modal hands you ready-to-paste snippets for `curl`,
GitHub Actions, and GitLab CI; an always-available *How to publish*
button shows the API spec (URL, method, auth header, body) with a
`<YOUR_TOKEN>` placeholder for cold reference.

```bash
curl -X POST "$REPO_URL/api/v1/apks/upload/$APP_ID" \
  -H "Authorization: Bearer $FDROID_DEPLOY_TOKEN" \
  -F "file=@build/outputs/apk/release/app-release.apk"
```

Same endpoint accepts a personal API key — the deploy token just
narrows the blast radius if it leaks.

## Auto-ingest from a forge

Attach a release source to an app under
`/my-apps/{id}` → **GitHub / GitLab / Gitea source**:

- Provider: GitHub, GitLab, Gitea/Forgejo (self-hosted `base_url`
  supported).
- Asset pattern: glob applied to the release asset name
  (e.g. `*-universal.apk`).
- Per-source PAT: optional, stored Fernet-encrypted (key derived from
  `SECRET_KEY`). The env-wide tokens above are the fallback.

The worker polls each enabled source on a cron, fetches new releases
respecting the pattern, runs the same pipeline as a manual upload
(inspect → store → optional ClamAV scan → eviction → reindex), and
audits every state transition.

SSRF guards: hostnames resolve through a blocked-CIDR allow-list,
redirects are walked manually with the same checks, userinfo is
stripped from `base_url`, and `..`/`.` segments are rejected.

## Project structure

```
fdroid-store/
├── backend/          # FastAPI app + worker (arq) + Alembic
│   ├── app/
│   │   ├── api/v1/   # auth, me, totp, api_keys, deploy_tokens,
│   │   │             # apps, apks, media, github_sources, collaborators,
│   │   │             # categories, users, feeds, admin, setup, health
│   │   ├── core/     # config, db, security, logging
│   │   ├── fdroid/   # APK parser, keystore, index v1/v2, signing
│   │   ├── models/   # SQLAlchemy ORM
│   │   ├── schemas/  # Pydantic IO models
│   │   ├── services/ # auth, oidc, totp, bootstrap, github_releases,
│   │   │             # apk_eviction, clamav, crypto, audit, …
│   │   ├── storage/  # FS / S3 abstraction
│   │   └── workers/  # arq tasks: rebuild_index, scan_apks_periodic,
│   │                 # scan_github_sources_periodic, fetch_github_source
│   ├── alembic/      # migrations
│   ├── Dockerfile
│   └── pyproject.toml
├── frontend/         # Next.js 16, static-exported, nginx-served
│   ├── app/
│   │   ├── (client)/ # /apps, /account, /history, /my-apps, /u/[username]
│   │   ├── admin/    # /admin/{apps,users,repo,jobs,audit,scans,
│   │   │             #         categories,setup,access}
│   │   ├── login/, signup/, auth/oidc-success/
│   ├── components/
│   ├── lib/
│   ├── locales/      # en.json, fr.json
│   └── nginx.conf.template   # serves SPA + reverse-proxies /api + /fdroid
├── docker-compose.yml
└── .env.example
```

## API summary

REST API at `http://<backend>/api/v1/`. Swagger docs at `/api/docs`
when `ENVIRONMENT=development`. Selected endpoints:

```
# auth (rate-limited)
POST  /api/v1/auth/login                # local login (5/min)
POST  /api/v1/auth/login/mfa            # follow-up if TOTP enrolled
POST  /api/v1/auth/signup               # (5/min, invite-code aware)
POST  /api/v1/auth/refresh              # rotates refresh jti
POST  /api/v1/auth/logout
GET   /api/v1/auth/methods              # tells the UI what flows are on
GET   /api/v1/auth/oidc/login           # → IdP redirect (when OIDC enabled)

# me
GET   /api/v1/me                        # who am I
POST  /api/v1/me/change-password
GET   /api/v1/me/downloads              # my download history
GET   /api/v1/me/apps                   # apps I own
GET   /api/v1/me/sessions / DELETE      # active refresh-token sessions
GET   /api/v1/me/quotas
GET   /api/v1/me/api-keys / POST / DELETE
GET   /api/v1/me/totp/status
POST  /api/v1/me/totp/{setup,confirm,disable}
POST  /api/v1/me/export                 # GDPR JSON dump of everything tied to me
GET   /api/v1/me/webauthn-credentials   # passkey list
DELETE /api/v1/me/webauthn-credentials/{id}

# webauthn (passkeys)
POST  /api/v1/webauthn/register/{start,finish}
POST  /api/v1/webauthn/login/{start,finish}

# apps + apks
GET   /api/v1/apps                      # browse public + my private
POST  /api/v1/apps                      # create app (mine)
POST  /api/v1/apps/with-apk             # create + first APK in one shot
POST  /api/v1/apps/with-github-source   # create from a forge URL
POST  /api/v1/apps/import-metadata      # paste fdroiddata YAML
GET   /api/v1/apps/{id|package_name}
GET   /api/v1/apps/{id}/metadata.yml    # F-Droid binary-only YAML export
POST  /api/v1/apks/upload/{app_id}      # bearer JWT, API key, or deploy token
POST  /api/v1/apks/{id}/download-url    # signed URL for private APK
POST  /api/v1/apks/{id}/reproducibility            # set status / hash / notes
POST  /api/v1/apks/{id}/reproducibility/verify-from-url  # fetch + auto-decide
GET   /api/v1/apks/{id}/sbom            # CVE / SBOM detail (private)
POST  /api/v1/apks/{id}/sbom/rescan

# per-app config
GET/POST/DELETE  /api/v1/apps/{id}/deploy-tokens
GET/PUT/DELETE   /api/v1/apps/{id}/github-source
POST             /api/v1/apps/{id}/github-source/scan
GET/POST/DELETE  /api/v1/apps/{id}/collaborators
POST/DELETE      /api/v1/apps/{id}/{icon,feature-graphic,promo-graphic,tv-banner,screenshots}

# feeds
GET   /api/v1/feed/new                  # Atom / RSS — every new app
GET   /api/v1/feed/updates              # Atom / RSS — every new APK version
GET   /api/v1/feed/apps/{package_name}  # Atom / RSS — per-app release feed

# stats (visibility: public / admin per ``public_stats`` toggle)
GET   /api/v1/stats

# setup
GET   /api/v1/setup/status              # has setup been done?
POST  /api/v1/setup/wizard              # generate/import keystore

# admin only
GET/POST/PATCH/DELETE /api/v1/admin/users
GET/PATCH             /api/v1/admin/apps
POST                  /api/v1/admin/apks/{id}/publish (or /reject)
GET/PATCH             /api/v1/admin/repo               # ClamAV + Trivy + RB toggles live here
POST                  /api/v1/admin/repo/reindex
GET                   /api/v1/admin/jobs              # arq run history
GET                   /api/v1/admin/audit             # audit log
GET                   /api/v1/admin/scans             # ClamAV results (UI: /admin/scanning)
POST                  /api/v1/admin/apks/rescan
GET                   /api/v1/admin/stats
GET                   /api/v1/admin/clamav/ping

# admin · encrypted backup + restore
POST  /api/v1/admin/backup/jobs                       # start a job (components + passphrase)
GET   /api/v1/admin/backup/jobs                       # history
GET   /api/v1/admin/backup/jobs/{id}/download         # encrypted .tar.enc
POST  /api/v1/admin/backup/restore                    # multipart: archive + passphrase
```

## Development

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload

# Worker
python -m arq app.workers.tasks.WorkerSettings

# Frontend
cd frontend
npm install
npm run dev
```

The backend will create the schema automatically on first boot. For
production, prefer `alembic revision --autogenerate -m "init"` followed by
`alembic upgrade head`.

## Migrating from Repomaker

`fdroid-store` is *not* a drop-in replacement: it does not run the F-Droid
build pipeline (it hosts pre-built APKs). If you need source-to-APK builds,
keep using `fdroidserver` to produce APKs and import them here via
`/api/v1/apks/upload/{app_id}` from CI — or attach a GitHub / GitLab /
Gitea release source if your builds already publish APK assets to a
forge release.

The paste-metadata endpoint (`POST /api/v1/apps/import-metadata`) takes
an upstream `fdroiddata`-style YAML blob so you can seed an app's
fields (name, description, links, categories) without re-typing.

## Security notes

- **Repo signing keystore** lives in a Docker volume; treat it like a
  TLS key.
- **Passwords** are argon2-hashed via pwdlib. Legacy bcrypt rows still
  verify (with a UTF-8-safe 72-byte truncation for the original passlib
  behaviour); new hashes use argon2.
- **API keys / deploy tokens** carry a short public prefix; only the
  prefix is stored alongside `sha256(secret)`. The plaintext secret is
  256 bits from `secrets.token_urlsafe(32)` and is shown exactly once
  on creation.
- **Refresh tokens** carry a `jti` mapped to a persisted row, are
  marked consumed on use (rotation), and are revocable from the
  sessions UI.
- **Per-source forge PATs** are encrypted at rest with Fernet (key
  derived from `SECRET_KEY` via SHA-256). They are never returned by
  the API; the read schema only reports a `has_access_token` boolean.
- **Encrypted backup archives** use AES-256-CBC + HMAC-SHA256 with a
  key derived from an operator-supplied passphrase (PBKDF2 over a
  per-archive random salt). The passphrase is never persisted; lose
  it and the archive is unrecoverable.
- **WebAuthn / passkeys** are bound to the `PUBLIC_APP_URL`
  relying-party ID. Only the credential's public key is stored; the
  authenticator never leaks anything secret over the wire. Per-role
  force toggles (`/admin/access`) gate sign-in on enrolment.
- **CVE / SBOM data** is private — owner / collaborator / admin only.
  The Trivy server is reached over the compose network and never
  exposed publicly (no auth on its API).
- **Reproducibility verification fetches** go through the same SSRF
  guard as the forge-release fetcher: DNS allow-list, RFC 1918 +
  metadata-IP rejection, redirects refused, HTTPS only.
- **Audit log** records actor + target + summary on every privileged
  action (upload, publish, reject, token mint/revoke, source upsert,
  admin role changes). Plaintext credentials are never logged — only
  prefixes / state transitions.
- **SSRF defenses** on forge fetches: DNS-resolved IP allow-list,
  blocked metadata services, scheme allow-list, manual redirect
  walking, userinfo stripping, `..`/`.` segment rejection.
- **Rate limits** (slowapi): login/signup/MFA `5/min`, refresh
  `10/min`, OIDC `20/min`, app list `10/min`, source upsert `10/min`,
  scan-now `20/min`, APK inspect `10/min`.
- **CSP, HSTS, X-Frame-Options, X-Content-Type-Options** are emitted by
  the frontend nginx layer; HSTS is opt-in via `ENABLE_HSTS=1`.
- **Containers** run `read_only` with `no-new-privileges` and all caps
  dropped. The first-run bootstrap is guarded by a Postgres advisory
  lock so concurrent boots can't double-create the admin.
- **OIDC** state lives in a SESSION cookie signed by `SECRET_KEY`;
  rotate the key if compromised (this invalidates all JWTs too).

## Changelog

Notable changes between 1.0.0 and 1.4.3 — pure bug fixes are omitted,
this is the operator-relevant summary.

### 1.4.3

- **Vulnerable transitive deps bumped** (npm `overrides`), clearing 8
  Dependabot alerts in the frontend lockfile: `dompurify` 3.4.5 → 3.4.11
  (7 advisories — mostly IN_PLACE-mode bypasses we don't use; the
  markdown-view XSS neutralisation was re-verified on 3.4.11) and
  `markdown-it` 14.1.1 → 14.2.0 (smartquotes quadratic-complexity DoS,
  CVE-2026-48988). Also pulled `undici` 7.25.0 → 7.28.0 (high; via jsdom,
  unreachable since DOMPurify makes no network calls) and `@babel/core`
  → 7.29.7 (low, build-time). `npm audit` now reports zero.

### 1.4.2

- **Index signing finds `jarsigner` robustly** — `rebuild_index` invoked
  `jarsigner` by bare name, so a worker whose `PATH` didn't include the
  JDK bin dir (custom entrypoint / `environment:` override, or an image
  missing the JDK entirely) failed mid-rebuild with an opaque
  `FileNotFoundError: 'jarsigner'`. It's now resolved explicitly via
  `JAVA_HOME/bin` → `PATH` → the worker image's bundled JRE, with a clear
  error that names the cause (the task must run in the *worker* image,
  which bundles the JDK; the API image doesn't). Reminder: index signing
  only works in the worker image — never run `rebuild_index` from the API
  image.

### 1.4.1

- **CodeQL `py/unsafe-deserialization` cleared** — the 1.4.0 billion-laughs
  hardening parsed metadata.yml via `yaml.load()` with a `SafeLoader`
  *subclass*, which CodeQL flags as unsafe deserialisation (it doesn't
  recognise the subclass as safe). Reworked to plain `yaml.safe_load`
  with a separate `yaml.scan` token pass that rejects YAML aliases — same
  DoS protection (bomb rejected in <1 ms), no flagged sink.

### 1.4.0

Security + hardening release — no new features, but a broad audit-driven
sweep across both ends and the dependency tree.

- **Stored-XSS fix on the public app page** — Markdown descriptions are
  rendered through `marked` + DOMPurify, but the anchor `target`/`rel`
  hardening used to run as a regex over DOMPurify's *output*. DOMPurify
  legitimately emits a literal `>` inside a quoted `href`, so the regex
  split the tag and re-injected a trailing `<img onerror=…>` as live
  markup — a crafted description ran JS in every visitor's session. The
  rewrite is now a DOMPurify `afterSanitizeAttributes` hook, so
  sanitisation is always the last word.
- **SSRF hardening, end to end** — a DNS-rebinding-safe HTTP transport
  resolves each outbound host once, refuses any blocked address, and
  pins the connection to the validated IP (forge polling + APK-proxy
  fetches). Forge calls also re-validate at fetch time and no longer
  follow redirects. The metadata-IP blocklist now recognises IPv4-mapped
  IPv6 and decimal/hex/octal spellings, and the private-range check
  covers CGNAT (100.64/10).
- **At-rest secret keys** derived with HKDF-SHA256 (domain-separated from
  the JWT signing key) instead of a bare `SHA-256(secret_key)`; existing
  encrypted tokens keep decrypting via a legacy fallback (no
  re-encryption needed).
- **Rate-limit + auth hardening** — the API port now binds to loopback so
  `X-Forwarded-For` can't be forged past the frontend to evade per-IP
  limits; MFA (TOTP confirm, passkey/enrol begin+finish) endpoints are
  rate-limited; the metadata.yml importer refuses YAML aliases (closes a
  ~250 B → 54 M node "billion laughs" DoS); screenshot uploads validate
  the `locale` path segment and cap the batch; proxy-supplied download
  headers are allowlisted.
- **F-Droid index timestamp fix** — `entry.json` and `index-v2.json`
  now share a single, strictly-monotonic timestamp per rebuild, and the
  index files publish atomically (temp + rename). This fixes the
  intermittent "Repo timestamp expected X, but was Y" error in the
  F-Droid client.
- **Dependency refresh** — Tiptap v2 → v3 (editor), `marked` 14 → 18,
  `isomorphic-dompurify` 2 → 3, plus security-floor bumps on PyJWT
  (2.13), authlib, python-multipart, pwdlib and others; dev tooling on
  mypy 2 / pytest 9 / ruff 0.15. A mypy-2 audit fixed six latent bugs
  (incl. a reachable IPv4/IPv6 comparison `TypeError`).
- **Ops** — worker container healthcheck (arq heartbeat); worker image
  re-copies the app code so a parallel `docker compose build` can't ship
  it stale.

### 1.3.0

- **APK source proxy v1** — admins can register external "proxy"
  sidecars (`/admin/proxies`) that resolve release URLs on the
  backend's behalf for sources the platform doesn't speak natively
  (Patreon, GitHub-Releases assets behind auth, custom drops, …).
  The protocol is small and documented (`docs/proxy-protocol.md`):
  `GET /healthz`, `GET /sources`, `POST /resolve`, and a streaming
  `GET <apk_url>` download. The backend treats proxies as untrusted:
  every URL they hand back is run through the SSRF guard (RFC1918 +
  loopback + link-local + cloud-metadata blocklist, with IPv4 weird-
  form normalisation) before any byte leaves the worker. A reference
  F-Droid proxy ships under `proxy/fdroid/` for self-hosters to
  fork. The per-app wizard (`/my-apps/new`) and the per-source
  picker on `/my-apps/[id]` pick proxy-backed sources up
  transparently and surface OAuth popups when a source needs them.
- **F-Droid-compatible Markdown editor + rendering** — `apps.description`
  and per-locale overrides are now edited in a Tiptap WYSIWYG bound
  to a Markdown string, restricted to the F-Droid v1/v2 subset
  (bold / italic / inline code / bullet + ordered lists / block
  quotes / links — headings, images, tables and inline HTML are
  stripped on paste). Public pages render the same Markdown through
  `marked` + DOMPurify with a deny-everything-then-allowlist sanitize
  config, so what the owner sees in the editor is exactly what every
  F-Droid client will display.
- **CodeQL security hardening** — fixed two GitHub code-scanning
  alerts: a reflective-XSS sink on the OAuth proxy callback (now
  emits the payload as an `html.escape`d `data-payload` attribute
  parsed at runtime, with a strict opaque-ID regex on the popup
  message), and a stack-trace exposure on `/apks` fetch errors
  (replaced free-form exception messages with a static lookup keyed
  by exception code so internal traces never leak to the client).
- **Audit-driven hardening pass** — single sweep covering the
  surfaces the proxy work touched. Proxy `base_url` validator
  refuses userinfo and normalises IPv4 weird forms (decimal,
  hex, trailing dot) via `ipaddress.ip_address(int(_, 0))` so the
  cloud-metadata blocklist can't be bypassed with `2852039166` or
  `0xa9fea9fe`. Reference proxy walks redirects with
  `client.send(stream=True)` (single-RTT happy path), checks the
  shared bearer with `hmac.compare_digest`, resolves DNS through
  `loop.getaddrinfo` so the event loop isn't blocked, and validates
  caller-supplied SHA-256 hints with a fullmatch regex. Frontend
  popup `setInterval`s are now tracked in refs and cleaned up on
  unmount / before re-trigger to stop leaks across the
  `/my-apps/new` and proxy-section flows.

### 1.2.0

- **Per-APK Reproducible Builds verification** — every APK row now
  carries a four-state RB flag (`unknown` / `not_attempted` /
  `verified` / `failed`) plus an optional reference SHA-256, the URL
  it was sourced from, and free-form notes. Two write paths: a
  declarative `POST /apks/{id}/reproducibility` and an automatic
  `verify-from-url` that fetches a published hash (typically the
  F-Droid verification server) through the same SSRF guard the
  release fetcher uses and auto-decides verified/failed by hash
  comparison. Surfaces as a discrete badge on `/apps/[package]` and
  a per-APK editor on `/my-apps/[id]`. Admin-toggleable from
  `/admin/scanning` — when off, endpoints 403 and the badge/editor
  are hidden but historical data is preserved.
- **CVE / SBOM scanning via Trivy** — optional `aquasec/trivy`
  container (compose profile `trivy`) provides CycloneDX SBOM
  extraction + vulnerability lookup for every published APK. The
  worker talks to the trivy server in CLIENT mode so the DB stays
  in one place. Results are private (owner / collaborator / admin
  only) — never on the public catalogue. Per-severity counts and
  the full CVE table show up in a side-sheet on the APK row. Admin
  toggle on `/admin/scanning` next to ClamAV.
- **WebAuthn / passkeys** — passwordless sign-in via FIDO2
  authenticators, with both account-level enrolment (under
  `/account/security`) and per-role force toggles
  (`/admin/access` → "require passkey for admins / uploaders").
  Forced enrolment is offered at first login after the toggle
  flips; existing sessions stay valid. Compatible with platform
  authenticators (Touch ID / Windows Hello) and roaming keys.
- **Encrypted backup + restore** — `/admin/backup` ships full-repo
  archives (DB dump + storage + keystore + assets) encrypted with a
  key derived from the operator's passphrase. Selective restore:
  pick any subset of the four components on the way in. Runs on
  the arq worker so an 80 GB repo doesn't pin the API. Job history
  lists every backup with size, components, status and a download
  button.
- **F-Droid `metadata.yml` export** — owners can grab a binary-only
  `<package>.yml` for their app from the `/my-apps/[id]` Hero. The
  file round-trips with the existing New-App YAML importer: every
  field the importer reads is also written here, with `Builds[]`
  emitted in F-Droid's "binary:" shape pointing at this repo's APK
  URLs so the file can drop into an `fdroiddata` fork unchanged.
- **`/stats` redesign** — single-page magazine spread. Variable
  serif display (Fraunces) on the hero downloads number, masthead
  strip + Roman-numeral chapter dividers, SVG area chart with
  motion path-draw + hover read-out, leaderboard with proportional
  bar fills animated on mount, and a subtle paper-grain background.
- **Section nav URL hash on `/my-apps/[id]`** — clicks AND natural
  scroll mirror the active section into `location.hash`, so a
  refresh (or a shared link) lands the user where they were.
  Settling-loop re-aligns after image-heavy sections finish
  decoding their thumbnails.
- **Side-sheet refactor for APK row editors** — the per-APK
  Reproducibility / CVE-details / Notes panels used to expand
  inline, eating vertical space and breaking the version list's
  reading rhythm. They now open in a right-side drawer (portal +
  motion slide-in, ESC + backdrop-close, body-scroll lock) anchored
  to the version they belong to. Cleaner reads, more room for
  forms and tables.
- **Setup wizard regression fix** — the Dockerfile split (API ↔
  worker) had stripped the JDK from the API image, breaking
  `keytool` keystore generation with a 500. The wizard now builds
  PKCS#12 in-process via `cryptography` (RSA-3072 + self-signed
  X.509 + AES-256-CBC encryption). ~150 ms vs. the previous ~2 s
  JVM cold-start; apksigner on the worker still consumes the
  output unchanged.
- **App icon rendering** — adaptive-icon foregrounds (most modern
  apps) rendered with a visible rounded-square halo behind the
  artwork in both themes. Two culprits identified: a
  `bg-surface-2` placeholder bleeding through the PNG's alpha, and
  `box-shadow` drawing on the rectangular bounding box instead of
  following the alpha channel. Swapped for `filter: drop-shadow()`
  on the `<img>` so shadows now hug the actual silhouette.
- **Visual polish** — the active rail item on `/my-apps/[id]`
  finally has a properly centred indicator dot, the
  Trivy/ClamAV/RB master toggles all live on a single
  `/admin/scanning` page, the CVE Details button opens even when a
  scan completed with zero findings (it shows the friendly "all
  clear" message), and the site footer drops the duplicate "All
  apps" / "My apps" links that were already in the navbar.

### 1.1.1

- **Service Worker media cache** — icons and screenshots now survive
  page navigation. Chrome refuses to reuse responses to
  Authorization-bearing fetches in its HTTP cache, so the SW used to
  re-download every `<img>` on every navigation between `/apps/…`,
  `/my-apps/…`, and `/history`. The SW now owns a dedicated
  `fdroid-media-v1` CacheStorage bucket (purged on logout). After
  the first visit, follow-ups serve zero bytes from the backend.
- **/history icon cache key matches /apps** — `/me/downloads` now
  exposes `updated_at` so the `?v=…` cache-buster is identical to
  the one on `/apps`. Without it, the two pages stored the icon
  under two distinct cache slots and re-fetched on every round-trip.

### 1.1.0

- **Screenshot lightbox** — clicking a screenshot tile on
  `/apps/[package]` now opens an in-page viewer (backdrop blur,
  keyboard navigation `← → Esc`, neighbour-preload) instead of
  spawning a new tab.
- **Progressive screenshot upload** — uploads on the editor page now
  run one file per request with per-file placeholders that walk
  through queued → uploading → done / error. A header chip surfaces a
  running count (3/5 → 4/5 → 5/5) so the user knows where they are
  in a batch; a failure on file 3/5 no longer atom-fails the rest.
- **Download origin chips on /history** — each app row now shows a
  per-origin breakdown (F-Droid client / web / CLI / other) so the
  user can tell which downloads came from their phone vs the SPA.
  Backend classifies the User-Agent into a coarse bucket; no
  fingerprinting, no migration, no new index.
- **Keystore metadata read 3–10× faster** — `/admin/repo` was
  noticeably laggy on every open because the `/setup/keystore`
  endpoint shelled out to `keytool` (JVM cold-start, ~500ms steady,
  multi-second on first hit). Now we parse PKCS#12 in-process via
  `cryptography`. `keytool` is still used for key generation and
  import, where the JVM cost is justified.
- **Visual polish pass** — stat digits across `/history` and the
  admin dashboards no longer render Geist Mono's slashed-zero glyph
  (which looked like a crosshair at display sizes), `/admin/categories`
  uses a curated 10-tone palette instead of free 360°-hue hashes
  with a uniform `--primary` usage bar, the `/apps/[package]`
  screenshots rail has a right-edge fade indicator and a "N captures"
  counter, the `/admin/scans` "Analyser maintenant" CTA now states
  why it's disabled when ClamAV is unreachable, and `/my-apps/new`'s
  draft watermark is localised.

### 1.0.0 → 1.0.9

- **OIDC email_verified toggle** — new `OIDC_REQUIRE_EMAIL_VERIFIED`
  env var (default `true`). Set to `false` for IdPs that don't emit
  the claim at all (Defguard, some Keycloak realms). A `WARNING` is
  logged on every boot when the gate is off.
- **S3 downloads stream through the backend** — no more 302 to a
  public S3 URL. Fixes the "anonymous-S3-refused" wall (Garage,
  private MinIO) AND closes the audit / rate-limit / signed-URL
  bypass the old shortcut created. `S3_PUBLIC_BASE_URL` becomes a
  no-op for downloads (kept in the schema for backward compat).
- **Signed media tokens for private apps** — the web UI now gets
  per-app, one-hour `?t=<token>` URLs for icons / screenshots /
  banners. `<img>` tags can finally render private-app images that
  used to 404 against the owner's own browser.
- **Browser cache headers** — `Cache-Control` is now set on every
  asset: `no-cache` for index files, `max-age=1d` for icons / screen-
  shots / banners (frontend cache-busts with `?v=updated_at`),
  `immutable` for APKs.
- **Reindex coalescing fix** — auto-enqueues used to dedup against
  arq's 24h result key, so uploads after the day's first rebuild
  were invisible until tomorrow. Default job id is now a per-minute
  bucket; the admin "Trigger reindex" button bypasses dedup entirely.
- **Per-app retention cap** (1.0.1) — admin sets a repo-wide default,
  admins can tighten per-app. FIFO eviction by versionCode, never
  touches the suggested version. Owners can't widen the cap.
- **Security review batch** (1.0.1 → 1.0.5) — SSRF guards on forge
  fetches, scheme allow-list on URL fields, audit on deploy-token +
  API-key uploads, logout endpoint, signed-URL ↔ private-app gating,
  CSP/HSTS/X-Frame-Options at the nginx layer, bootstrap advisory
  lock, postcss XSS bump.
- **Smaller polish** — readable Pydantic-validation toasts (no more
  `[object Object]`), keystore error path surfaces rc + stderr,
  GitHub repo description truncates to fit `summary`, joserfc JWS
  header cap raised so Defguard's larger ID-token headers parse,
  signed-URL downloads attribute to the logged-in user in the audit
  log, en-US fallback for missing per-locale media.

The docs site at `docs/` reflects the same shape.

## License

MIT — see `LICENSE` (TBD).
