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

# --- optional: ClamAV (only used when the ``clamav`` profile is up) ----------
CLAMAV_HOST=clamav
CLAMAV_PORT=3310
CLAMAV_MAX_STREAM_MB=100

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

APK downloads under `/fdroid/repo/` are nginx-served directly for public
content, and via `X-Accel-Redirect` (`/_protected`) for private content,
so the backend never streams APK bytes itself.

## Auth modes

| Mode | Credential | Use case |
|---|---|---|
| Local password | argon2 (legacy bcrypt rows still verify) | normal browser sessions |
| OIDC | external IdP via Authlib | SSO with Keycloak, Google, etc. |
| TOTP | RFC 6238 (`pyotp`), QR enrolment under `/account` | optional second factor for local logins |
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

# apps + apks
GET   /api/v1/apps                      # browse public + my private
POST  /api/v1/apps                      # create app (mine)
POST  /api/v1/apps/with-apk             # create + first APK in one shot
POST  /api/v1/apps/with-github-source   # create from a forge URL
POST  /api/v1/apps/import-metadata      # paste fdroiddata YAML
GET   /api/v1/apps/{id|package_name}
POST  /api/v1/apks/upload/{app_id}      # bearer JWT, API key, or deploy token
POST  /api/v1/apks/{id}/download-url    # signed URL for private APK

# per-app config
GET/POST/DELETE  /api/v1/apps/{id}/deploy-tokens
GET/PUT/DELETE   /api/v1/apps/{id}/github-source
POST             /api/v1/apps/{id}/github-source/scan
GET/POST/DELETE  /api/v1/apps/{id}/collaborators
POST/DELETE      /api/v1/apps/{id}/{icon,feature-graphic,promo-graphic,tv-banner,screenshots}

# feeds
GET   /api/v1/feed/new                  # Atom / RSS
GET   /api/v1/feed/updates

# setup
GET   /api/v1/setup/status              # has setup been done?
POST  /api/v1/setup/wizard              # generate/import keystore

# admin only
GET/POST/PATCH/DELETE /api/v1/admin/users
GET/PATCH             /api/v1/admin/apps
POST                  /api/v1/admin/apks/{id}/publish (or /reject)
GET/PATCH             /api/v1/admin/repo
POST                  /api/v1/admin/repo/reindex
GET                   /api/v1/admin/jobs              # arq run history
GET                   /api/v1/admin/audit             # audit log
GET                   /api/v1/admin/scans             # ClamAV results
POST                  /api/v1/admin/apks/rescan
GET                   /api/v1/admin/stats
GET                   /api/v1/admin/clamav/ping
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

## License

MIT — see `LICENSE` (TBD).
