from __future__ import annotations

from importlib.util import find_spec
from pathlib import Path

import pytest

from cupcake_runtime.application import RuntimeCommandError, RuntimeService
from cupcake_runtime.object_store import ObjectCorruptionError
from cupcake_runtime.storage.content_protection import ContentProtectionMode

pytestmark = pytest.mark.skipif(find_spec("sqlcipher3") is None, reason="SQLCipher unavailable")


def _new_runtime(path: Path, *, encrypted: bool) -> RuntimeService:
    return RuntimeService(path, master_key=b"p" * 32, require_sqlcipher=encrypted)


def test_content_encryption_round_trip_preserves_database_and_objects(tmp_path: Path) -> None:
    runtime = _new_runtime(tmp_path, encrypted=False)
    project, _ = runtime.handle("projects.create", {"name": "Migration proof"})
    artifact, _ = runtime.handle(
        "artifacts.create",
        {
            "projectId": project["id"],
            "title": "Readable before migration",
            "kind": "document",
            "mimeType": "text/plain",
            "content": "cupcake migration payload",
        },
    )
    result, _ = runtime.handle(
        "content_protection.set", {"mode": ContentProtectionMode.ENCRYPTED.value}
    )
    assert result["changed"] is True
    assert result["requiresRestart"] is True

    reopened = RuntimeService.from_profile_root(tmp_path, master_key=b"p" * 32)
    status, _ = reopened.handle("content_protection.status")
    assert status["mode"] == "encrypted"
    assert status["credentialsProtection"] == "windows-dpapi-current-user"
    assert not (tmp_path / "cupcake.db").exists()
    assert not (tmp_path / "objects").exists()
    projects, _ = reopened.handle("projects.list")
    assert [item["name"] for item in projects] == ["Migration proof"]
    snapshot, _ = reopened.handle(
        "artifacts.get", {"artifactId": artifact["artifact"]["id"], "projectId": project["id"]}
    )
    assert snapshot["content"] == "cupcake migration payload"
    reopened.handle("content_protection.set", {"mode": "plaintext"})

    plaintext = RuntimeService.from_profile_root(tmp_path, master_key=b"p" * 32)
    status, _ = plaintext.handle("content_protection.status")
    assert status["mode"] == "plaintext"
    assert status["retainedEncryptedRollbackCopies"] == 1
    assert (plaintext.profile_path.read_bytes()[:16]) == b"SQLite format 3\x00"
    object_payloads = [path.read_bytes() for path in plaintext.objects.root.rglob("*.cupobj")]
    assert any(b"cupcake migration payload" in payload for payload in object_payloads)
    plaintext.close()


def test_corrupt_staged_generation_rolls_back_to_previous_content(tmp_path: Path) -> None:
    runtime = _new_runtime(tmp_path, encrypted=False)
    runtime.handle("projects.create", {"name": "Recovery proof"})
    runtime.handle("content_protection.set", {"mode": "encrypted"})

    descriptor = (tmp_path / "security" / "content-protection.json").read_text("utf-8")
    generation = __import__("json").loads(descriptor)["generation"]
    target = tmp_path / "content-generations" / generation / "cupcake.db"
    target.write_bytes(b"damaged target")

    recovered = RuntimeService.from_profile_root(tmp_path, master_key=b"p" * 32)
    status, _ = recovered.handle("content_protection.status")
    assert status["mode"] == "plaintext"
    projects, _ = recovered.handle("projects.list")
    assert [item["name"] for item in projects] == ["Recovery proof"]
    recovered.close()


def test_failed_copy_never_publishes_partial_generation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime = _new_runtime(tmp_path, encrypted=False)
    runtime.handle("projects.create", {"name": "Still authoritative"})

    def fail_copy(*_args: object) -> None:
        raise OSError("simulated copy failure")

    monkeypatch.setattr(runtime.content_protection, "_copy_objects", fail_copy)
    with pytest.raises(RuntimeCommandError, match="could not verify"):
        runtime.handle("content_protection.set", {"mode": "encrypted"})

    assert not (tmp_path / "security" / "content-protection.json").exists()
    recovered = RuntimeService.from_profile_root(
        tmp_path,
        master_key=b"p" * 32,
        default_encrypted=False,
    )
    projects, _ = recovered.handle("projects.list")
    assert [item["name"] for item in projects] == ["Still authoritative"]
    recovered.close()


def test_noncanonical_generation_identifier_is_rejected(tmp_path: Path) -> None:
    security = tmp_path / "security"
    security.mkdir()
    (security / "content-protection.json").write_text(
        '{"version":1,"mode":"encrypted","generation":"../outside"}\n',
        encoding="utf-8",
    )
    with pytest.raises(RuntimeError, match="generation identifier is invalid"):
        RuntimeService.from_profile_root(tmp_path, master_key=b"p" * 32)


def test_finalized_startup_leaves_object_authentication_lazy(tmp_path: Path) -> None:
    runtime = _new_runtime(tmp_path, encrypted=False)
    project, _ = runtime.handle("projects.create", {"name": "Lazy verification"})
    artifact, _ = runtime.handle(
        "artifacts.create",
        {
            "projectId": project["id"],
            "title": "Corruption remains visible",
            "kind": "document",
            "mimeType": "text/plain",
            "content": "authenticated on use",
        },
    )
    runtime.handle("content_protection.set", {"mode": "encrypted"})
    finalized = RuntimeService.from_profile_root(tmp_path, master_key=b"p" * 32)
    object_path = next(finalized.objects.root.rglob("*.cupobj"))
    finalized.close()
    payload = bytearray(object_path.read_bytes())
    payload[-1] ^= 0x80
    object_path.write_bytes(payload)

    reopened = RuntimeService.from_profile_root(tmp_path, master_key=b"p" * 32)
    with pytest.raises(ObjectCorruptionError, match="authentication failed"):
        reopened.handle(
            "artifacts.get",
            {
                "artifactId": artifact["artifact"]["id"],
                "projectId": project["id"],
            },
        )
    reopened.close()
