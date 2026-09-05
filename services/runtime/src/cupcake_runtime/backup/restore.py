from __future__ import annotations

import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from cupcake_runtime.backup.service import BackupService
from cupcake_runtime.object_store import EncryptedObjectStore
from cupcake_runtime.storage.content_protection import ContentLayout
from cupcake_runtime.storage.database import Database
from cupcake_runtime.storage.repositories import ProductRepository

SQLITE_HEADER = b"SQLite format 3\x00"


@dataclass(frozen=True, slots=True)
class PreparedRestore:
    profile_root: Path
    content_encrypted: bool
    verified_entries: int
    total_bytes: int


class OpenedRestoreRuntime(Protocol):
    database: Database
    repository: ProductRepository
    objects: EncryptedObjectStore
    content_layout: ContentLayout


def prepare_disposable_profile(runtime_archive: Path, destination: Path) -> PreparedRestore:
    """Verify an inner runtime archive and publish a new disposable profile.

    The caller owns ``destination`` and must choose it outside the live profile.
    Publication is an atomic directory rename; any failure removes the partial
    tree and leaves no apparently prepared profile behind.
    """

    if not runtime_archive.is_absolute() or not destination.is_absolute():
        raise ValueError("restore archive and destination must be absolute")
    if destination.exists():
        raise FileExistsError("disposable restore destination already exists")
    parent = destination.parent
    parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{destination.name}.restore-", dir=parent))
    published = False
    try:
        extracted = temporary / "archive"
        inspection = BackupService.restore_to(runtime_archive, extracted)
        product_database = extracted / "database" / "product.sqlite"
        if not product_database.is_file():
            raise ValueError("runtime backup is missing the product database")

        # Version-1 backups used runtime.sqlite; coordinated backups use the
        # role-correct dbos.sqlite name. Accept both, but never both together.
        durability_candidates = (
            extracted / "database" / "dbos.sqlite",
            extracted / "database" / "runtime.sqlite",
        )
        present_durability = [path for path in durability_candidates if path.is_file()]
        if len(present_durability) != 1:
            raise ValueError("runtime backup must contain exactly one durability database")

        with product_database.open("rb") as handle:
            content_encrypted = handle.read(len(SQLITE_HEADER)) != SQLITE_HEADER

        profile = temporary / "profile"
        profile.mkdir()
        os.replace(product_database, profile / "cupcake.db")
        os.replace(present_durability[0], profile / "cupcake-runtime.db")
        dbos_system = extracted / "database" / "dbos-system.sqlite"
        if dbos_system.is_file():
            os.replace(dbos_system, profile / "cupcake-dbos-system.db")
        objects = extracted / "objects"
        if objects.exists():
            if not objects.is_dir():
                raise ValueError("runtime backup object store has an invalid type")
            os.replace(objects, profile / "objects")
        else:
            (profile / "objects").mkdir()

        # No other archive payload may be silently discarded. The manifest is
        # excluded by BackupService.restore_to; only now-empty database/archive
        # scaffolding is expected to remain.
        remaining_files = tuple(path for path in extracted.rglob("*") if path.is_file())
        if remaining_files:
            raise ValueError("runtime backup contains unsupported profile payloads")

        os.replace(profile, destination)
        published = True
        return PreparedRestore(
            profile_root=destination,
            content_encrypted=content_encrypted,
            verified_entries=inspection.verified_entries,
            total_bytes=inspection.total_bytes,
        )
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
        if not published:
            shutil.rmtree(destination, ignore_errors=True)


def verify_opened_disposable_profile(runtime: OpenedRestoreRuntime) -> dict[str, object]:
    """Fully authenticate an already-opened disposable RuntimeService."""

    database = runtime.database
    repository = runtime.repository
    objects = runtime.objects
    content_layout = runtime.content_layout
    integrity = tuple(database.integrity_check())
    if integrity != ("ok",):
        raise RuntimeError("restored product database failed its integrity check")
    reachable = tuple(repository.reachable_object_ids())
    reachable_set = set(reachable)
    stored = tuple(objects.iter_ids())
    if len(stored) != len(set(stored)) or set(stored) != reachable_set:
        raise RuntimeError("restored object store differs from database reachability")
    total_object_bytes = 0
    for object_id in stored:
        total_object_bytes += objects.verify(object_id)
    return {
        "databaseIntegrity": "ok",
        "contentMode": content_layout.mode.value,
        "reachableObjects": len(reachable),
        "verifiedObjectBytes": total_object_bytes,
        "schemaVersion": database.schema_version,
    }
