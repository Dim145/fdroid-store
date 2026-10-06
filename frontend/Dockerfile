# syntax=docker/dockerfile:1.6
# ============================================================================
# Build stage — Next.js produces a static export under ``out/``.
# ============================================================================
FROM node:24-alpine AS builder
WORKDIR /app

# Install deps first so this layer caches as long as the manifests don't
# change. ``npm ci`` installs exactly what package-lock.json pins (and
# fails if it's out of sync with package.json) — ``npm install`` from
# package.json alone resolved the newest in-range versions on every build,
# ignoring the lockfile's security pins and running whatever install
# scripts those fresh versions shipped. ``--legacy-peer-deps`` is kept for
# parity: React 19 peer ranges still trip a few transitive deps, and the
# lockfile was generated with it.
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

COPY . .
# Build emits ``out/`` because next.config.mjs sets ``output: "export"``.
# Everything in ``out/`` is plain HTML/JS/CSS — no Node runtime required.
RUN npm run build

# ============================================================================
# Runtime stage — nginx (unprivileged, alpine base) serves the static bundle
# and reverse-proxies the API + F-Droid repo paths to the backend.
#
# The same image runs portably:
#   * In docker-compose, UPSTREAM_BACKEND resolves to ``backend:8000``.
#   * Behind any other reverse-proxy / k8s ingress, the operator overrides
#     UPSTREAM_BACKEND with the backend's actual host:port.
# No build-time URL is baked in — the published image is reusable across
# hosts. The base image runs as a non-root user and binds to 8080 so it
# slots into restricted environments (no CAP_NET_BIND_SERVICE needed).
# ============================================================================
FROM nginxinc/nginx-unprivileged:1.29-alpine AS runner

# Static bundle.
COPY --from=builder /app/out /usr/share/nginx/html

# The official nginx image's entrypoint runs envsubst on every file in
# /etc/nginx/templates/, writing the result under /etc/nginx/conf.d/. It
# only substitutes env vars whose NAME matches the NGINX_ENVSUBST_FILTER
# regex (unset = every env var of the container), so the anchored list
# below is exactly the set of ``${VAR}`` the template uses — nothing else
# from the environment can leak into the config. Keep it in sync with
# nginx.conf.template.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
# Custom entrypoint shims (sourced ``.envsh`` files, so their exports
# survive into the downstream envsubst step; the entrypoint only sources
# them when executable, hence --chmod):
#   10-fdroid-hsts.envsh   ``${HSTS_DIRECTIVE}`` from ENABLE_HSTS.
#   16-fdroid-nginx.envsh  defaults + validation for NGINX_RESOLVER, the
#                          body-size caps and TRUSTED_PROXY_CIDRS
#                          (``${REAL_IP_DIRECTIVES}``). Runs after the
#                          image's 15-local-resolvers.envsh.
COPY --chmod=0755 docker-entrypoint.d/10-fdroid-hsts.envsh /docker-entrypoint.d/10-fdroid-hsts.envsh
COPY --chmod=0755 docker-entrypoint.d/16-fdroid-nginx.envsh /docker-entrypoint.d/16-fdroid-nginx.envsh

ENV UPSTREAM_BACKEND=backend:8000 \
    ENABLE_HSTS=0 \
    HSTS_MAX_AGE=31536000 \
    NGINX_ENVSUBST_FILTER='^(UPSTREAM_BACKEND|HSTS_DIRECTIVE|REAL_IP_DIRECTIVES|NGINX_RESOLVER|API_MAX_BODY_SIZE|UPLOAD_MAX_BODY_SIZE)$'

# The nginx-unprivileged base already runs as uid 101, but declare it
# explicitly so the non-root guarantee is visible in this Dockerfile and
# survives a future base-image change (satisfies trivy DS-0002).
USER 101

EXPOSE 8080
