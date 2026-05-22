"""arq tasks for the admin CVE / SBOM scanning feature.

One task: :func:`scan_apk_cve`. Auto-enqueued when an APK reaches the
``PARSED`` state, and manually re-enqueued from
``POST /apks/{id}/sbom/rescan``. Short-circuits when
``RepoConfig.cve_scanning_enabled`` is False.

The work itself shells out to ``trivy fs --format cyclonedx --scanners
vuln`` against the APK file on disk. Trivy's vuln DB lives in
``/data/trivy-cache`` (see compose) and is refreshed automatically by
trivy on first scan of the day.
"""
from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import tempfile
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.models.apk import Apk, ApkStatus
from app.models.apk_sbom import (
    ApkCve,
    ApkSbom,
    ApkSbomStatus,
    ApkSeverity,
)
from app.models.repo_config import RepoConfig
from app.storage import get_storage
from app.storage.local import LocalStorage

log = get_logger(__name__)

TRIVY_BIN = "trivy"
TRIVY_TIMEOUT = 300  # 5 min per scan — Trivy's stale-DB refresh can run long


def _trivy_version() -> str:
    try:
        out = subprocess.run(  # noqa: S603
            [TRIVY_BIN, "--version"],
            capture_output=True,
            check=False,
            timeout=10,
        )
        text = out.stdout.decode("utf-8", errors="replace").splitlines()
        if text and "Version:" in text[0]:
            return text[0].split("Version:", 1)[1].strip()
        return text[0].strip() if text else "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


def _run_trivy(apk_path: Path, server_url: str) -> dict[str, Any]:
    """Run trivy against an APK file. Returns the parsed CycloneDX JSON
    plus a separate list of vulnerabilities pulled from the same scan.

    ``trivy fs --format cyclonedx --scanners vuln --server <url>``
    outputs a CycloneDX SBOM with embedded ``vulnerabilities`` array.
    In ``--server`` mode the file-scan happens here (so we still need
    the trivy CLI in the worker image), but the vulnerability DB lookup
    is delegated to the trivy server container — which owns the ~200 MB
    DB and refreshes it on its own schedule.
    """
    cmd = [
        TRIVY_BIN,
        "fs",
        "--server", server_url,
        "--format", "cyclonedx",
        "--scanners", "vuln",
        # ``--quiet`` silences progress on stderr but still writes the
        # SBOM to stdout. Keeps the worker logs readable.
        "--quiet",
        str(apk_path),
    ]
    log.info("trivy scan start", apk=str(apk_path))
    try:
        result = subprocess.run(  # noqa: S603
            cmd,
            capture_output=True,
            check=False,
            timeout=TRIVY_TIMEOUT,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"trivy timed out after {TRIVY_TIMEOUT}s") from exc
    if result.returncode != 0:
        # Trivy uses exit code 1 also when it finds vulnerabilities by
        # default, but with ``--exit-code 0`` (the default for ``fs``)
        # a non-zero only means a real error. We bubble it up so the
        # worker can mark the row failed.
        raise RuntimeError(
            f"trivy returned {result.returncode}: "
            f"{result.stderr.decode('utf-8', errors='replace')[:500]}"
        )
    try:
        sbom = json.loads(result.stdout.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"trivy output not JSON: {exc}") from exc
    return sbom


def _coerce_severity(raw: str | None) -> ApkSeverity:
    if not raw:
        return ApkSeverity.UNKNOWN
    up = raw.strip().upper()
    for member in ApkSeverity:
        if member.value == up:
            return member
    return ApkSeverity.UNKNOWN


def _extract_findings(sbom: dict[str, Any]) -> list[dict[str, Any]]:
    """Pull the CycloneDX ``vulnerabilities`` array into a flat list of
    dicts the persistence layer can map row-by-row. Handles both the
    1.4 (``ratings``) and 1.5 (``severity`` on the vuln directly)
    shapes that recent trivy versions emit."""
    out: list[dict[str, Any]] = []
    vulns = sbom.get("vulnerabilities") or []
    # Component lookup by bom-ref → name + version for the affects[] list.
    components_by_ref: dict[str, dict[str, Any]] = {}
    for comp in sbom.get("components") or []:
        if isinstance(comp, dict) and isinstance(comp.get("bom-ref"), str):
            components_by_ref[comp["bom-ref"]] = comp
    for v in vulns:
        if not isinstance(v, dict):
            continue
        cve_id = v.get("id") or ""
        if not cve_id:
            continue
        severity = ApkSeverity.UNKNOWN
        cvss_score: float | None = None
        for rating in v.get("ratings") or []:
            if isinstance(rating, dict):
                if not severity or severity == ApkSeverity.UNKNOWN:
                    severity = _coerce_severity(rating.get("severity"))
                score = rating.get("score")
                if isinstance(score, (int, float)):
                    cvss_score = float(score)
        # Fallback: some emitters drop ``ratings`` and put a top-level
        # ``severity`` instead.
        if severity == ApkSeverity.UNKNOWN and isinstance(v.get("severity"), str):
            severity = _coerce_severity(v["severity"])

        package_name = None
        installed_version = None
        for aff in v.get("affects") or []:
            if not isinstance(aff, dict):
                continue
            ref = aff.get("ref")
            if isinstance(ref, str) and ref in components_by_ref:
                comp = components_by_ref[ref]
                package_name = comp.get("name") or package_name
                installed_version = comp.get("version") or installed_version
                break

        out.append({
            "cve_id": cve_id[:32],
            "severity": severity,
            "cvss_score": cvss_score,
            "package_name": (package_name or None) if package_name else None,
            "installed_version": (installed_version or None) if installed_version else None,
            "fixed_version": _first_fixed_version(v),
            "title": (v.get("description") or "")[:512] or None,
            "description": v.get("detail") or v.get("description") or None,
            "references_json": [
                a.get("url") for a in (v.get("advisories") or []) if isinstance(a, dict) and a.get("url")
            ] or None,
        })
    return out


def _first_fixed_version(v: dict[str, Any]) -> str | None:
    """Walk the ``affects[*].versions[*]`` array for a ``status=affected``
    + ``range`` entry that mentions a fixed version. Trivy phrases this
    as either ``"version": "1.2.3"`` (the fixed one) or as a free-form
    range string; we keep the literal first match, capped to 64 chars
    so we don't accidentally store the whole CVSS vector."""
    for aff in v.get("affects") or []:
        if not isinstance(aff, dict):
            continue
        for entry in aff.get("versions") or []:
            if not isinstance(entry, dict):
                continue
            ver = entry.get("version")
            if isinstance(ver, str) and ver:
                return ver[:64]
    return None


def _summarise(findings: list[dict[str, Any]]) -> dict[str, int]:
    summary = {m.value: 0 for m in ApkSeverity}
    for f in findings:
        sev = f.get("severity")
        if isinstance(sev, ApkSeverity):
            summary[sev.value] += 1
    return summary


async def scan_apk_cve(ctx: dict, apk_id: str) -> dict[str, Any]:
    """Worker entry-point. Resolves the APK, fetches the binary onto
    local disk (LocalStorage = direct path, S3 = needs temp file),
    runs trivy in client mode against the configured trivy server,
    persists ApkSbom + ApkCve rows."""
    aid = uuid.UUID(apk_id)
    loop = asyncio.get_running_loop()

    # Hard prerequisite: operator must have wired ``TRIVY_SERVER_URL``.
    # Without it, the worker has nowhere to send the scan; bail
    # immediately with a SKIPPED row that explains why.
    if not settings.trivy_server_url:
        await _set_row(
            None,
            aid,
            status=ApkSbomStatus.SKIPPED,
            scanned_at=datetime.now(UTC),
            error_message=(
                "TRIVY_SERVER_URL is not configured — start the trivy "
                "service ('docker compose --profile trivy up -d') and "
                "set TRIVY_SERVER_URL=http://trivy:4954 in your .env."
            ),
        )
        return {"ok": False, "skipped": True, "reason": "trivy_unavailable"}

    async with SessionLocal() as db:
        # Feature toggle short-circuit. If the admin flips the switch off
        # while a scan was queued, we record a SKIPPED row so the UI can
        # show "scanning was disabled when this ran" rather than a stuck
        # PENDING forever.
        repo = (await db.execute(select(RepoConfig).limit(1))).scalar_one_or_none()
        if repo is None or not repo.cve_scanning_enabled:
            await _set_row(
                db,
                aid,
                status=ApkSbomStatus.SKIPPED,
                scanned_at=datetime.now(UTC),
                error_message="CVE scanning is disabled in repo config",
            )
            return {"ok": False, "skipped": True}

        apk = (
            await db.execute(select(Apk).where(Apk.id == aid))
        ).scalar_one_or_none()
        if apk is None:
            log.warning("scan_apk_cve: apk vanished", apk_id=apk_id)
            return {"ok": False, "reason": "missing"}
        if apk.status not in (ApkStatus.PARSED, ApkStatus.PUBLISHED):
            await _set_row(
                db,
                aid,
                status=ApkSbomStatus.SKIPPED,
                scanned_at=datetime.now(UTC),
                error_message=f"APK is in state {apk.status} — not scannable",
            )
            return {"ok": False, "reason": "wrong_status"}
        storage_key = apk.storage_key

    storage = get_storage()
    if not isinstance(storage, LocalStorage):
        await _set_row(
            None,
            aid,
            status=ApkSbomStatus.FAILED,
            error_message="CVE scan currently supports LocalStorage only",
            scanned_at=datetime.now(UTC),
        )
        return {"ok": False, "reason": "storage_backend"}

    apk_path = storage.local_path(storage_key)
    if not apk_path.is_file():
        await _set_row(
            None,
            aid,
            status=ApkSbomStatus.FAILED,
            error_message=f"APK file missing at {apk_path}",
            scanned_at=datetime.now(UTC),
        )
        return {"ok": False, "reason": "file_missing"}

    await _set_row(
        None,
        aid,
        status=ApkSbomStatus.SCANNING,
        error_message=None,
    )

    try:
        server_url = settings.trivy_server_url or ""
        sbom = await loop.run_in_executor(None, _run_trivy, apk_path, server_url)
    except Exception as exc:  # noqa: BLE001
        log.warning("trivy scan failed", apk_id=apk_id, error=str(exc))
        await _set_row(
            None,
            aid,
            status=ApkSbomStatus.FAILED,
            error_message=str(exc)[:1000],
            scanned_at=datetime.now(UTC),
            trivy_version=_trivy_version(),
        )
        return {"ok": False, "error": str(exc)}

    findings = _extract_findings(sbom)
    summary = _summarise(findings)

    # Persist atomically: wipe old findings, set the new SBOM blob, then
    # insert the per-CVE rows.
    async with SessionLocal() as db:
        existing = (
            await db.execute(select(ApkSbom).where(ApkSbom.apk_id == aid))
        ).scalar_one_or_none()
        if existing is None:
            existing = ApkSbom(apk_id=aid)
            db.add(existing)
        existing.status = ApkSbomStatus.DONE
        existing.scanned_at = datetime.now(UTC)
        existing.trivy_version = _trivy_version()
        existing.sbom_json = sbom
        existing.cve_summary = summary
        existing.error_message = None
        await db.flush()
        # Replace findings wholesale — trivy is stateless and the new
        # output is the canonical truth.
        await db.execute(
            ApkCve.__table__.delete().where(ApkCve.sbom_id == existing.id)
        )
        for f in findings:
            db.add(ApkCve(sbom_id=existing.id, **f))
        await db.commit()
    return {"ok": True, "findings": len(findings), "summary": summary}


async def _set_row(
    db,
    apk_id: uuid.UUID,
    *,
    status: ApkSbomStatus | None = None,
    scanned_at: datetime | None = None,
    error_message: str | None = None,
    trivy_version: str | None = None,
) -> None:
    """Upsert an ApkSbom row to one of the lifecycle states. ``db=None``
    opens its own session — used by callers that aren't inside one."""
    own_session = db is None
    if own_session:
        db = SessionLocal()
    try:
        row = (
            await db.execute(select(ApkSbom).where(ApkSbom.apk_id == apk_id))
        ).scalar_one_or_none()
        if row is None:
            row = ApkSbom(apk_id=apk_id)
            db.add(row)
        if status is not None:
            row.status = status
        if scanned_at is not None:
            row.scanned_at = scanned_at
        if error_message is not None:
            row.error_message = error_message
        if trivy_version is not None:
            row.trivy_version = trivy_version
        await db.commit()
    finally:
        if own_session:
            await db.close()
