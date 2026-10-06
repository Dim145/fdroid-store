"""Test-run defaults, applied before any app module reads the settings.

``ENVIRONMENT`` defaults to production, which refuses the shipped default
credentials; the test suite runs with those defaults on purpose.
"""
from __future__ import annotations

import os

os.environ.setdefault("ENVIRONMENT", "test")
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-local-pytest-only-0123456789")
