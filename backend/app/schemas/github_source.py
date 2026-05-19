from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.github_source import GithubSourceStatus
from app.services.github_releases import validate_repo


class GithubSourceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    app_id: uuid.UUID
    repo: str
    asset_pattern: str | None
    include_prereleases: bool
    enabled: bool
    last_release_tag: str | None
    last_release_published_at: datetime | None
    last_scanned_at: datetime | None
    last_status: GithubSourceStatus
    last_error: str | None
    created_at: datetime
    updated_at: datetime


class ProposedAppField(BaseModel):
    """A listing field the GitHub repo could fill in for the user.

    ``field`` matches the App column name (``summary``, ``license``,
    ``website``, ``source_code``, ``author_name``). The frontend renders
    these as checkbox + value rows under the saved source so the
    operator can opt-in to each one explicitly.
    """
    field: str
    current_value: str | None = None
    proposed_value: str


class GithubSourceUpsertResponse(BaseModel):
    """PUT /apps/{id}/github-source returns the saved source plus a
    list of empty listing fields the GitHub repo could populate."""
    source: GithubSourceRead
    proposed_app_updates: list[ProposedAppField] = []


class GithubSourceUpsert(BaseModel):
    """Payload for PUT /apps/{id}/github-source.

    Repo is required; the rest defaults to a sane "fetch any APK from any
    stable release" config.
    """

    repo: str = Field(min_length=3, max_length=255)
    asset_pattern: str | None = Field(default=None, max_length=255)
    include_prereleases: bool = False
    enabled: bool = True

    @field_validator("repo")
    @classmethod
    def _validate_repo(cls, v: str) -> str:
        try:
            return validate_repo(v)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc

    @field_validator("asset_pattern")
    @classmethod
    def _normalize_pattern(cls, v: str | None) -> str | None:
        if v is None:
            return None
        stripped = v.strip()
        return stripped or None
