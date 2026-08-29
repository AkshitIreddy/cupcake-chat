from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import zipfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from cupcake_runtime.domain.errors import IntegrityViolation
from cupcake_runtime.domain.models import BackupManifest, BackupManifestEntry
from cupcake_runtime.object_store.store import EncryptedObjectStore
from cupcake_runtime.storage.database import Database
from cupcake_runtime.storage.repositories import ProductRepository

MANIFEST_PATH = "manifest.json"
DATABASE_PATH = "database/product.sqlite"


@dataclass(frozen=True, slots=True)
class BackupInspection:
    manifest: BackupManifest
    verified_entries: int
    total_bytes: int


class BackupService:
    def __init__(
        self,
        database: Database,
        repository: ProductRepository,
        object_store: EncryptedObjectStore,
        *,
        product_version: str,
    ) -> None:
        self.database = database
        self.repository = repository
        self.object_store = object_store
        self.product_version = product_version

    def create(
        self,
        destination: Path,
        *,
        extra_files: Mapping[str, Path] | None = None,
    ) -> BackupManifest:
        """Create a consistent archive containing the DB and reachable objects only."""
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary_archive = destination.with_name(f".{destination.name}.partial")
        temporary_archive.unlink(missing_ok=True)
        with tempfile.TemporaryDirectory(prefix="cupcake-backup-") as temp_name:
            staging = Path(temp_name)
            database_snapshot = staging / "product.sqlite"
            self.database.backup_to(database_snapshot)
            entries = [self._entry(DATABASE_PATH, database_snapshot)]
            extras = dict(extra_files or {})
            for archive_path, source in extras.items():
                self._validate_archive_path(archive_path)
                if archive_path in {MANIFEST_PATH, DATABASE_PATH} or archive_path.startswith(
                    "objects/"
                ):
                    raise ValueError(f"reserved backup path: {archive_path}")
                entries.append(self._entry(archive_path, source))
            reachable_ids = self.repository.reachable_object_ids()
            for object_id in reachable_ids:
                self.object_store.verify(object_id)
                object_path = self.object_store.path_for(object_id)
                archive_path = self._object_archive_path(object_id)
                entries.append(self._entry(archive_path, object_path))

            manifest = BackupManifest(
                product_version=self.product_version,
                schema_version=self.database.schema_version,
                entries=tuple(entries),
            )
            manifest_bytes = manifest.model_dump_json(indent=2).encode("utf-8")
            try:
                with zipfile.ZipFile(
                    temporary_archive, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
                ) as archive:
                    archive.writestr(MANIFEST_PATH, manifest_bytes)
                    archive.write(database_snapshot, DATABASE_PATH)
                    for archive_path, source in extras.items():
                        archive.write(source, archive_path)
                    for object_id in reachable_ids:
                        archive.write(
                            self.object_store.path_for(object_id),
                            self._object_archive_path(object_id),
                        )
                self.inspect(temporary_archive)
                os.replace(temporary_archive, destination)
            finally:
                temporary_archive.unlink(missing_ok=True)
        return manifest

    @staticmethod
    def inspect(archive_path: Path) -> BackupInspection:
        try:
            with zipfile.ZipFile(archive_path, mode="r") as archive:
                names = archive.namelist()
                if len(names) != len(set(names)):
                    raise IntegrityViolation("backup contains duplicate archive paths")
                for name in names:
                    BackupService._validate_archive_path(name)
                try:
                    manifest = BackupManifest.model_validate_json(archive.read(MANIFEST_PATH))
                except KeyError as exc:
                    raise IntegrityViolation("backup manifest is missing") from exc
                expected_paths = {MANIFEST_PATH, *(entry.path for entry in manifest.entries)}
                if set(names) != expected_paths:
                    missing = expected_paths - set(names)
                    unexpected = set(names) - expected_paths
                    raise IntegrityViolation(
                        f"backup entry set differs from manifest; missing={sorted(missing)}, "
                        f"unexpected={sorted(unexpected)}"
                    )
                total_bytes = 0
                for entry in manifest.entries:
                    digest = hashlib.sha256()
                    measured_size = 0
                    with archive.open(entry.path) as source:
                        while chunk := source.read(1024 * 1024):
                            digest.update(chunk)
                            measured_size += len(chunk)
                    if measured_size != entry.byte_size or digest.hexdigest() != entry.sha256:
                        raise IntegrityViolation(
                            f"backup entry failed integrity check: {entry.path}"
                        )
                    total_bytes += measured_size
                return BackupInspection(manifest, len(manifest.entries), total_bytes)
        except zipfile.BadZipFile as exc:
            raise IntegrityViolation("backup is not a valid ZIP archive") from exc

    @staticmethod
    def restore_to(archive_path: Path, destination: Path) -> BackupInspection:
        """Restore into a new empty directory without following archive paths."""
        inspection = BackupService.inspect(archive_path)
        if destination.exists() and any(destination.iterdir()):
            raise FileExistsError("backup restore destination must be empty")
        destination.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix=".cupcake-restore-", dir=destination.parent
        ) as temp_name:
            staging = Path(temp_name)
            with zipfile.ZipFile(archive_path, mode="r") as archive:
                for entry in inspection.manifest.entries:
                    target = staging.joinpath(*PurePosixPath(entry.path).parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(entry.path) as source, target.open("wb") as output:
                        shutil.copyfileobj(source, output, length=1024 * 1024)
            for child in staging.iterdir():
                final = destination / child.name
                if final.exists():
                    raise FileExistsError(f"restore target appeared concurrently: {final}")
                os.replace(child, final)
        return inspection

    @staticmethod
    def _entry(archive_path: str, source: Path) -> BackupManifestEntry:
        digest = hashlib.sha256()
        size = 0
        with source.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
                size += len(chunk)
        return BackupManifestEntry(path=archive_path, sha256=digest.hexdigest(), byte_size=size)

    @staticmethod
    def _object_archive_path(object_id: str) -> str:
        return f"objects/{object_id[:2]}/{object_id[2:4]}/{object_id}.cupobj"

    @staticmethod
    def _validate_archive_path(value: str) -> None:
        path = PurePosixPath(value)
        if not value or path.is_absolute() or ".." in path.parts or "\\" in value:
            raise IntegrityViolation(f"unsafe backup archive path: {value!r}")
