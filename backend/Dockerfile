# syntax=docker/dockerfile:1.6
# ============================================================================
# API image — runs the FastAPI app.
#
# Pure-Python from end to end: ``parse_apk()`` extracts the signing
# certificate via androguard + asn1crypto instead of shelling out to
# ``apksigner``, so the API image carries no JVM and no Android SDK
# tooling. The worker image FROMs this one and adds the heavy bits
# (JDK + apksigner for index signing, postgresql-client for backups,
# trivy CLI for CVE scans) — see Dockerfile.worker.
# ============================================================================
FROM python:3.13-slim-trixie AS python-builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# build-essential + libffi-dev cover the case where an arch lacks manylinux
# wheels for argon2-cffi / bcrypt (they ship a C extension via pwdlib).
# libpq-dev is for psycopg2-binary. libjpeg-dev / zlib1g-dev are Pillow's.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libffi-dev \
        libpq-dev \
        libjpeg-dev \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY pyproject.toml ./
RUN mkdir -p app && touch app/__init__.py
RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --upgrade pip wheel setuptools && \
    /opt/venv/bin/pip install .

# Optional androguard transitive deps we never touch. ``--yes`` is safe here
# because nothing in our codebase imports any of them. If a future change
# does pull one in, the import will fail loudly at startup.
RUN /opt/venv/bin/pip uninstall -y \
        frida \
        frida-tools \
        matplotlib \
        contourpy \
        cycler \
        kiwisolver \
        fonttools \
        pyparsing \
        networkx \
        jedi \
        parso \
        numpy \
    || true

# Drop .pyc files for everything we just touched — slim images are read-only
# at runtime, so the runtime would regenerate cache directories needlessly.
RUN find /opt/venv -name '__pycache__' -type d -exec rm -rf {} + && \
    find /opt/venv -name '*.pyc' -delete


# ============================================================================
# Runtime — minimal API surface. No JDK, no apksigner, no pg_dump,
# no trivy. The worker image extends this and layers those tools on top.
# ============================================================================
FROM python:3.13-slim-trixie AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH"

# Minimum runtime libs:
#   libpq5            — psycopg2-binary runtime
#   libjpeg62-turbo   — Pillow JPEG decoding
#   zlib1g            — Pillow zip handling
#   ca-certificates   — TLS roots for any outbound call (S3, OIDC, …)
#   tini              — proper PID 1, reaps zombies + forwards signals to
#                        uvicorn. Tiny (~150 KB) and worth it.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 \
        libjpeg62-turbo \
        zlib1g \
        ca-certificates \
        tini \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /usr/share/doc /usr/share/man

COPY --from=python-builder /opt/venv /opt/venv

# Non-root execution. The user owns /data so volume mounts can be written
# to without giving up the read-only root filesystem we want at runtime.
RUN groupadd --system --gid 1001 fdroid && \
    useradd  --system --uid 1001 --gid fdroid --home-dir /home/fdroid --create-home --shell /usr/sbin/nologin fdroid && \
    mkdir -p /data/storage /data/keystores && \
    chown -R fdroid:fdroid /data

WORKDIR /app
COPY --chown=fdroid:fdroid . /app
# Compile to .pyc once at build time as the unprivileged user; with a
# read-only root filesystem Python would otherwise try (and silently fail)
# to write bytecode on every cold import.
RUN /opt/venv/bin/python -m compileall -q /app/app /opt/venv/lib

USER fdroid:fdroid

# This image is designed to run with ``--read-only`` plus tmpfs on /tmp and
# /home/fdroid (see docker-compose.yml). PYTHONDONTWRITEBYTECODE keeps the
# interpreter from trying to repopulate __pycache__ at runtime; .pyc files
# are already laid down at build time by ``compileall`` above.
EXPOSE 8000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
