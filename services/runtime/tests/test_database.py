from pathlib import Path

import pytest

from cupcake_runtime.storage.database import Database, DatabaseConfig
from cupcake_runtime.storage.migrations import LATEST_SCHEMA_VERSION


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
