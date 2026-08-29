"""Append-only SQLite event journal with deterministic idempotency."""

from __future__ import annotations

import hashlib
import sqlite3
from collections.abc import Iterable
from dataclasses import replace
from threading import RLock
from typing import Protocol

from .models import RunEvent


class EventConflictError(RuntimeError):
    """Raised when an idempotency key is reused for different event content."""


class EventJournal(Protocol):
    def append(self, event: RunEvent) -> bool: ...
    def append_next(self, event: RunEvent) -> RunEvent: ...
    def read(self, run_id: str, *, after_sequence: int = 0) -> list[RunEvent]: ...
    def next_sequence(self, run_id: str) -> int: ...


def deterministic_event_id(run_id: str, dedupe_key: str) -> str:
    digest = hashlib.sha256(f"{run_id}\0{dedupe_key}".encode()).hexdigest()
    return f"evt_{digest[:32]}"


class SqliteEventJournal:
    """A transactional event journal.

    Re-appending byte-equivalent events is a successful no-op. Reusing either an
    event id or a `(run_id, sequence)` slot for different content is a conflict.
    """

    def __init__(self, database: str | sqlite3.Connection) -> None:
        if isinstance(database, str):
            self._connection = sqlite3.connect(database, check_same_thread=False)
            self._connection.row_factory = sqlite3.Row
            self._owns_connection = True
        else:
            self._connection = database
            self._owns_connection = False
        self._lock = RLock()
        self._configure()

    def _configure(self) -> None:
        with self._connection:
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA foreign_keys=ON")
            self._connection.execute("PRAGMA busy_timeout=5000")
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS run_events (
                    event_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    task_id TEXT,
                    parent_run_id TEXT,
                    sequence INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    schema_version INTEGER NOT NULL,
                    UNIQUE(run_id, sequence)
                )
                """
            )
            self._connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_run_events_run_sequence "
                "ON run_events(run_id, sequence)"
            )

    @staticmethod
    def _same_semantic_event(existing: sqlite3.Row, event: RunEvent) -> bool:
        candidate = event.to_record()
        # Sequence and timestamp are journal-assigned presentation details.  A
        # deterministic event id represents the semantic idempotency key.
        keys = (
            "event_id",
            "run_id",
            "task_id",
            "parent_run_id",
            "kind",
            "payload",
            "schema_version",
        )
        return all(existing[key] == candidate[key] for key in keys)

    def append(self, event: RunEvent) -> bool:
        return self.append_many([event]) == 1

    def append_next(self, event: RunEvent) -> RunEvent:
        """Atomically allocate a run sequence and append an event.

        Callers set any placeholder sequence. The lock covers allocation and
        insertion so task, approval and delegate events can share one run safely.
        """
        with self._lock:
            existing = self._connection.execute(
                "SELECT * FROM run_events WHERE event_id=?", (event.event_id,)
            ).fetchone()
            if existing is not None:
                if not self._same_semantic_event(existing, event):
                    raise EventConflictError(
                        f"event id already contains different content: {event.event_id}"
                    )
                return RunEvent.from_record(existing)
            assigned = replace(event, sequence=self.next_sequence(event.run_id))
            self.append(assigned)
            return assigned

    def append_many(self, events: Iterable[RunEvent]) -> int:
        inserted = 0
        with self._lock, self._connection:
            for event in events:
                record = event.to_record()
                existing_id = self._connection.execute(
                    "SELECT * FROM run_events WHERE event_id=?",
                    (event.event_id,),
                ).fetchone()
                if existing_id is not None:
                    if not self._same_semantic_event(existing_id, event):
                        raise EventConflictError(
                            f"event id already contains different content: {event.event_id}"
                        )
                    continue
                existing_slot = self._connection.execute(
                    "SELECT event_id FROM run_events WHERE run_id=? AND sequence=?",
                    (event.run_id, event.sequence),
                ).fetchone()
                if existing_slot is not None:
                    raise EventConflictError(
                        f"event sequence already occupied: {event.run_id}/{event.sequence}"
                    )
                self._connection.execute(
                    """
                    INSERT INTO run_events (
                        event_id, run_id, task_id, parent_run_id, sequence, kind,
                        payload, created_at, schema_version
                    ) VALUES (
                        :event_id, :run_id, :task_id, :parent_run_id, :sequence, :kind,
                        :payload, :created_at, :schema_version
                    )
                    """,
                    record,
                )
                inserted += 1
        return inserted

    def read(self, run_id: str, *, after_sequence: int = 0) -> list[RunEvent]:
        rows = self._connection.execute(
            "SELECT * FROM run_events WHERE run_id=? AND sequence>? ORDER BY sequence",
            (run_id, after_sequence),
        ).fetchall()
        return [RunEvent.from_record(row) for row in rows]

    def next_sequence(self, run_id: str) -> int:
        row = self._connection.execute(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM run_events WHERE run_id=?",
            (run_id,),
        ).fetchone()
        return int(row["value"])

    def close(self) -> None:
        if self._owns_connection:
            self._connection.close()
