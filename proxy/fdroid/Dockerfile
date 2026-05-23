# syntax=docker/dockerfile:1.6
# Reference F-Droid source proxy. ~3-line implementation that fetches
# index-v1.jar from any F-Droid-compatible repo, parses the JSON inside
# the JAR, and answers the source-proxy v1 protocol.
#
# Built as a Python 3.13 slim image with only fastapi + uvicorn + httpx.
# Nothing else is needed — no JDK, no native deps, no system libs.
FROM python:3.13-slim-trixie

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Three runtime deps. ``fastapi[standard]`` pulls uvicorn[standard] +
# pydantic 2; we add httpx explicitly because the spec calls for it
# (and fastapi[standard] doesn't always wire it in).
RUN pip install --upgrade pip wheel setuptools && \
    pip install \
        'fastapi[standard]>=0.136' \
        'uvicorn[standard]>=0.47' \
        'httpx>=0.27'

# Single-file app. Adding more endpoints? Drop them in ``main.py``.
WORKDIR /app
COPY main.py /app/main.py

# Non-root execution. We don't need a persistent volume — the proxy is
# stateless (every /resolve refetches the index, no cache). The
# ``fdproxy`` name avoids colliding with Debian's stock ``proxy`` user
# (uid 13) that the base image already ships.
RUN groupadd --system --gid 1001 fdproxy && \
    useradd  --system --uid 1001 --gid fdproxy --shell /usr/sbin/nologin fdproxy
USER fdproxy:fdproxy

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
