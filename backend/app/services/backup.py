"""Encrypted full-system backup + restore.

A backup is a single AES-256-GCM-encrypted tarball that contains:

* ``manifest.json``       — format version + backend version + repo id +
                             counts so the restore side can validate.
* ``db.sql``              — ``pg_dump --clean --if-exists`` plain output.
* ``keystore.p12``        — the F-Droid repo signing key, copied byte-for-byte.
* ``storage/`` tree       — every file under ``settings.local_storage_path``
                             (APKs, icons, screenshots).

Encryption layout:

::

    [ 16 bytes scrypt salt ]
    [ 12 bytes GCM nonce   ]
    [ ciphertext stream    ]
    [ 16 bytes GCM tag     ]

Key derivation uses scrypt(N=2**16, r=8, p=1) → 32-byte AES-256 key. Restore
seeks to the file's end to read the tag before initialising the decryptor —
the upload landed on disk anyway, so the seek is free.

Restore is destructive: it drops the public schema, restores from db.sql,
wipes the storage tree, then untars the new one. The backend keeps running
but the SQLAlchemy connection pool may emit a few errors on already-open
sessions; the admin gets a "refresh required" notice in the UI.
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import shutil
import subprocess
import tarfile
import tempfile
from collections.abc import AsyncIterator, Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

# Progress callback signature passed by the worker. ``(phase_label,
# 0-100 integer)``. The worker's implementation persists the values
# to the BackupJob row + checks the cancel flag. Synchronous because
# the heavy lifting runs in an asyncio executor thread; bridging back
# to an async DB call would require ``asyncio.run_coroutine_threadsafe``
# and a captured loop. The worker's progress_cb does that internally.
ProgressCb = Callable[[str, int], None]


def _noop_progress(phase: str, pct: int) -> None:  # noqa: ARG001
    """Default no-op so ``_build_tarball`` etc. stay usable from tests
    without a worker plumbed in."""

from cryptography.hazmat.primitives.ciphers import Cipher
from cryptography.hazmat.primitives.ciphers.algorithms import AES
from cryptography.hazmat.primitives.ciphers.modes import GCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
BACKUP_FORMAT_VERSION = "fdroid-store-backup-v1"

# Per-component selectors. The admin can choose any non-empty subset at
# backup time; the manifest records which made it in. At restore time
# we apply only the intersection of (selected, present-in-manifest).
COMPONENT_DB = "db"
COMPONENT_KEYSTORE = "keystore"
COMPONENT_ASSETS = "assets"  # icons + per-package screenshot dirs
COMPONENT_APKS = "apks"      # apks tree + generated F-Droid index
ALL_COMPONENTS: set[str] = {
    COMPONENT_DB,
    COMPONENT_KEYSTORE,
    COMPONENT_ASSETS,
    COMPONENT_APKS,
}

SALT_LEN = 16
NONCE_LEN = 12
TAG_LEN = 16
CHUNK_SIZE = 64 * 1024
# scrypt params: ~64 MB memory, ~0.5s on a modern core. Strong enough to
# deter brute force on a leaked backup while still being usable on a
# small VPS.
SCRYPT_N = 2**16
SCRYPT_R = 8
SCRYPT_P = 1


# ---------------------------------------------------------------------------
# Custom exceptions
# ---------------------------------------------------------------------------
class BackupError(RuntimeError):
    """Surface-level backup / restore failure. The API layer maps it to a
    400 with the message verbatim — phrase it to be admin-readable."""


# ---------------------------------------------------------------------------
# Key derivation
# ---------------------------------------------------------------------------
def _derive_key(passphrase: str, salt: bytes) -> bytes:
    kdf = Scrypt(salt=salt, length=32, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P)
    return kdf.derive(passphrase.encode("utf-8"))


# ---------------------------------------------------------------------------
# DB plumbing
# ---------------------------------------------------------------------------
def _parse_database_url() -> dict[str, str]:
    """Decode ``DATABASE_URL`` into the bits ``pg_dump`` and ``psql`` need on
    the command line. We refuse anything other than the asyncpg / psycopg2
    Postgres dialect — there's nothing else to do here, but a typo in the
    env would otherwise crash with a cryptic subprocess error."""
    url = urlparse(settings.database_url)
    if url.scheme not in {"postgresql", "postgresql+asyncpg", "postgresql+psycopg2"}:
        raise BackupError(f"Unsupported DATABASE_URL scheme '{url.scheme}'")
    if not url.hostname:
        raise BackupError("DATABASE_URL is missing a host")
    return {
        "host": url.hostname,
        "port": str(url.port or 5432),
        "user": url.username or "",
        "password": url.password or "",
        "dbname": (url.path or "/").lstrip("/") or "",
    }


def _pg_env(params: dict[str, str]) -> dict[str, str]:
    env = os.environ.copy()
    env["PGPASSWORD"] = params["password"]
    return env


def _run_pg_dump(out_path: Path) -> None:
    params = _parse_database_url()
    cmd = [
        "pg_dump",
        "--host", params["host"],
        "--port", params["port"],
        "--username", params["user"],
        "--dbname", params["dbname"],
        "--no-owner",
        "--no-privileges",
        # ``--clean --if-exists`` makes the dump self-applying: it emits
        # DROP TABLE IF EXISTS … before each CREATE TABLE, so restore is
        # idempotent on a populated DB.
        "--clean",
        "--if-exists",
        "--format=plain",
        "--file", str(out_path),
    ]
    log.info("pg_dump start", out=str(out_path))
    result = subprocess.run(  # noqa: S603 — args fully controlled above
        cmd,
        env=_pg_env(params),
        check=False,
        capture_output=True,
    )
    if result.returncode != 0:
        raise BackupError(
            f"pg_dump failed (rc={result.returncode}): "
            f"{result.stderr.decode('utf-8', errors='replace')[:500]}"
        )
    log.info("pg_dump done", size=out_path.stat().st_size)


def _run_psql_apply(sql_path: Path) -> None:
    params = _parse_database_url()
    # The backend's own SQLAlchemy pool keeps connections open on the
    # public schema; ``DROP SCHEMA public CASCADE`` would block waiting
    # for those locks to release. Terminate every other session on the
    # DB first — SQLAlchemy's pool will reconnect on next use (errors
    # may surface briefly on in-flight requests; the SPA tells the
    # admin to refresh after restore).
    #
    # The terminate uses ``pg_terminate_backend`` which sends SIGTERM-
    # equivalent to the target backend processes. ``pid <> pg_backend_pid()``
    # protects this very session from being killed mid-statement.
    terminate = [
        "psql",
        "--host", params["host"],
        "--port", params["port"],
        "--username", params["user"],
        "--dbname", params["dbname"],
        "--quiet",
        "--no-psqlrc",
        "-v", "ON_ERROR_STOP=1",
        # Bind the DB name as a psql variable: ``:'datname'`` expands to a
        # safely-quoted string literal, so we never interpolate the value
        # into the SQL ourselves. Defence-in-depth — ``dbname`` comes from
        # our own DATABASE_URL, not user input, but this removes the
        # string-built-SQL sink entirely (bandit B608).
        "-v", f"datname={params['dbname']}",
        "-c", (
            "SELECT pg_terminate_backend(pid) "
            "FROM pg_stat_activity "
            "WHERE datname = :'datname' "
            "AND pid <> pg_backend_pid();"
        ),
    ]
    log.info("psql terminate other sessions")
    result = subprocess.run(  # noqa: S603
        terminate,
        env=_pg_env(params),
        check=False,
        capture_output=True,
        timeout=30,
    )
    if result.returncode != 0:
        log.warning(
            "session terminate emitted non-zero — continuing",
            rc=result.returncode,
            stderr=result.stderr.decode('utf-8', errors='replace')[:200],
        )

    # Wipe + recreate the public schema so the DROP/CREATE statements in
    # the dump start from a guaranteed-blank slate. Without this, residual
    # objects (sequences from removed tables, custom enum types) can clash
    # with the dump's CREATE statements.
    pre = [
        "psql",
        "--host", params["host"],
        "--port", params["port"],
        "--username", params["user"],
        "--dbname", params["dbname"],
        "--quiet",
        "--no-psqlrc",
        "-v", "ON_ERROR_STOP=1",
        "-c", "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
    ]
    log.info("psql wipe public schema")
    result = subprocess.run(  # noqa: S603
        pre,
        env=_pg_env(params),
        check=False,
        capture_output=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise BackupError(
            f"psql wipe failed (rc={result.returncode}): "
            f"{result.stderr.decode('utf-8', errors='replace')[:500]}"
        )
    cmd = [
        "psql",
        "--host", params["host"],
        "--port", params["port"],
        "--username", params["user"],
        "--dbname", params["dbname"],
        "--quiet",
        "--no-psqlrc",
        "-v", "ON_ERROR_STOP=1",
        "-f", str(sql_path),
    ]
    log.info("psql apply start", sql=str(sql_path))
    result = subprocess.run(  # noqa: S603
        cmd,
        env=_pg_env(params),
        check=False,
        capture_output=True,
    )
    if result.returncode != 0:
        raise BackupError(
            f"psql apply failed (rc={result.returncode}): "
            f"{result.stderr.decode('utf-8', errors='replace')[:500]}"
        )
    log.info("psql apply done")


# ---------------------------------------------------------------------------
# Storage helpers
# ---------------------------------------------------------------------------
def _ensure_local_storage() -> Path:
    """Backup / restore only support the local storage backend in v1. For S3
    deployments we'd need to iterate the bucket and stream each object;
    that's a real feature on its own."""
    if settings.storage_backend != "local":
        raise BackupError(
            "Backup is only supported with the local storage backend. "
            "S3 deployments should snapshot the bucket through the cloud "
            "provider's own tooling."
        )
    return Path(settings.local_storage_path)


def _safe_extract(tar: tarfile.TarFile, dest: Path) -> None:
    """Defence against the classic CVE-2007-4559 tar-extraction pitfall: a
    member whose name starts with ``/`` or contains ``..`` slips outside
    the destination directory."""
    real_dest = dest.resolve()
    for member in tar.getmembers():
        # Reject absolute paths, parent-dir tricks, and symlinks that
        # could be exploited after extraction.
        if member.name.startswith("/"):
            raise BackupError(f"refusing absolute path in tar: {member.name}")
        if ".." in Path(member.name).parts:
            raise BackupError(f"refusing parent-dir path in tar: {member.name}")
        if member.issym() or member.islnk():
            raise BackupError(f"refusing symlink in tar: {member.name}")
        target = (real_dest / member.name).resolve()
        try:
            target.relative_to(real_dest)
        except ValueError as exc:
            raise BackupError(f"refusing escape via {member.name}") from exc
    tar.extractall(dest, filter="data")  # noqa: S202 — guarded above


# ---------------------------------------------------------------------------
# Tarball assembly
# ---------------------------------------------------------------------------
def _write_manifest(
    out_path: Path,
    repo_id: str,
    version: str,
    components: list[str],
) -> None:
    manifest: dict[str, Any] = {
        "format_version": BACKUP_FORMAT_VERSION,
        "backend_version": version,
        "created_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "repo_id": repo_id,
        "storage_backend": settings.storage_backend,
        # Sorted for stable manifest hashes — useful when comparing two
        # backups for equality outside this codebase.
        "components": sorted(components),
    }
    out_path.write_text(json.dumps(manifest, indent=2, sort_keys=True))


def _classify_storage_entry(name: str) -> str:
    """Categorise a top-level entry under ``settings.local_storage_path``.

    Layout in this codebase:

      * ``apks/``                 → ``apks`` component (binary blobs)
      * ``repo/``                 → ``apks`` component (regenerated F-Droid
                                     index — ships alongside the binaries
                                     it points at)
      * ``icons/``                → ``assets`` component
      * any other directory       → ``assets`` (per-package screenshot
                                     dirs are named after the package id,
                                     e.g. ``com.example.foo/en-US/
                                     phoneScreenshots/…``)

    Returning the empty string when an entry shouldn't be archived (no
    such case today, but kept as a hook).
    """
    if name == "apks" or name == "repo":
        return COMPONENT_APKS
    return COMPONENT_ASSETS


def _build_tarball(
    tmp_dir: Path,
    *,
    repo_id: str,
    version: str,
    components: set[str],
    progress: ProgressCb = _noop_progress,
) -> Path:
    """Assemble the plaintext tarball at ``tmp_dir/backup.tar`` and return its
    path. The encryption stage reads it from there.

    Only the requested ``components`` are included. The manifest records
    the final list so restore can match selected against present.

    ``progress`` is called between phases so the worker can persist the
    advancement to the BackupJob row. The percentages are coarse — they
    reflect the phase boundary, not byte-level progress inside it (which
    would require streaming pg_dump and the tarfile module, both of
    which we'd rather keep simple).
    """
    if not components or not (components & ALL_COMPONENTS):
        raise BackupError("At least one component must be selected")

    tar_path = tmp_dir / "backup.tar"
    sql_path = tmp_dir / "db.sql"
    manifest_path = tmp_dir / "manifest.json"

    included: list[str] = []

    if COMPONENT_DB in components:
        progress("pg_dump", 5)
        _run_pg_dump(sql_path)
        included.append(COMPONENT_DB)

    storage_root = _ensure_local_storage()
    keystore_path = Path(settings.keystore_path)

    # Pre-walk storage to decide which top-level entries we'll be
    # including — used to populate the manifest's ``components`` list
    # accurately even if storage is empty for a given category.
    if storage_root.is_dir():
        for entry in storage_root.iterdir():
            cat = _classify_storage_entry(entry.name)
            if cat and cat in components and cat not in included:
                included.append(cat)
    if COMPONENT_KEYSTORE in components and keystore_path.is_file():
        included.append(COMPONENT_KEYSTORE)

    _write_manifest(
        manifest_path,
        repo_id=repo_id,
        version=version,
        components=included,
    )
    progress("tar", 30)

    log.info(
        "tar pack start",
        tar=str(tar_path),
        components=",".join(sorted(components)),
    )
    with tarfile.open(tar_path, "w") as tar:
        tar.add(str(manifest_path), arcname="manifest.json")
        if COMPONENT_DB in components and sql_path.is_file():
            tar.add(str(sql_path), arcname="db.sql")
        if COMPONENT_KEYSTORE in components:
            if keystore_path.is_file():
                tar.add(str(keystore_path), arcname="keystore.p12")
            else:
                log.warning("keystore missing — skipping", path=str(keystore_path))
        if storage_root.is_dir():
            for entry in storage_root.iterdir():
                cat = _classify_storage_entry(entry.name)
                if cat in components:
                    tar.add(str(entry), arcname=f"storage/{entry.name}")
    log.info("tar pack done", size=tar_path.stat().st_size)
    progress("tar", 60)
    return tar_path


def encrypt_file_to(
    plaintext_path: Path,
    out_path: Path,
    passphrase: str,
    *,
    progress: ProgressCb = _noop_progress,
) -> None:
    """Encrypt ``plaintext_path`` into ``out_path`` (AES-256-GCM, scrypt KDF).

    Streams through a 64 KB read buffer so multi-GB inputs don't OOM the
    worker. The tag is appended at the end; decryption reads it via
    seek-to-tail before driving the chunks through the decryptor.
    """
    if not passphrase or len(passphrase) < 12:
        raise BackupError("Passphrase must be at least 12 characters")
    progress("encrypting", 65)
    salt = secrets.token_bytes(SALT_LEN)
    nonce = secrets.token_bytes(NONCE_LEN)
    key = _derive_key(passphrase, salt)
    encryptor = Cipher(AES(key), GCM(nonce)).encryptor()
    src_size = plaintext_path.stat().st_size
    written = 0
    last_pct = 65
    with open(plaintext_path, "rb") as src, open(out_path, "wb") as dst:
        dst.write(salt + nonce)
        while True:
            chunk = src.read(CHUNK_SIZE)
            if not chunk:
                break
            dst.write(encryptor.update(chunk))
            written += len(chunk)
            if src_size > 0:
                pct = 65 + int(30 * written / src_size)
                if pct != last_pct:
                    progress("encrypting", pct)
                    last_pct = pct
        dst.write(encryptor.finalize())
        dst.write(encryptor.tag)
    progress("encrypting", 95)


# ---------------------------------------------------------------------------
# Public API: create_backup
# ---------------------------------------------------------------------------
async def stream_encrypted_backup(
    passphrase: str,
    *,
    repo_id: str,
    backend_version: str,
) -> AsyncIterator[bytes]:
    """Async generator yielding the encrypted backup chunk by chunk.

    The FastAPI endpoint wraps this in a ``StreamingResponse``. We do the
    heavy lifting (pg_dump, tar, encryption read pass) in a worker thread
    so the event loop isn't blocked. The two temp files are kept alive
    for the lifetime of the stream and cleaned up at the end.
    """
    if not passphrase or len(passphrase) < 12:
        raise BackupError("Passphrase must be at least 12 characters")

    # ``tempfile.mkdtemp`` rather than ``TemporaryDirectory`` so the dir
    # survives the generator's lifetime — we delete it explicitly in the
    # finally clause once the consumer has drained the stream.
    Path(settings.backup_tmp_dir).mkdir(parents=True, exist_ok=True)
    tmp_dir = Path(tempfile.mkdtemp(prefix="fdroid-backup-", dir=settings.backup_tmp_dir))
    try:
        loop = asyncio.get_running_loop()
        tar_path = await loop.run_in_executor(
            None,
            lambda: _build_tarball(
                tmp_dir,
                repo_id=repo_id,
                version=backend_version,
                components=ALL_COMPONENTS,
            ),
        )

        salt = secrets.token_bytes(SALT_LEN)
        nonce = secrets.token_bytes(NONCE_LEN)
        key = await loop.run_in_executor(None, _derive_key, passphrase, salt)
        encryptor = Cipher(AES(key), GCM(nonce)).encryptor()

        # Header
        yield salt + nonce

        # Stream ciphertext from disk. We read in a worker thread to avoid
        # blocking the loop on file I/O.
        with open(tar_path, "rb") as f:
            while True:
                chunk = await loop.run_in_executor(None, f.read, CHUNK_SIZE)
                if not chunk:
                    break
                yield encryptor.update(chunk)
        yield encryptor.finalize()
        yield encryptor.tag
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Public API: restore_backup
# ---------------------------------------------------------------------------
def _decrypt_file(src: Path, dst: Path, passphrase: str) -> None:
    """Read the encrypted backup at ``src`` and write the plaintext tarball
    to ``dst``. Reads the GCM tag from the file's tail before initialising
    the decryptor."""
    file_size = src.stat().st_size
    if file_size < SALT_LEN + NONCE_LEN + TAG_LEN:
        raise BackupError("File too small to be a valid backup")
    with open(src, "rb") as f:
        salt = f.read(SALT_LEN)
        nonce = f.read(NONCE_LEN)
        # Tag lives at the very end. Read it now so we can construct the
        # decryptor with both the IV and the tag (GCM verifies on finalize).
        f.seek(-TAG_LEN, os.SEEK_END)
        tag = f.read(TAG_LEN)

        try:
            key = _derive_key(passphrase, salt)
            decryptor = Cipher(AES(key), GCM(nonce, tag)).decryptor()
        except Exception as exc:  # noqa: BLE001
            raise BackupError("Could not derive key from passphrase") from exc

        ciphertext_len = file_size - SALT_LEN - NONCE_LEN - TAG_LEN
        f.seek(SALT_LEN + NONCE_LEN)
        with open(dst, "wb") as out:
            remaining = ciphertext_len
            while remaining > 0:
                chunk = f.read(min(CHUNK_SIZE, remaining))
                if not chunk:
                    break
                out.write(decryptor.update(chunk))
                remaining -= len(chunk)
            try:
                out.write(decryptor.finalize())
            except Exception as exc:  # noqa: BLE001
                # InvalidTag — wrong passphrase or corrupted ciphertext.
                # Wipe the partially-written plaintext so we don't leak
                # a half-decrypt that could mask the failure.
                out.close()
                dst.unlink(missing_ok=True)
                raise BackupError(
                    "Decryption failed — wrong passphrase or corrupted file"
                ) from exc


def _do_restore(src_encrypted: Path, passphrase: str) -> dict[str, Any]:
    """Apply a backup file. Returns a summary dict. Raises BackupError on
    any validation / extraction failure — the API layer wraps in a 400."""
    Path(settings.backup_tmp_dir).mkdir(parents=True, exist_ok=True)
    tmp_dir = Path(tempfile.mkdtemp(prefix="fdroid-restore-", dir=settings.backup_tmp_dir))
    try:
        plaintext_tar = tmp_dir / "backup.tar"
        _decrypt_file(src_encrypted, plaintext_tar, passphrase)

        extract_dir = tmp_dir / "extracted"
        extract_dir.mkdir()
        with tarfile.open(plaintext_tar, "r") as tar:
            _safe_extract(tar, extract_dir)

        manifest_path = extract_dir / "manifest.json"
        if not manifest_path.is_file():
            raise BackupError("manifest.json missing — not a valid backup")
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("format_version") != BACKUP_FORMAT_VERSION:
            raise BackupError(
                f"Unsupported backup format '{manifest.get('format_version')}'. "
                f"This server speaks '{BACKUP_FORMAT_VERSION}'."
            )

        sql_path = extract_dir / "db.sql"
        if not sql_path.is_file():
            raise BackupError("db.sql missing — backup is incomplete")

        # Apply the DB dump first. If this fails the storage layer is still
        # intact, which is the less destructive failure mode.
        _run_psql_apply(sql_path)

        # Storage swap. The compose stack mounts ``/data/storage`` as a
        # named volume — renaming the directory itself fails with EROFS
        # because the mount point lives on the read-only image layer.
        # Walk its contents instead: wipe everything under ``storage_root``,
        # then move the extracted tree's children in. No "old" backup
        # is kept; the encrypted tarball on disk is the only "previous"
        # state, which is what the user holds anyway.
        new_storage = extract_dir / "storage"
        storage_root = _ensure_local_storage()
        if new_storage.is_dir():
            for entry in storage_root.iterdir():
                if entry.is_dir() and not entry.is_symlink():
                    shutil.rmtree(entry)
                else:
                    entry.unlink(missing_ok=True)
            for entry in new_storage.iterdir():
                shutil.move(str(entry), str(storage_root / entry.name))

        # Keystore swap (best-effort — older backups might not include one).
        # ``shutil.copyfile`` (not ``copy2``) drops the metadata copy that
        # would otherwise EPERM when the existing keystore on disk is
        # owned by a different uid (e.g. root, when the volume's been
        # initialised by another container at compose start).
        new_keystore = extract_dir / "keystore.p12"
        if new_keystore.is_file():
            target = Path(settings.keystore_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(str(new_keystore), str(target))

        return {
            "format_version": manifest.get("format_version"),
            "created_at": manifest.get("created_at"),
            "backend_version": manifest.get("backend_version"),
            "repo_id": manifest.get("repo_id"),
        }
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


async def restore_backup(src_encrypted: Path, passphrase: str) -> dict[str, Any]:
    """Async wrapper that pushes the synchronous restore into a worker
    thread so the request handler doesn't block the event loop. The
    encrypted file MUST already be on disk — the API layer streams the
    upload into a temp file first."""
    if not passphrase:
        raise BackupError("Passphrase is required")
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _do_restore, src_encrypted, passphrase)


# ---------------------------------------------------------------------------
# Worker-friendly entrypoints (sync, progress-callback driven)
# ---------------------------------------------------------------------------
CancelCheck = Callable[[], bool]


def _noop_cancel() -> bool:
    return False


def build_and_encrypt(
    *,
    passphrase: str,
    out_path: Path,
    repo_id: str,
    backend_version: str,
    components: set[str] | None = None,
    progress: ProgressCb = _noop_progress,
    cancelled: CancelCheck = _noop_cancel,
) -> Path:
    """Synchronous worker entrypoint for the backup pipeline. Builds the
    plaintext tarball under ``settings.backup_tmp_dir``, encrypts it to
    ``out_path``, and returns ``out_path``.

    ``components`` selects which categories make it into the tarball.
    Defaults to ``ALL_COMPONENTS``.

    The ``cancelled`` callback is checked at phase boundaries; if it
    returns True the function raises :class:`BackupError` with a
    discriminator message the worker can use to mark the job CANCELLED.
    """
    selected = components if components else set(ALL_COMPONENTS)
    Path(settings.backup_tmp_dir).mkdir(parents=True, exist_ok=True)
    tmp_dir = Path(tempfile.mkdtemp(prefix="fdroid-backup-", dir=settings.backup_tmp_dir))
    try:
        progress("starting", 1)
        if cancelled():
            raise BackupError("__CANCELLED__")
        tar_path = _build_tarball(
            tmp_dir,
            repo_id=repo_id,
            version=backend_version,
            components=selected,
            progress=progress,
        )
        if cancelled():
            raise BackupError("__CANCELLED__")
        encrypt_file_to(tar_path, out_path, passphrase, progress=progress)
        if cancelled():
            # The output file was just produced — if the admin cancelled
            # right at the edge, drop it so we don't leave a half-claimed
            # backup on disk.
            out_path.unlink(missing_ok=True)
            raise BackupError("__CANCELLED__")
        progress("ready", 100)
        return out_path
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def decrypt_and_apply(
    *,
    src_encrypted: Path,
    passphrase: str,
    components: set[str] | None = None,
    progress: ProgressCb = _noop_progress,
) -> dict[str, Any]:
    """Synchronous worker entrypoint for the restore pipeline.

    ``components`` limits which categories from the backup actually get
    applied. ``None`` = apply everything present in the manifest. A
    subset is intersected with the manifest's ``components`` list;
    items requested but absent from the manifest are silently skipped
    (they couldn't be applied anyway), with the summary's
    ``applied_components`` reporting what we actually touched.

    Restores intentionally ignore cancellation — once the DB wipe
    starts, an abort would leave a half-restored schema with no clean
    rollback path.
    """
    if not passphrase:
        raise BackupError("Passphrase is required")
    Path(settings.backup_tmp_dir).mkdir(parents=True, exist_ok=True)
    tmp_dir = Path(tempfile.mkdtemp(prefix="fdroid-restore-", dir=settings.backup_tmp_dir))
    try:
        progress("decrypting", 5)
        plaintext_tar = tmp_dir / "backup.tar"
        _decrypt_file(src_encrypted, plaintext_tar, passphrase)

        progress("validating", 15)
        extract_dir = tmp_dir / "extracted"
        extract_dir.mkdir()
        with tarfile.open(plaintext_tar, "r") as tar:
            _safe_extract(tar, extract_dir)

        manifest_path = extract_dir / "manifest.json"
        if not manifest_path.is_file():
            raise BackupError("manifest.json missing — not a valid backup")
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("format_version") != BACKUP_FORMAT_VERSION:
            raise BackupError(
                f"Unsupported backup format '{manifest.get('format_version')}'. "
                f"This server speaks '{BACKUP_FORMAT_VERSION}'."
            )

        manifest_components = set(manifest.get("components") or list(ALL_COMPONENTS))
        # Old (v1.0) backups predate the components field — treat the
        # missing case as "everything is here" so they still restore.
        if components is None:
            selected = manifest_components
        else:
            selected = components & manifest_components

        if not selected:
            raise BackupError(
                "No components selected for restore (or none of the selected ones "
                "are present in this backup)."
            )

        applied: list[str] = []

        # DB
        if COMPONENT_DB in selected:
            sql_path = extract_dir / "db.sql"
            if not sql_path.is_file():
                raise BackupError("db.sql missing — backup is incomplete")
            progress("applying_db", 25)
            _run_psql_apply(sql_path)
            applied.append(COMPONENT_DB)

        # Storage (assets + apks): partition the tar's storage/ tree
        # by classifier and walk only the entries whose category is in
        # ``selected``. Existing entries in the same category are wiped
        # first so the swap is a true replace; categories NOT selected
        # are left alone.
        storage_payload = extract_dir / "storage"
        storage_root = _ensure_local_storage()
        wants_storage = bool(selected & {COMPONENT_ASSETS, COMPONENT_APKS})
        if wants_storage and storage_payload.is_dir():
            progress("applying_storage", 70)
            # Wipe categories we're about to replace.
            for entry in storage_root.iterdir():
                cat = _classify_storage_entry(entry.name)
                if cat in selected:
                    if entry.is_dir() and not entry.is_symlink():
                        shutil.rmtree(entry)
                    else:
                        entry.unlink(missing_ok=True)
            # Move in the new tree.
            for entry in storage_payload.iterdir():
                cat = _classify_storage_entry(entry.name)
                if cat in selected:
                    shutil.move(str(entry), str(storage_root / entry.name))
            for cat in (COMPONENT_ASSETS, COMPONENT_APKS):
                if cat in selected:
                    applied.append(cat)

        # Keystore
        if COMPONENT_KEYSTORE in selected:
            new_keystore = extract_dir / "keystore.p12"
            if new_keystore.is_file():
                progress("applying_keystore", 92)
                target = Path(settings.keystore_path)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(str(new_keystore), str(target))
                applied.append(COMPONENT_KEYSTORE)

        progress("done", 100)
        return {
            "format_version": manifest.get("format_version"),
            "created_at": manifest.get("created_at"),
            "backend_version": manifest.get("backend_version"),
            "repo_id": manifest.get("repo_id"),
            "manifest_components": sorted(manifest_components),
            "applied_components": sorted(set(applied)),
        }
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Iterator helpers — kept here so endpoint code stays terse
# ---------------------------------------------------------------------------
def filename_for_now(repo_id: str) -> str:
    """Returns ``fdroid-store-backup-<repo_id-prefix>-<YYYY-MM-DD-HHMMSS>.tar.gz.enc``.

    The ``.enc`` suffix screams "binary blob, do not gzip again". We keep
    ``.tar.gz`` in the middle so file-managers preview the icon usefully.
    """
    now = datetime.now(UTC).strftime("%Y-%m-%d-%H%M%S")
    short = (repo_id or "repo")[:8]
    return f"fdroid-store-backup-{short}-{now}.tar.enc"


def read_manifest(src_encrypted: Path, passphrase: str) -> dict[str, Any]:
    """Decrypt just enough of a backup file to extract its manifest.

    Used by the API to populate the UI's component-selection step
    without committing to an actual restore. The decrypt + tar listing
    is cheap compared to applying — we still write the plaintext to a
    temp file (the GCM tag verification can't be skipped) but we don't
    untar anything except ``manifest.json``.
    """
    if not passphrase:
        raise BackupError("Passphrase is required")
    Path(settings.backup_tmp_dir).mkdir(parents=True, exist_ok=True)
    tmp_dir = Path(tempfile.mkdtemp(prefix="fdroid-manifest-", dir=settings.backup_tmp_dir))
    try:
        plaintext_tar = tmp_dir / "backup.tar"
        _decrypt_file(src_encrypted, plaintext_tar, passphrase)
        with tarfile.open(plaintext_tar, "r") as tar:
            try:
                member = tar.getmember("manifest.json")
            except KeyError as exc:
                raise BackupError("manifest.json missing — not a valid backup") from exc
            f = tar.extractfile(member)
            if f is None:
                raise BackupError("could not read manifest.json")
            return json.loads(f.read().decode("utf-8"))
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


__all__ = [
    "ALL_COMPONENTS",
    "BACKUP_FORMAT_VERSION",
    "BackupError",
    "COMPONENT_APKS",
    "COMPONENT_ASSETS",
    "COMPONENT_DB",
    "COMPONENT_KEYSTORE",
    "filename_for_now",
    "read_manifest",
    "restore_backup",
    "stream_encrypted_backup",
]


# Type stub for callers that don't care about Iterator vs AsyncIterator
_IterStub = Iterator[bytes]  # noqa: F841 — kept for IDE hover
