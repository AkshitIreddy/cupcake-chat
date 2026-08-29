from __future__ import annotations

import json
from importlib.util import find_spec
from pathlib import Path

import pytest

from cupcake_runtime.migration import (
    IMPORTER_VERSION,
    LegacyMigrationService,
    LegacyRecord,
    MigrationReport,
    ProductMigrationSink,
)
from cupcake_runtime.storage import Database, DatabaseConfig


def _database(path: Path) -> Database:
    return Database(DatabaseConfig(path=path, require_sqlcipher=False))


def _legacy_tree(root: Path) -> Path:
    state = root / "state_of_mind"
    state.mkdir(parents=True)
    (root / ".env").write_text("COHERE_API_KEY=never-import-this", encoding="utf-8")
    (state / "conversation.json").write_text(
        json.dumps(
            {
                "conversation": [
                    {"sender": "Summary", "message": "Earlier context"},
                    {"sender": "human", "message": "Please remember the plan"},
                    {"sender": "assistant", "message": "I will."},
                ]
            }
        ),
        encoding="utf-8",
    )
    (state / "task_list.json").write_text(
        json.dumps(
            {"tasks": [{"id": 3, "task": "Finish the frosting", "task_created_time": "2023-01-02"}]}
        ),
        encoding="utf-8",
    )
    (state / "personality.txt").write_text("Curious and kind", encoding="utf-8")
    (state / "thought_bubble.txt").write_text("['quiet thought']", encoding="utf-8")
    (state / "smell.txt").write_text("vanilla", encoding="utf-8")
    return root


def test_product_sink_commits_authoritative_entities_and_survives_restart(
    tmp_path: Path,
) -> None:
    legacy = _legacy_tree(tmp_path / "legacy")
    database_path = tmp_path / "cupcake.db"
    database = _database(database_path)
    sink = ProductMigrationSink(database)

    state = LegacyMigrationService(legacy, sink).execute()
    assert state.state == "imported"
    assert state.report is not None
    assert state.report.ignored_secret_files == (".env",)
    assert database.connection.execute("SELECT count(*) FROM conversations").fetchone()[0] == 1
    assert database.connection.execute("SELECT count(*) FROM messages").fetchone()[0] == 3
    assert database.connection.execute("SELECT count(*) FROM legacy_tasks").fetchone()[0] == 1
    assert database.connection.execute("SELECT count(*) FROM memories").fetchone()[0] == 4
    assert (
        database.connection.execute(
            "SELECT count(*) FROM memories WHERE kind='task_state' AND state='active'"
        ).fetchone()[0]
        == 1
    )
    assert (
        database.connection.execute(
            "SELECT count(*) FROM memories WHERE kind='instruction' AND state='active'"
        ).fetchone()[0]
        == 1
    )
    assert (
        database.connection.execute(
            "SELECT count(*) FROM search_documents WHERE entity_type='task'"
        ).fetchone()[0]
        == 1
    )
    persisted = sink.get_migration(state.report.migration_id)
    assert persisted is not None
    assert persisted.importer_version == IMPORTER_VERSION
    assert persisted.report["source_fingerprint"] == state.source_fingerprint
    assert sink.list_recovered_tasks()[0]["title"] == "Finish the frosting"
    sink.close()
    database.close()

    restarted_database = _database(database_path)
    restarted_sink = ProductMigrationSink(restarted_database)
    restarted = LegacyMigrationService(legacy, restarted_sink).execute()
    assert restarted.state == "imported"
    assert restarted.report is not None and restarted.report.status == "already_imported"
    assert (
        restarted_database.connection.execute("SELECT count(*) FROM conversations").fetchone()[0]
        == 1
    )
    assert restarted_database.connection.execute("SELECT count(*) FROM messages").fetchone()[0] == 3
    assert (
        restarted_database.connection.execute("SELECT count(*) FROM legacy_tasks").fetchone()[0]
        == 1
    )
    assert restarted_database.connection.execute("SELECT count(*) FROM memories").fetchone()[0] == 4
    restarted_sink.close()
    restarted_database.close()


def test_first_run_preview_decline_and_execute_states_are_persistent(tmp_path: Path) -> None:
    legacy = _legacy_tree(tmp_path / "legacy")
    database = _database(tmp_path / "cupcake.db")
    sink = ProductMigrationSink(database)
    service = LegacyMigrationService(legacy, sink)

    assert service.detect().state == "available"
    preview = service.preview()
    assert preview.state == "previewed"
    assert preview.report is not None and preview.report.status == "dry_run"
    assert service.detect().state == "previewed"
    assert service.decline().state == "declined"
    assert service.detect().state == "declined"

    restarted_sink = ProductMigrationSink(database)
    restarted_service = LegacyMigrationService(legacy, restarted_sink)
    assert restarted_service.detect().state == "declined"
    assert restarted_service.execute().state == "imported"
    assert restarted_service.detect().state == "imported"
    assert sink.decision_for(preview.source_fingerprint or "") is None
    restarted_sink.close()
    sink.close()
    database.close()


def test_missing_or_symlinked_legacy_root_is_not_detected(tmp_path: Path) -> None:
    database = _database(tmp_path / "cupcake.db")
    sink = ProductMigrationSink(database)
    assert LegacyMigrationService(tmp_path / "missing", sink).detect().state == "not_found"
    real = _legacy_tree(tmp_path / "real")
    alias = tmp_path / "alias"
    alias.symlink_to(real, target_is_directory=True)
    assert LegacyMigrationService(alias, sink).detect().state == "not_found"
    with pytest.raises(FileNotFoundError):
        LegacyMigrationService(alias, sink).preview()
    sink.close()
    database.close()


def test_empty_legacy_state_is_recorded_once_as_no_data(tmp_path: Path) -> None:
    legacy = tmp_path / "legacy"
    (legacy / "state_of_mind").mkdir(parents=True)
    database = _database(tmp_path / "cupcake.db")
    sink = ProductMigrationSink(database)
    service = LegacyMigrationService(legacy, sink)
    assert service.detect().state == "available"
    first = service.execute()
    assert first.state == "no_data"
    assert first.report is not None and first.report.total_records == 0
    assert service.detect().state == "no_data"
    repeated = service.execute()
    assert repeated.state == "no_data"
    assert repeated.report is not None and repeated.report.status == "already_imported"
    assert database.connection.execute("SELECT count(*) FROM legacy_migrations").fetchone()[0] == 1
    sink.close()
    database.close()


@pytest.mark.skipif(find_spec("sqlcipher3") is None, reason="SQLCipher extra unavailable")
def test_product_sink_uses_encrypted_profile_database(tmp_path: Path) -> None:
    legacy = _legacy_tree(tmp_path / "legacy")
    database = Database(
        DatabaseConfig(
            path=tmp_path / "cupcake.db",
            encryption_key=b"m" * 32,
            require_sqlcipher=True,
        )
    )
    sink = ProductMigrationSink(database)
    assert LegacyMigrationService(legacy, sink).execute().state == "imported"
    assert database.integrity_check() == ("ok",)
    assert sink.list_recovered_tasks()[0]["status"] == "pending"
    sink.close()
    database.close()


def test_sink_rolls_back_all_product_rows_when_projection_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = _database(tmp_path / "cupcake.db")
    sink = ProductMigrationSink(database)
    records = (
        LegacyRecord(
            "message-record",
            "conversation_message",
            "state_of_mind/conversation.json",
            {"role": "user", "content": "hello"},
        ),
        LegacyRecord(
            "memory-record",
            "personality",
            "state_of_mind/personality.txt",
            {"content": "friendly"},
        ),
    )
    report = MigrationReport(
        "migration-id",
        "a" * 64,
        "imported",
        {"conversation_message": 1, "personality": 1},
    )

    def fail_projection(*args: object, **kwargs: object) -> str:
        raise RuntimeError("simulated projection failure")

    monkeypatch.setattr(ProductMigrationSink, "_insert_memory", fail_projection)
    with pytest.raises(RuntimeError, match="simulated projection failure"):
        sink.apply_migration(report, records)
    for table in (
        "legacy_migrations",
        "legacy_migration_records",
        "conversations",
        "conversation_branches",
        "messages",
        "memories",
        "search_documents",
    ):
        assert database.connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0
    sink.close()
    database.close()


def test_sink_rejects_unsafe_source_locators_before_writing(tmp_path: Path) -> None:
    database = _database(tmp_path / "cupcake.db")
    sink = ProductMigrationSink(database)
    report = MigrationReport("migration-id", "b" * 64, "imported", {"personality": 1})
    record = LegacyRecord(
        "record-id", "personality", "generated/credentials.json", {"content": "canary"}
    )
    with pytest.raises(ValueError, match="unsafe source locator"):
        sink.apply_migration(report, (record,))
    assert not sink.contains_migration(report.migration_id)
    sink.close()
    database.close()
