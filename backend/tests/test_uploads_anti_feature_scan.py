"""The DEX scan streams in bounded chunks instead of inflating whole entries."""
from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from app.fdroid import anti_feature_scan as afs

NEEDLE = b"com/google/firebase/analytics"  # → Tracking / Firebase Analytics


def _apk(tmp_path: Path, **dex: bytes) -> Path:
    path = tmp_path / "app.apk"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for name, data in dex.items():
            z.writestr(f"{name}.dex", data)
    return path


def test_needle_straddling_a_chunk_boundary_is_found(tmp_path: Path) -> None:
    pad = b"\0" * (afs._CHUNK - 10)  # the needle starts 10 bytes before the boundary
    found = afs.summarise(afs.scan_apk(_apk(tmp_path, classes=pad + NEEDLE + b"\0" * 100)))
    assert found == {"Tracking": ["Firebase Analytics"]}


def test_each_dex_reports_its_own_hits(tmp_path: Path) -> None:
    hits = afs.scan_apk(_apk(tmp_path, classes=NEEDLE, classes2=b"x" + NEEDLE))
    assert sorted(d.location for d in hits) == ["classes.dex", "classes2.dex"]


def test_dex_declaring_more_than_the_cap_is_skipped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(afs, "_DEX_MAX", 1000)
    assert afs.scan_apk(_apk(tmp_path, classes=NEEDLE + b"\0" * 2000)) == []


def test_total_inflated_budget_is_shared_across_dex_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(afs, "_DEX_TOTAL_MAX", 3000)
    hits = afs.scan_apk(
        _apk(tmp_path, classes=b"\0" * 2500, classes2=NEEDLE + b"\0" * 1000)
    )
    assert hits == []  # classes2.dex no longer fits in what is left
