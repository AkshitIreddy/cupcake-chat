from __future__ import annotations

import contextlib
import importlib
import sqlite3
import threading
from collections.abc import Generator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, cast

from cupcake_runtime.storage.migrations import LATEST_SCHEMA_VERSION, MIGRATIONS


class ConnectionFactory(Protocol):
    def connect(self, database: str, **kwargs: Any) -> sqlite3.Connection: ...


@dataclass(frozen=True, slots=True)
class DatabaseConfig:
    path: Path
    encryption_key: bytes | None = None
    require_sqlcipher: bool = True
    busy_timeout_ms: int = 5_000

    def __post_init__(self) -> None:
        if self.require_sqlcipher and not self.encryption_key:
            raise ValueError("an encryption key is required when require_sqlcipher=True")
        if self.encryption_key is not None and len(self.encryption_key) < 32:
            raise ValueError("database encryption key must contain at least 32 bytes")
        if self.busy_timeout_ms < 0:
            raise ValueError("busy_timeout_ms cannot be negative")


class Database:
    """Owned SQLite connection with transactional migrations and serialized writes."""

    def __init__(self, config: DatabaseConfig) -> None:
        self.config = config
        self.config.path.parent.mkdir(parents=True, exist_ok=True)
        module = self._driver()
        self._module = module
        self._connection = module.connect(
            str(config.path),
            timeout=config.busy_timeout_ms / 1000,
            check_same_thread=False,
        )
        # sqlcipher3 ships its own DB-API cursor/Row implementation; mixing it
        # with ``sqlite3.Row`` raises at fetch time on Windows.
        self._connection.row_factory = getattr(module, "Row", sqlite3.Row)
        self._lock = threading.RLock()
        self._transaction_depth = 0
        self._configure()
        self._migrate()

    def _driver(self) -> ConnectionFactory:
        if not self.config.require_sqlcipher:
            return cast(ConnectionFactory, sqlite3)
        try:
            return cast(ConnectionFactory, importlib.import_module("sqlcipher3"))
        except ImportError as exc:
            raise RuntimeError(
                "SQLCipher is required but unavailable; install cupcake-runtime[sqlcipher]"
            ) from exc

    def _configure(self) -> None:
        with self._lock:
            if self.config.encryption_key:
                key_hex = self.config.encryption_key.hex()
                self._connection.execute(f"PRAGMA key = \"x'{key_hex}'\"")
                if self.config.require_sqlcipher:
                    version = self._connection.execute("PRAGMA cipher_version").fetchone()
                    if not version or not version[0]:
                        raise RuntimeError("database driver did not activate SQLCipher")
            self._connection.execute("PRAGMA foreign_keys = ON")
            self._connection.execute(f"PRAGMA busy_timeout = {self.config.busy_timeout_ms}")
            self._connection.execute("PRAGMA journal_mode = WAL")
            self._connection.execute("PRAGMA synchronous = FULL")
            self._connection.execute("PRAGMA trusted_schema = OFF")
            self._connection.execute("PRAGMA temp_store = MEMORY")

    def _migrate(self) -> None:
        with self.transaction() as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                "version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL"
                ") STRICT"
            )
            rows = connection.execute("SELECT version FROM schema_migrations").fetchall()
            applied = {int(row[0]) for row in rows}
            unknown = applied - {migration.version for migration in MIGRATIONS}
            if unknown:
                raise RuntimeError(
                    f"database contains unknown migration versions: {sorted(unknown)}"
                )
            for migration in MIGRATIONS:
                if migration.version in applied:
                    continue
                # executescript commits implicitly, so statements are executed one at a time
                # inside our explicit outer transaction.
                for statement in _split_sql_script(migration.sql):
                    connection.execute(statement)
                connection.execute(
                    "INSERT INTO schema_migrations(version, description, applied_at) "
                    "VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                    (migration.version, migration.description),
                )
            current = connection.execute("PRAGMA user_version").fetchone()[0]
            if current > LATEST_SCHEMA_VERSION:
                raise RuntimeError(
                    f"database schema {current} is newer than supported {LATEST_SCHEMA_VERSION}"
                )
            connection.execute(f"PRAGMA user_version = {LATEST_SCHEMA_VERSION}")

    @contextlib.contextmanager
    def transaction(self, *, immediate: bool = True) -> Generator[sqlite3.Connection, None, None]:
        with self._lock:
            outermost = self._transaction_depth == 0
            savepoint = f"cupcake_nested_{self._transaction_depth}"
            try:
                if outermost:
                    self._connection.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
                else:
                    self._connection.execute(f"SAVEPOINT {savepoint}")
                self._transaction_depth += 1
                yield self._connection
                self._transaction_depth -= 1
                if outermost:
                    self._connection.commit()
                else:
                    self._connection.execute(f"RELEASE SAVEPOINT {savepoint}")
            except BaseException:
                self._transaction_depth = max(0, self._transaction_depth - 1)
                if outermost:
                    self._connection.rollback()
                else:
                    self._connection.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                    self._connection.execute(f"RELEASE SAVEPOINT {savepoint}")
                raise

    @property
    def connection(self) -> sqlite3.Connection:
        return self._connection

    @property
    def schema_version(self) -> int:
        with self._lock:
            return int(self._connection.execute("PRAGMA user_version").fetchone()[0])

    def integrity_check(self) -> tuple[str, ...]:
        with self._lock:
            return tuple(str(row[0]) for row in self._connection.execute("PRAGMA integrity_check"))

    def checkpoint(self) -> None:
        with self._lock:
            if self._transaction_depth:
                raise RuntimeError("cannot checkpoint during an active transaction")
            self._connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def backup_to(self, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            target = self._module.connect(
                str(destination),
                timeout=self.config.busy_timeout_ms / 1000,
                check_same_thread=False,
            )
            try:
                if self.config.encryption_key:
                    key_hex = self.config.encryption_key.hex()
                    target.execute(f"PRAGMA key = \"x'{key_hex}'\"")
                self._connection.backup(target)
            finally:
                target.close()

    def close(self) -> None:
        with self._lock:
            if self._transaction_depth:
                raise RuntimeError("cannot close database during an active transaction")
            self._connection.close()

    def __enter__(self) -> Database:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def _split_sql_script(script: str) -> tuple[str, ...]:
    """Split a migration while preserving trigger bodies."""
    statements: list[str] = []
    buffer: list[str] = []
    in_trigger = False
    for line in script.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.upper().startswith("CREATE TRIGGER"):
            in_trigger = True
        buffer.append(line)
        if in_trigger:
            if stripped.upper() == "END;":
                statements.append("\n".join(buffer))
                buffer = []
                in_trigger = False
        elif stripped.endswith(";"):
            statements.append("\n".join(buffer))
            buffer = []
    if buffer:
        statements.append("\n".join(buffer))
    return tuple(statements)
