from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from cupcake_runtime.migration import InMemoryMigrationSink, LegacyImporter


def make_legacy(tmp_path: Path) -> Path:
    root = tmp_path / "legacy"
    state = root / "state_of_mind"
    state.mkdir(parents=True)
    (root / ".env").write_text("OPENAI_API_KEY=must-never-appear")
    (state / "conversation.json").write_text(
        json.dumps(
            {
                "conversation": [
                    {"sender": "Summary", "message": "Earlier context", "file_upload": "none"},
                    {"sender": "human", "message": "Hello", "file_upload": "/outside/private.txt"},
                    {"sender": "assistant", "message": "Hi", "file_upload": "none"},
                ]
            }
        )
    )
    (state / "task_list.json").write_text(
        json.dumps({"tasks": [{"id": 7, "task": "Bake", "task_created_time": "2023-01-01"}]})
    )
    (state / "personality.txt").write_text("Curious and helpful")
    (state / "thought_bubble.txt").write_text("[['space', 'nature'], ['mystery']]")
    for name, value in {
        "happiness": "0.8",
        "sadness": "bad",
        "anger": "0",
        "fear": "0.2",
        "creativity": "1.1",
        "curiosity": "0.9",
    }.items():
        (state / f"{name}.txt").write_text(value)
    for name in ("smell", "taste", "touch"):
        (state / f"{name}.txt").write_text("NOT ACTIVATED")
    return root


def add_chroma(root: Path) -> None:
    memory = root / "memory"
    memory.mkdir()
    database = memory / "chroma.sqlite3"
    connection = sqlite3.connect(database)
    connection.execute("CREATE TABLE documents (document TEXT)")
    connection.execute(
        "INSERT INTO documents(document) VALUES (?)", ("A summarized legacy memory",)
    )
    connection.commit()
    connection.close()
    (memory / "documents.json").write_text(
        json.dumps({"documents": ["Another memory", "A summarized legacy memory"]})
    )


def test_imports_all_allowlisted_state_and_is_idempotent(tmp_path: Path) -> None:
    root = make_legacy(tmp_path)
    add_chroma(root)
    sink = InMemoryMigrationSink()
    importer = LegacyImporter(root, sink)
    report, records = importer.import_once()
    assert report.status == "imported"
    assert {record.kind for record in records} == {
        "conversation_message",
        "task",
        "personality",
        "thought",
        "emotion",
        "sense",
        "chroma_text",
    }
    assert report.counts["chroma_text"] == 2
    assert report.to_dict()["conversations"] == 1
    assert report.to_dict()["messages"] == 3
    assert report.to_dict()["memories"] == 6
    assert report.to_dict()["tasks"] == 1
    assert ".env" in report.ignored_secret_files
    serialized = json.dumps([record.payload for record in records])
    assert "must-never-appear" not in serialized
    assert "/outside/private.txt" in serialized
    assert "private file contents" not in serialized

    repeated, repeated_records = importer.import_once()
    assert repeated.status == "already_imported"
    assert repeated.migration_id == report.migration_id
    assert repeated_records == ()
    assert len(sink.reports) == 1


def test_secret_files_do_not_affect_source_fingerprint(tmp_path: Path) -> None:
    root = make_legacy(tmp_path)
    importer = LegacyImporter(root, InMemoryMigrationSink())
    first, _ = importer.import_once(dry_run=True)
    (root / ".env").write_text("OPENAI_API_KEY=a-completely-different-secret")
    second, records = importer.import_once(dry_run=True)
    assert second.source_fingerprint == first.source_fingerprint
    assert "a-completely-different-secret" not in json.dumps([record.payload for record in records])


def test_credentials_generated_code_and_bytecode_are_never_read_or_fingerprinted(
    tmp_path: Path,
) -> None:
    root = make_legacy(tmp_path)
    memory = root / "memory"
    memory.mkdir()
    (memory / "documents.json").write_text(json.dumps({"documents": ["safe memory"]}))
    secret = memory / "api_keys.json"
    script = memory / "rebuild_memory.py"
    bytecode = memory / "rebuild_memory.pyc"
    generated = memory / "generated"
    generated.mkdir()
    generated_document = generated / "documents.json"
    secret.write_text(json.dumps({"api_key": "credential-canary-one"}))
    script.write_text("TOKEN = 'script-canary-one'")
    bytecode.write_bytes(b"bytecode-canary-one")
    generated_document.write_text(json.dumps({"documents": ["generated-canary-one"]}))

    importer = LegacyImporter(root, InMemoryMigrationSink())
    first, records = importer.import_once(dry_run=True)
    serialized = json.dumps([record.payload for record in records])
    assert "safe memory" in serialized
    assert "credential-canary-one" not in serialized
    assert "script-canary-one" not in serialized
    assert "bytecode-canary-one" not in serialized
    assert "generated-canary-one" not in serialized

    secret.write_text(json.dumps({"api_key": "credential-canary-two"}))
    script.write_text("TOKEN = 'script-canary-two'")
    bytecode.write_bytes(b"bytecode-canary-two")
    generated_document.write_text(json.dumps({"documents": ["generated-canary-two"]}))
    second, second_records = importer.import_once(dry_run=True)
    assert second.source_fingerprint == first.source_fingerprint
    assert "canary-two" not in json.dumps([record.payload for record in second_records])


def test_credential_values_inside_allowlisted_text_are_omitted_from_records_and_fingerprint(
    tmp_path: Path,
) -> None:
    root = make_legacy(tmp_path)
    conversation = root / "state_of_mind" / "conversation.json"
    first_key = "sk-firstcredentialvalue000000000000"
    second_key = "sk-secondcredentialvalue00000000000"
    conversation.write_text(
        json.dumps(
            {
                "conversation": [
                    {
                        "sender": "human",
                        "message": f"OPENAI_API_KEY={first_key}",
                    }
                ]
            }
        )
    )
    importer = LegacyImporter(root, InMemoryMigrationSink())
    first, records = importer.import_once(dry_run=True)
    serialized = json.dumps([record.payload for record in records])
    assert first_key not in serialized
    assert "[legacy credential omitted]" in serialized

    conversation.write_text(
        json.dumps(
            {
                "conversation": [
                    {
                        "sender": "human",
                        "message": f"OPENAI_API_KEY={second_key}",
                    }
                ]
            }
        )
    )
    second, second_records = importer.import_once(dry_run=True)
    assert second.source_fingerprint == first.source_fingerprint
    assert second_key not in json.dumps([record.payload for record in second_records])


def test_nvidia_key_shape_inside_legacy_text_is_omitted(tmp_path: Path) -> None:
    root = make_legacy(tmp_path)
    canary = "nvapi-synthetic-legacy-canary-1234567890"
    (root / "state_of_mind" / "personality.txt").write_text(
        f"Never persist {canary}", encoding="utf-8"
    )
    _, records = LegacyImporter(root, InMemoryMigrationSink()).import_once(dry_run=True)
    serialized = json.dumps([record.payload for record in records])

    assert canary not in serialized
    assert "[legacy credential omitted]" in serialized


def test_malformed_and_symlinked_sources_are_not_followed(tmp_path: Path) -> None:
    root = make_legacy(tmp_path)
    (root / "state_of_mind" / "conversation.json").write_text("not json")
    memory = root / "memory"
    memory.mkdir()
    outside = tmp_path / "outside.json"
    outside.write_text(json.dumps({"documents": ["exfiltrated"]}))
    (memory / "escape.json").symlink_to(outside)
    report, records = LegacyImporter(root, InMemoryMigrationSink()).import_once(dry_run=True)
    assert report.status == "dry_run"
    assert any("invalid JSON" in warning for warning in report.warnings)
    assert any("symlink" in warning for warning in report.warnings)
    assert "exfiltrated" not in json.dumps([record.payload for record in records])


def test_representative_v1_layout_dry_run_after_active_v1_removal(tmp_path: Path) -> None:
    root = make_legacy(tmp_path)
    report, records = LegacyImporter(root, InMemoryMigrationSink()).import_once(dry_run=True)
    assert report.status == "dry_run"
    assert report.counts["personality"] == 1
    assert report.counts["emotion"] == 6
    assert ".env" in report.ignored_secret_files
    assert records
