# fdroid-store

A self-hosted [F-Droid](https://f-droid.org) repository with a modern admin
panel and a client area for users. Designed to be a simpler, opinionated
alternative to [Repomaker](https://gitlab.com/fdroid/repomaker).

- 🟢 **Compatible with the F-Droid client** — speaks the standard
  `index-v1.jar` + `index-v2.json` protocol.
- 🟢 **Two-zone frontend** — a *client area* (account, history, API keys,
  manage your own apps) and an *admin area* (moderate, configure repo,
  rotate keys, stats).
- 🟢 **Filesystem _or_ S3 storage** — switchable via a single env var.
- 🟢 **Local auth _and_ OIDC** — Keycloak / Authentik / Google / GitLab /
  whichever OpenID Connect provider you prefer.
- 🟢 **Hybrid access** — apps can be `public` (in the regular repo URL) or
  `private` (only available to users who pass an API key as HTTP Basic auth,
  which the F-Droid Android client supports out of the box).
- 🟢 **Setup wizard** — generate or import your repo signing keystore from
  the UI on first run.

## Stack

| Layer | Tech |
|---|---|
| Backend | Python 3.12 · FastAPI · SQLAlchemy 2 (async) · PostgreSQL · Redis · arq |
| F-Droid tooling | androguard (manifest parsing) · apksigner (cert SHA-256) · jarsigner / keytool (repo signing) |
| Frontend | Next.js 15 (App Router) · TypeScript · Tailwind · shadcn-style UI · Zustand |
| Storage | Local FS or any S3-compatible object store (MinIO, Wasabi, Backblaze, …) |
| Deploy | Docker Compose (single-host) — easily portable to k8s |

## Quick start

```bash
git clone <this-repo> fdroid-store
cd fdroid-store
cp .env.example .env
# Edit .env — at minimum set SECRET_KEY and INITIAL_ADMIN_PASSWORD
docker compose up -d --build
```

Once everything is up:

| Component | URL | Notes |
|---|---|---|
| Frontend (admin + client UI) | http://localhost:3000 | |
| Backend API (Swagger docs in dev) | http://localhost:8000/api/docs | |
| F-Droid repo (configure in F-Droid client) | http://localhost:8080/fdroid/repo | |

Sign in with the initial admin credentials from `.env`, then:

1. **`/admin/setup`** — Run the setup wizard. Pick *Generate* to create a
   fresh keystore, or *Import* to upload an existing `.p12` / `.jks`.
2. **`/admin/apps`** — Create / publish apps and upload APKs.
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

# --- the public URL the F-Droid client will hit ------------------------------
PUBLIC_REPO_URL=https://apks.your-domain.tld/fdroid/repo

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

## Project structure

```
fdroid-store/
├── backend/          # FastAPI app + worker (arq) + Alembic
│   ├── app/
│   │   ├── api/      # HTTP routes
│   │   ├── core/     # config, db, security, logging
│   │   ├── fdroid/   # APK parser, keystore, index v1/v2, signing
│   │   ├── models/   # SQLAlchemy ORM
│   │   ├── schemas/  # Pydantic IO models
│   │   ├── services/ # business logic (auth, oidc, bootstrap, queue)
│   │   ├── storage/  # FS / S3 abstraction
│   │   └── workers/  # async jobs (reindex)
│   ├── alembic/      # migrations
│   ├── Dockerfile
│   └── pyproject.toml
├── frontend/         # Next.js 15
│   ├── app/
│   │   ├── (client)/ # /apps, /account, /api-keys, /history, /my-apps
│   │   └── admin/    # /admin/*
│   ├── components/
│   └── lib/
├── nginx/            # reverse proxy config
├── docker-compose.yml
└── .env.example
```

## API summary

REST API at `http://<backend>/api/v1/`. Swagger docs at `/api/docs` in dev
mode. Highlights:

```
POST  /api/v1/auth/login                # local login
POST  /api/v1/auth/signup
GET   /api/v1/auth/methods              # tells the UI what flows are on
GET   /api/v1/auth/oidc/login           # → IdP redirect (when OIDC enabled)

GET   /api/v1/me                        # who am I
POST  /api/v1/me/change-password
GET   /api/v1/me/downloads              # my download history
GET   /api/v1/me/apps                   # apps I own
GET   /api/v1/me/api-keys / POST / DELETE

GET   /api/v1/apps                      # browse public + my private
POST  /api/v1/apps                      # create app (mine)
GET   /api/v1/apps/{ref}                # by id or by package_name
POST  /api/v1/apks/upload/{app_id}      # upload APK

GET   /api/v1/setup/status              # has setup been done?
POST  /api/v1/setup/wizard              # generate/import keystore

# admin only
GET/POST/PATCH/DELETE /api/v1/admin/users
GET/PATCH             /api/v1/admin/apps
POST                  /api/v1/admin/apks/{id}/publish (or /reject)
GET/PATCH             /api/v1/admin/repo
POST                  /api/v1/admin/repo/reindex
GET                   /api/v1/admin/stats
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
`/api/v1/apks/upload/{app_id}` from CI.

## Security notes

- Repo signing keystore lives in a Docker volume; treat it like a TLS key.
- API keys are stored hashed (SHA-256 of the high-entropy random secret).
  Only the prefix is recoverable from the DB.
- Passwords are bcrypt-hashed.
- The session cookie used for the OIDC flow is `SECRET_KEY`-signed; rotate
  the key if compromised (this invalidates all JWTs, too).

## License

MIT — see `LICENSE` (TBD).
