"""Non-regression for the LocalStorage path-injection barrier.

``_resolve`` must accept every server-generated storage key (which may
legitimately contain ``/``, ``.``, ``_`` and ``-``) and map it *under* the
storage root, while rejecting absolute paths and any ``.``/``..`` traversal
— this is the CodeQL ``py/path-injection`` guard on ``local.py``.
"""
from __future__ import annotations

import pytest

from app.storage.local import LocalStorage


@pytest.mark.parametrize(
    "key",
    [
        "staging/c060a625f3a7e0ae6c09d3748c82eff6.apk",
        "fdroid/repo/com.ZNZNGames.SeedbedWars_1.apk",
        "fdroid/repo/icons/com.ZNZNGames.SeedbedWars.png",
        "fdroid/repo/com.ZNZNGames.SeedbedWars/en-US/phoneScreenshots/"
        "e81b7307-0dbc-466d-bfc2-9964278a9064.png",
        "fdroid/repo/entry.jar",
        "fdroid/repo/index-v2.json",
    ],
)
def test_legit_keys_resolve_under_root(tmp_path, key: str) -> None:
    store = LocalStorage(tmp_path)
    resolved = store.local_path(key)
    assert resolved.is_relative_to(store.base)


@pytest.mark.parametrize(
    "key",
    [
        "/etc/passwd",          # absolute
        "../../etc/passwd",     # climb out
        "fdroid/../../etc/passwd",
        "fdroid/repo/..",       # trailing ..
        "a/./b",                # single-dot segment
        "fdroid//repo",         # empty segment
        "",                     # empty key
        "..",                   # bare ..
    ],
)
def test_traversal_keys_are_rejected(tmp_path, key: str) -> None:
    store = LocalStorage(tmp_path)
    with pytest.raises(ValueError):
        store.local_path(key)
