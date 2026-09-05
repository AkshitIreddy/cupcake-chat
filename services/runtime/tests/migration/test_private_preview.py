from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from cupcake_runtime.application import RuntimeCommandError, RuntimeService


def _runtime(root: Path) -> RuntimeService:
    return RuntimeService(root, master_key=b"m" * 32, require_sqlcipher=False)


def _staged_source(
    root: Path, staging_id: str = "018f1e2d-3c4b-7a69-8def-0123456789ab"
) -> tuple[Path, Path, str]:
    staging = root / "broker-migration" / staging_id
    source = staging / "source"
    state = source / "state_of_mind"
    state.mkdir(parents=True)
    (state / "conversation.json").write_text(
        json.dumps({"conversation": [{"sender": "human", "message": "hello"}]}),
        encoding="utf-8",
    )
    manifest = staging / "manifest.json"
    manifest.write_text(
        json.dumps({"version": 1, "stagingId": staging_id, "entries": []}),
        encoding="utf-8",
    )
    digest = hashlib.sha256(manifest.read_bytes()).hexdigest()
    return source, manifest, digest


def test_private_preview_accepts_broker_staging_contract(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path)
    source, manifest, digest = _staged_source(tmp_path)

    result, events = runtime.handle(
        "migration.preview.private",
        {
            "snapshotPath": str(source),
            "manifestPath": str(manifest),
            "manifestSha256": digest,
            "stagingToken": source.parent.name,
        },
    )

    assert events == []
    assert result["state"] == "previewed"
    assert result["report"]["conversations"] == 1
    runtime.close()


def test_private_preview_rejects_manifest_outside_staging_session(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path)
    source, _manifest, _digest = _staged_source(tmp_path)
    outside = tmp_path / "outside-manifest.json"
    outside.write_text("{}", encoding="utf-8")

    with pytest.raises(RuntimeCommandError) as denied:
        runtime.handle(
            "migration.preview.private",
            {
                "snapshotPath": str(source),
                "manifestPath": str(outside),
                "manifestSha256": hashlib.sha256(outside.read_bytes()).hexdigest(),
                "stagingToken": source.parent.name,
            },
        )

    assert denied.value.code == "MIGRATION_SOURCE_DENIED"
    runtime.close()
