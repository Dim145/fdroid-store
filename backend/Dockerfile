# syntax=docker/dockerfile:1.6
# ============================================================================
# Python builder — installs deps into a venv, then prunes the long tail of
# optional packages that androguard pulls in for its reverse-engineering and
# plotting features (frida, matplotlib, numpy, networkx, jedi, fontTools, …).
# We only use ``androguard.core.apk.APK`` for manifest + icon extraction so
# none of that surface is reachable from our code; dropping it saves ~250 MB.
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
# JDK builder — produces a stripped-down JDK that contains only the modules
# jarsigner / keytool / apksigner need. Full openjdk-21-jdk-headless is
# ~290 MB; the jlinked output is ~70 MB.
#
# IMPORTANT: jlink emits native binaries linked against the libc of the host
# it ran on, so this stage MUST use the same libc family as the runtime
# image. We use the Debian-based ``eclipse-temurin:21-jdk-noble`` (Ubuntu
# glibc) — Alpine's musl libc would produce a ``java`` binary the
# ``python:3.13-slim-trixie`` runtime can't ``exec``.
# ============================================================================
FROM eclipse-temurin:21-jdk-noble AS jdk-builder

# Modules required at runtime:
#   java.base             — always
#   java.logging          — keytool logs
#   java.security.jgss/   — keytool's GSS/SASL paths
#   java.security.sasl
#   java.naming           — keytool LDAP-style DN parsing
#   jdk.crypto.cryptoki   — PKCS#12 keystore I/O
#   jdk.crypto.ec         — ECDSA cert support
#   jdk.security.auth     — login modules used by keytool
#   jdk.jartool           — the jarsigner CLI itself
#   jdk.zipfs             — required to read .jar / .apk on the fly
RUN "$JAVA_HOME/bin/jlink" \
        --add-modules java.base,java.logging,java.naming,java.security.jgss,java.security.sasl,jdk.crypto.cryptoki,jdk.crypto.ec,jdk.security.auth,jdk.jartool,jdk.zipfs \
        --strip-debug \
        --no-man-pages \
        --no-header-files \
        --compress=zip-9 \
        --output /opt/jre-min

# ============================================================================
# apksigner builder — we only need the JAR + the wrapper script, not the
# whole openjdk-21-jdk-headless dependency the Debian ``apksigner`` package
# pulls in transitively.
# ============================================================================
FROM python:3.13-slim-trixie AS apksigner-builder
RUN apt-get update && apt-get install -y --no-install-recommends apksigner \
    && rm -rf /var/lib/apt/lists/*


# ============================================================================
# Runtime — the smallest reasonable surface that can still parse APKs and
# sign the F-Droid index. No build toolchain, no unused JDK modules, no
# unused Python packages. Runs as a non-root user.
# ============================================================================
FROM python:3.13-slim-trixie AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:/opt/jre-min/bin:$PATH" \
    JAVA_HOME=/opt/jre-min

# Minimum runtime libs:
#   libpq5                — psycopg2-binary runtime
#   libjpeg62-turbo       — Pillow JPEG decoding
#   zlib1g                — Pillow + apksigner zip handling
#   ca-certificates       — TLS roots for any outbound call (S3, OIDC, …)
#   tini                  — proper PID 1, reaps zombies + forwards signals to
#                            uvicorn. Tiny (~150 KB) and worth it.
#   postgresql-client-16  — pg_dump / pg_restore for the admin Backup
#                            feature, pinned to the major version that
#                            matches our server (compose runs PG 16). A
#                            17.x client emits SET directives that PG 16
#                            can't parse on restore, hence the pin via the
#                            official PostgreSQL apt repo.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt trixie-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends \
        libpq5 \
        libjpeg62-turbo \
        zlib1g \
        tini \
        postgresql-client-16 \
    && apt-get purge -y --auto-remove curl gnupg \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /usr/share/doc /usr/share/man

# Trimmed Python deps + minimal JDK + apksigner come from their own stages.
# We copy apksigner.jar to where its shipped wrapper script looks for it
# (``/usr/share/java/apksigner.jar``). The wrapper is a thin bash script that
# only calls ``java -jar``, so this is everything we need on the runtime.
COPY --from=python-builder /opt/venv /opt/venv
COPY --from=jdk-builder /opt/jre-min /opt/jre-min
COPY --from=apksigner-builder /usr/share/java/apksigner.jar /usr/share/java/apksigner.jar
COPY --from=apksigner-builder /usr/lib/android-sdk/build-tools/debian/apksigner /usr/bin/apksigner

# Non-root execution. The user owns /data so volume mounts can be written
# to without giving up the read-only root filesystem we want at runtime.
RUN groupadd --system --gid 1001 fdroid && \
    useradd  --system --uid 1001 --gid fdroid --home-dir /home/fdroid --create-home --shell /usr/sbin/nologin fdroid && \
    mkdir -p /data/storage /data/keystores /data/backup-tmp && \
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
