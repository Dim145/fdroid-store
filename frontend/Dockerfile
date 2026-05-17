# syntax=docker/dockerfile:1.6
# ============================================================================
# Build stage — Next.js produces a static export under ``out/``.
# ============================================================================
FROM node:24-alpine AS builder
WORKDIR /app

# Install deps first so this layer caches as long as the manifest doesn't
# change. ``--legacy-peer-deps`` is kept for parity with the previous
# Dockerfile — React 19 peer ranges still trip a few transitive deps.
COPY package.json ./
RUN npm install --legacy-peer-deps

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
# /etc/nginx/templates/, writing the result under /etc/nginx/conf.d/. Only
# ${VAR} references listed in NGINX_ENVSUBST_TEMPLATE_VARS get substituted,
# which keeps regex/${} fragments inside nginx config untouched.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

ENV UPSTREAM_BACKEND=backend:8000 \
    NGINX_ENVSUBST_TEMPLATE_VARS='${UPSTREAM_BACKEND}'

EXPOSE 8080
