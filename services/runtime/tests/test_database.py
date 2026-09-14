import sqlite3
from pathlib import Path

import pytest

from cupcake_runtime.storage.database import Database, DatabaseConfig
from cupcake_runtime.storage.migrations import LATEST_SCHEMA_VERSION, MIGRATIONS


def test_database_migrates_enables_wal_and_passes_integrity(database: Database) -> None:
    assert database.schema_version == LATEST_SCHEMA_VERSION
    assert database.connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert database.connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert database.integrity_check() == ("ok",)


def test_nested_transaction_uses_savepoint(database: Database) -> None:
    with database.transaction() as connection:
        connection.execute("INSERT INTO settings VALUES ('outside', '1', '2026-01-01T00:00:00Z')")
        with pytest.raises(RuntimeError), database.transaction() as nested:
            nested.execute("INSERT INTO settings VALUES ('inside', '2', '2026-01-01T00:00:00Z')")
            raise RuntimeError("rollback inner")
    keys = [row[0] for row in database.connection.execute("SELECT key FROM settings")]
    assert keys == ["outside"]


def test_sqlcipher_is_required_by_default(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="encryption key"):
        DatabaseConfig(path=tmp_path / "unsafe.sqlite")


def test_database_backup_is_consistent(database: Database, tmp_path: Path) -> None:
    database.connection.execute(
        "INSERT INTO settings VALUES ('theme', '\"dark\"', '2026-01-01T00:00:00Z')"
    )
    database.connection.commit()
    snapshot = tmp_path / "snapshot.sqlite"
    database.backup_to(snapshot)
    restored = Database(DatabaseConfig(path=snapshot, require_sqlcipher=False))
    try:
        assert (
            restored.connection.execute(
                "SELECT value_json FROM settings WHERE key='theme'"
            ).fetchone()[0]
            == '"dark"'
        )
    finally:
        restored.close()


def test_v2_pending_legacy_tasks_upgrade_to_paused(tmp_path: Path) -> None:
    path = tmp_path / "v2.sqlite"
    connection = sqlite3.connect(path)
    connection.execute(
        "CREATE TABLE schema_migrations ("
        "version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL"
        ") STRICT"
    )
    for migration in MIGRATIONS[:2]:
        connection.executescript(migration.sql)
        connection.execute(
            "INSERT INTO schema_migrations VALUES (?, ?, '2026-09-05T00:00:00Z')",
            (migration.version, migration.description),
        )
    connection.execute(
        "INSERT INTO legacy_migrations VALUES (?, 1, ?, 'imported', '{}', ?)",
        ("migration", "a" * 64, "2026-09-05T00:00:00Z"),
    )
    connection.execute(
        "INSERT INTO legacy_tasks VALUES (?, ?, ?, 'pending', NULL, '{}', ?, ?)",
        (
            "task",
            "migration",
            "Recovered task",
            "2026-09-05T00:00:00Z",
            "2026-09-05T00:00:00Z",
        ),
    )
    connection.commit()
    connection.close()

    upgraded = Database(DatabaseConfig(path=path, require_sqlcipher=False))
    try:
        assert upgraded.schema_version == LATEST_SCHEMA_VERSION
        assert (
            upgraded.connection.execute("SELECT status FROM legacy_tasks").fetchone()[0] == "paused"
        )
    finally:
        upgraded.close()


def test_v5_custom_persona_upgrade_preserves_profile_owned_fields(tmp_path: Path) -> None:
    path = tmp_path / "v5.sqlite"
    connection = sqlite3.connect(path)
    connection.execute(
        "CREATE TABLE schema_migrations ("
        "version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL"
        ") STRICT"
    )
    for migration in MIGRATIONS[:5]:
        connection.executescript(migration.sql)
        connection.execute(
            "INSERT INTO schema_migrations VALUES (?, ?, '2026-09-05T00:00:00Z')",
            (migration.version, migration.description),
        )
    connection.execute(
        """INSERT INTO personas(
            id,name,handle,avatar,role,description,instructions,speak_when,
            personality_json,model_id,created_at,updated_at,archived_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)""",
        (
            "custom-persona",
            "My helper",
            "helper",
            "atlas:1",
            "Personal role",
            "Personal description",
            "Personal instructions",
            "Only when I ask",
            '{"preset":"balanced","warmth":0.5,"brevity":0.5,"initiative":0.5}',
            "mock:cupcake-deterministic",
            "2026-09-05T00:00:00Z",
            "2026-09-05T00:00:00Z",
        ),
    )
    connection.commit()
    connection.close()

    upgraded = Database(DatabaseConfig(path=path, require_sqlcipher=False))
    try:
        row = upgraded.connection.execute(
            "SELECT name,handle,instructions,catalog_key,catalog_position "
            "FROM personas WHERE id='custom-persona'"
        ).fetchone()
        assert tuple(row) == (
            "My helper",
            "helper",
            "Personal instructions",
            None,
            None,
        )
        assert upgraded.schema_version == LATEST_SCHEMA_VERSION
    finally:
        upgraded.close()
