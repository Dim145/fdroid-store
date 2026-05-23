"""Generate an F-Droid ``metadata.yml`` file from an App row.

The output mirrors what ``services.metadata_import.parse_metadata_yaml``
*reads* — round-trip with the New App / import flow is the design goal.
We emit the canonical F-Droid field order so the file matches what
``fdroidserver`` and ``fdroiddata`` editors expect at a glance.

We deliberately do NOT try to synthesize a source-build recipe. The
``Builds:`` section we emit lists each published APK in the F-Droid
"binary-only" shape — ``versionCode`` + ``versionName`` + ``binary:``
pointing at the actual APK URL inside this repo. That makes the file
immediately usable in an fdroiddata fork without claiming we know how
to reproduce the artifact from source.

Reference: https://f-droid.org/docs/Build_Metadata_Reference/
"""
from __future__ import annotations

from typing import Any

import yaml

from app.models.app import App
from app.models.apk import ApkStatus
from app.models.repo_config import RepoConfig


class _LiteralStr(str):
    """Marker subtype: dumped as a ``|-`` block scalar.

    pyyaml lets us pick the scalar style per-string via a custom
    representer. Multiline ``Description`` reads infinitely better as a
    block scalar than as a quoted one-liner with ``\\n`` escapes, which
    is what the default dumper would produce.
    """


def _literal_representer(dumper: yaml.Dumper, data: _LiteralStr) -> Any:
    # ``|-`` (literal, strip trailing newlines) is the style F-Droid's
    # own files use for Description. We pass ``style='|'`` and yaml
    # adds the strip indicator automatically.
    return dumper.represent_scalar("tag:yaml.org,2002:str", str(data), style="|")


class _FDroidDumper(yaml.SafeDumper):
    """Local dumper subclass so the literal-string representer doesn't
    leak into the rest of the codebase. Other call sites that use
    ``yaml.safe_dump`` keep their behaviour unchanged."""


_FDroidDumper.add_representer(_LiteralStr, _literal_representer)


def _git_repo_url(source) -> str | None:
    """Render the upstream ``Repo:`` URL.

    Mirrors ``github_releases``'s URL builder so the output matches the
    forge the source was scanned from. ``base_url`` (self-hosted GitLab
    or Gitea) wins over the canonical public host.
    """
    if source is None:
        return None
    repo = (source.repo or "").strip("/ ")
    if not repo:
        return None
    provider = source.provider.value if hasattr(source.provider, "value") else str(source.provider)
    base = (source.base_url or "").rstrip("/")
    if provider.upper() == "GITHUB":
        host = base or "https://github.com"
        return f"{host}/{repo}.git"
    if provider.upper() == "GITLAB":
        host = base or "https://gitlab.com"
        return f"{host}/{repo}.git"
    if provider.upper() == "GITEA":
        # No canonical public host for Gitea / Forgejo — only emit the URL
        # when the operator pointed us at an explicit instance.
        if not base:
            return None
        return f"{base}/{repo}.git"
    return None


def _build_entries(
    app: App,
    repo_address: str | None,
) -> list[dict[str, Any]]:
    """Render the ``Builds:`` list — one entry per published APK in
    ascending versionCode order (F-Droid convention).

    Each entry uses F-Droid's "binary-only" shape: ``versionCode`` +
    ``versionName`` + ``binary`` pointing at the actual APK URL inside
    this repo. ``binary`` requires ``%v`` / ``%c`` placeholders in
    fdroidserver, but a literal URL is also accepted and is what we
    want here — we know the exact filename for each version.
    """
    out: list[dict[str, Any]] = []
    apks = sorted(
        (a for a in (app.apks or []) if a.status == ApkStatus.PUBLISHED),
        key=lambda a: a.version_code,
    )
    base = (repo_address or "").rstrip("/")
    for apk in apks:
        # F-Droid APK URLs follow ``<repo>/<package>_<versionCode>.apk``.
        # The frontend's download links use the same convention, so the
        # exported YAML stays valid against the live index.
        url = f"{base}/{app.package_name}_{apk.version_code}.apk" if base else None
        entry: dict[str, Any] = {}
        entry["versionName"] = str(apk.version_name)
        entry["versionCode"] = int(apk.version_code)
        if url:
            entry["binary"] = url
        out.append(entry)
    return out


def build_metadata_dict(
    app: App,
    *,
    repo_config: RepoConfig | None = None,
) -> dict[str, Any]:
    """Build the YAML-ready dict for ``app``.

    The caller is expected to have eagerly loaded ``app.categories``,
    ``app.apks`` and ``app.github_source`` (the latter is the SQLAlchemy
    ``backref`` declared on the GithubSource side). Missing relations
    degrade gracefully — those sections simply won't appear in the YAML.

    Returns a plain ``dict`` (Python 3.7+ preserves insertion order)
    so the YAML preserves F-Droid's conventional field order
    (Categories → License → Author → URLs → AutoName → Summary →
    Description → Repo → Builds → Update modes).
    """
    out: dict[str, Any] = {}

    cats = sorted({c.name for c in (app.categories or []) if c and c.name})
    if cats:
        out["Categories"] = cats
    if app.license:
        out["License"] = app.license

    if app.author_name:
        out["AuthorName"] = app.author_name
    if app.author_email:
        out["AuthorEmail"] = app.author_email
    if app.website:
        out["WebSite"] = app.website
    if app.source_code:
        out["SourceCode"] = app.source_code
    if app.issue_tracker:
        out["IssueTracker"] = app.issue_tracker
    if app.translation:
        out["Translation"] = app.translation

    # Funding links — F-Droid recognises a fixed handful. We emit only
    # the ones the operator filled in.
    if app.donate:
        out["Donate"] = app.donate
    if app.liberapay:
        out["Liberapay"] = app.liberapay
    if app.open_collective:
        out["OpenCollective"] = app.open_collective
    if app.bitcoin:
        out["Bitcoin"] = app.bitcoin

    # Display name — F-Droid distinguishes ``AutoName`` (from the APK's
    # ``android:label``) from ``Name`` (a manual override). Our DB only
    # tracks one ``name`` field, so we emit it as ``AutoName`` to match
    # the upstream convention: it's what the binary actually says.
    if app.name:
        out["AutoName"] = app.name
    if app.summary:
        out["Summary"] = app.summary
    if app.description:
        # Wrap in our literal-string marker so the dumper emits a
        # ``Description: |-`` block. Default dumper would escape
        # newlines, making the output a one-liner of ``\n`` escapes.
        out["Description"] = _LiteralStr(app.description.rstrip())

    # Upstream VCS link, when the app has a GithubSource wired up.
    source = getattr(app, "github_source", None)
    repo_url = _git_repo_url(source)
    if repo_url:
        out["RepoType"] = "git"
        out["Repo"] = repo_url
        # The source scanner watches releases by tag, so the F-Droid
        # auto-update mode that matches our behaviour is ``UpdateCheckMode:
        # Tags``. ``AutoUpdateMode: Version`` tells fdroidserver to copy
        # the most recent version into the index automatically.
        out["AutoUpdateMode"] = "Version"
        out["UpdateCheckMode"] = "Tags"

    # Per-version binary builds (only published APKs make it in).
    repo_address = repo_config.address if repo_config else None
    builds = _build_entries(app, repo_address)
    if builds:
        out["Builds"] = builds

    # ``CurrentVersion`` / ``CurrentVersionCode`` point fdroidclient at
    # the suggested install. Mirror the same fields the index renderer
    # writes so an export → import round-trip preserves the pin.
    if app.suggested_version_name:
        out["CurrentVersion"] = app.suggested_version_name
    if app.suggested_version_code is not None:
        out["CurrentVersionCode"] = int(app.suggested_version_code)

    return out


def serialize_metadata_yaml(
    app: App,
    *,
    repo_config: RepoConfig | None = None,
) -> str:
    """Render the ``app`` as an F-Droid ``metadata.yml`` string.

    The output is self-contained and ready to drop into an fdroiddata
    fork. Leading comment lines document what was omitted versus a
    fully-recipe'd source build, so an operator picking up the file
    knows where to fill in the gaps.
    """
    data = build_metadata_dict(app, repo_config=repo_config)
    body = yaml.dump(
        data,
        Dumper=_FDroidDumper,
        # F-Droid uses block style throughout. ``default_flow_style=False``
        # forces lists to multi-line "- item" form instead of ``[item]``.
        default_flow_style=False,
        # Preserve our dict insertion order — the F-Droid spec
        # has a canonical field order and ``fdroidserver`` editors group
        # by it, so alphabetising would look wrong.
        sort_keys=False,
        allow_unicode=True,
        width=4096,  # don't wrap URLs across lines
    )
    header = (
        f"# Exported by fdroid-store for {app.package_name}\n"
        f"# Binary-only Builds[] — fill in ``commit:``/``gradle:`` etc.\n"
        f"# in your fdroiddata fork if you want a source-recipe build.\n"
        f"\n"
    )
    return header + body
