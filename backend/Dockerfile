# syntax=docker/dockerfile:1.6
# ============================================================================
# Builder: install Python deps in a venv we can copy later.
# ============================================================================
FROM python:3.12-slim-bookworm AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libpq-dev \
        libjpeg-dev \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
# Copy only the project metadata first so the dependency install layer is
# cached as long as pyproject.toml doesn't change. We need a minimal package
# tree for ``pip install .`` to succeed without copying the whole app.
COPY pyproject.toml ./
RUN mkdir -p app && touch app/__init__.py
RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --upgrade pip wheel setuptools && \
    /opt/venv/bin/pip install .

# ============================================================================
# Runtime image
# ============================================================================
FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    ANDROID_BUILD_TOOLS_VERSION=34.0.0

# Java for jarsigner / keytool; Android build-tools for apksigner.
# We install only the minimal set (build-tools + platform-tools) via the
# command-line tools, keeping the image as small as we can.
RUN apt-get update && apt-get install -y --no-install-recommends \
        openjdk-17-jdk-headless \
        ca-certificates \
        curl \
        unzip \
        libpq5 \
        libjpeg62-turbo \
        zlib1g \
        apksigner \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY . /app

# Pre-create data dirs (volumes will mount over them in compose)
RUN mkdir -p /data/storage /data/keystores

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
