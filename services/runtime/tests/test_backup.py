import zipfile
from pathlib import Path

import pytest

from cupcake_runtime.backup.service import BackupService
from cupcake_runtime.domain.errors import IntegrityViolation
from cupcake_runtime.domain.models import ArtifactKind, ObjectMetadata
from cupcake_runtime.object_store.store import EncryptedObjectStore
from cupcake_runtime.storage.database import Database
from cupcake_runtime.storage.repositories import ProductRepository


def test_backup_contains_only_reachable_verified_objects(
    database: Database, repository: ProductRepository, tmp_path: Path
) -> None:
    store = EncryptedObjectStore(tmp_path / "objects", b"b" * 32)
    reachable_content = b"reachable artifact"
    reachable = store.put(reachable_content)
    unreachable = store.put(b"orphaned object")
    repository.record_object(
        ObjectMetadata(
            object_id=reachable,
            byte_size=len(reachable_content),
            media_type="text/plain",
        )
    )
    artifact = repository.create_artifact("Report", ArtifactKind.REPORT, "text/plain")
    repository.add_artifact_revision(
        artifact.id,
        object_id=reachable,
        byte_size=len(reachable_content),
        expected_head_id=None,
    )
    service = BackupService(database, repository, store, product_version="2.0.0-test")
    archive = tmp_path / "backup.cupcake-backup"
    manifest = service.create(archive)
    inspection = service.inspect(archive)
    assert inspection.manifest == manifest
    assert any(reachable in entry.path for entry in manifest.entries)
    assert all(unreachable not in entry.path for entry in manifest.entries)

    restored = tmp_path / "restored"
    service.restore_to(archive, restored)
    assert (restored / "database" / "product.sqlite").is_file()
    restored_object = restored / "objects" / reachable[:2] / reachable[2:4] / f"{reachable}.cupobj"
    assert restored_object.is_file()


def test_backup_detects_modified_entries(
    database: Database, repository: ProductRepository, tmp_path: Path
) -> None:
    store = EncryptedObjectStore(tmp_path / "objects", b"b" * 32)
    service = BackupService(database, repository, store, product_version="2.0.0-test")
    archive = tmp_path / "backup.cupcake-backup"
    service.create(archive)
    with pytest.warns(UserWarning, match="Duplicate name"), zipfile.ZipFile(archive, "a") as handle:
        handle.writestr("database/product.sqlite", b"tampered")
    with pytest.raises(IntegrityViolation):
        service.inspect(archive)
