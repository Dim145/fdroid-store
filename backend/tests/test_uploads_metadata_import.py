"""metadata.yml import: parser blow-ups are a 400, never a 500."""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.services.metadata_import import parse_metadata_yaml


@pytest.mark.parametrize(
    "raw",
    [
        "Name: x\nCategories: " + "[" * 5000 + "]" * 5000,  # RecursionError in the composer
        "Name: x\nAuthorName: " + "{a: " * 3000 + "1" + "}" * 3000,
        "Name: x\nAdded: 2020-13-45",  # ValueError from the timestamp constructor
    ],
)
def test_unexpected_parser_errors_map_to_400(raw: str) -> None:
    with pytest.raises(HTTPException) as excinfo:
        parse_metadata_yaml(raw)
    assert excinfo.value.status_code == 400


def test_normal_metadata_still_parses() -> None:
    out = parse_metadata_yaml("Name: Example\nCategories:\n  - Internet\nLicense: MIT\n")
    assert out["name"] == "Example"
    assert out["categories"] == ["Internet"]
