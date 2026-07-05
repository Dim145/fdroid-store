"""Non-regression for the ``parse_apk`` path-injection allowlist.

The barrier must accept the tempfile basenames every real caller
produces — including the hyphenated ``fdroid-staged-*.apk`` name from
``_materialise_staged_apk`` — while still rejecting any basename with a
traversal-capable character.

Regression context: the barrier used ``[A-Za-z0-9_]`` (no hyphen), which
rejected ``fdroid-staged-<random>.apk`` and broke every staged upload
with 400 "APK basename must be a tempfile-style filename". Direct uploads
slipped through only because they use the default ``tmp`` prefix.
"""
from __future__ import annotations

import pytest

from app.fdroid.apk_parser import ApkParseError, parse_apk


async def test_staged_hyphen_prefix_passes_basename_allowlist() -> None:
    # The hyphenated staged name must clear the allowlist. No such file
    # exists, so parse_apk fails at the *next* step ("not found") — which
    # proves the name itself was accepted rather than rejected as a
    # non-tempfile basename.
    with pytest.raises(ApkParseError) as excinfo:
        await parse_apk("fdroid-staged-Ab12_cd34.apk")
    msg = str(excinfo.value)
    assert "tempfile-style" not in msg
    assert "not found" in msg.lower()


async def test_default_tmp_prefix_passes_basename_allowlist() -> None:
    with pytest.raises(ApkParseError) as excinfo:
        await parse_apk("tmpAb12cd34.apk")
    assert "tempfile-style" not in str(excinfo.value)


@pytest.mark.parametrize(
    "basename",
    [
        "evil.tar.apk",   # extra dot could smuggle a second extension
        "bad name.apk",   # whitespace
        "sneaky%2e.apk",  # percent-encoding
        "notanapk.zip",   # wrong suffix
    ],
)
async def test_disallowed_basenames_are_rejected(basename: str) -> None:
    with pytest.raises(ApkParseError) as excinfo:
        await parse_apk(basename)
    assert "tempfile-style" in str(excinfo.value)
