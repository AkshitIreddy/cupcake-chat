from __future__ import annotations

import importlib.util
import zipfile
from pathlib import Path

import pytest

from cupcake_runtime.application import RuntimeService
from cupcake_runtime.backup import prepare_disposable_profile, verify_opened_disposable_profile
from cupcake_runtime.domain.errors import IntegrityViolation


def _build_archive(root: Path, key: bytes, *, encrypted: bool) -> tuple[Path, str, str]:
    runtime = RuntimeService.from_profile_root(
        root / "source",
        master_key=key,
        default_encrypted=encrypted,
    )
    project, _ = runtime.handle("projects.create", {"name": "Restored project"})
    artifact, _ = runtime.handle(
        "artifacts.create",
        {
            "projectId": project["id"],
            "title": "Recovery proof",
            "kind": "document",
            "mimeType": "text/plain",
            "content": "RESTORE-CANARY-5938",
        },
    )
    archive = root / "runtime.zip"
    runtime.handle("backup.create.private", {"destinationPath": str(archive.resolve())})
    runtime.close()
    return archive, project["id"], artifact["artifact"]["id"]


@pytest.mark.parametrize("encrypted", [False, True])
def test_disposable_restore_reopens_and_authenticates_content(
    tmp_path: Path, encrypted: bool
) -> None:
    if encrypted and importlib.util.find_spec("sqlcipher3") is None:
        pytest.skip("the developer interpreter does not include SQLCipher")
    key = b"r" * 32
    archive, project_id, artifact_id = _build_archive(tmp_path, key, encrypted=encrypted)
    destination = (tmp_path / "disposable").resolve()

    prepared = prepare_disposable_profile(archive.resolve(), destination)
    assert prepared.content_encrypted is encrypted
    restored = RuntimeService.from_profile_root(
        destination,
        master_key=key,
        default_encrypted=prepared.content_encrypted,
    )
    try:
        verified = verify_opened_disposable_profile(restored)
        assert verified["databaseIntegrity"] == "ok"
        assert verified["reachableObjects"] == 1
        artifact, _ = restored.handle(
            "artifacts.get", {"projectId": project_id, "artifactId": artifact_id}
        )
        assert artifact["content"] == "RESTORE-CANARY-5938"
    finally:
        restored.close()


def test_disposable_restore_failure_removes_partial_profile(tmp_path: Path) -> None:
    archive, _, _ = _build_archive(tmp_path, b"t" * 32, encrypted=False)
    tampered = tmp_path / "tampered.zip"
    with zipfile.ZipFile(archive) as source, zipfile.ZipFile(tampered, "w") as changed:
        for entry in source.infolist():
            payload = bytearray(source.read(entry.filename))
            if entry.filename == "database/product.sqlite":
                payload[-1] ^= 0x80
            changed.writestr(entry, payload)
    destination = (tmp_path / "failed-restore").resolve()

    with pytest.raises(IntegrityViolation):
        prepare_disposable_profile(tampered.resolve(), destination)
    assert not destination.exists()
