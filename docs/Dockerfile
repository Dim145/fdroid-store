# syntax=docker/dockerfile:1.7-labs
#
# fdroid-store docs — distroless, nonroot, static-web-server.
#
# Build & run from the repo root:
#   docker build -t fdroid-store-docs docs
#   docker run --rm -p 8080:8080 --read-only fdroid-store-docs
#
# The final image contains nothing but the SWS binary, the rendered
# docs, and glibc/libgcc (cc-debian12). No shell, no package manager.

# --- stage 1: pull the static-web-server binary ---------------------------
FROM joseluisq/static-web-server:2 AS sws

# --- stage 2: distroless final --------------------------------------------
# SWS ships as a statically-linked musl binary in a scratch base, so we
# can land it in distroless/static (no glibc/libgcc needed). Final image
# is ~10 MB: just the binary, the docs, the nonroot user, and ca-certs.
FROM gcr.io/distroless/static-debian12:nonroot

LABEL org.opencontainers.image.title="fdroid-store docs"
LABEL org.opencontainers.image.description="Static docs site for fdroid-store"
LABEL org.opencontainers.image.source="https://github.com/Dim145/fdroid-store"
LABEL org.opencontainers.image.licenses="MIT"

# 1) the server binary (sws ships it at the root of its scratch image)
COPY --from=sws /static-web-server /usr/local/bin/static-web-server

# 2) the server config (kept outside /site so it's never served)
COPY --chown=nonroot:nonroot sws.toml /etc/sws.toml

# 3) the rendered docs — exclude Dockerfile and friends from the bundle
COPY --chown=nonroot:nonroot \
     --exclude=Dockerfile \
     --exclude=.dockerignore \
     --exclude=README.md \
     --exclude=sws.toml \
     . /site/

EXPOSE 8080
USER nonroot

ENTRYPOINT ["/usr/local/bin/static-web-server"]
CMD ["-w", "/etc/sws.toml"]
