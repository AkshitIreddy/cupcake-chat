from __future__ import annotations

import json
import sqlite3
import threading
import time
import unicodedata
import uuid
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from .models import (
    Evidence,
    MemoryKind,
    MemoryQuery,
    MemoryRecord,
    MemoryScope,
    MemoryState,
    MemorySuggestion,
    MemoryUsage,
    ScopeKind,
    SuggestionKind,
    ensure_utc,
)


def _uuid7() -> str:
    """Return a sortable UUIDv7-shaped identifier without external dependencies."""
    timestamp_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    random_bits = uuid.uuid4().int & ((1 << 74) - 1)
    value = timestamp_ms << 80
    value |= 0x7 << 76
    value |= ((random_bits >> 62) & 0xFFF) << 64
    value |= 0b10 << 62
    value |= random_bits & ((1 << 62) - 1)
    return str(uuid.UUID(int=value))


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime | None) -> str | None:
    value = ensure_utc(value)
    return value.isoformat() if value else None


def _dt(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value).astimezone(UTC) if value else None


def _required_dt(value: str | None) -> datetime:
    parsed = _dt(value)
    if parsed is None:
        raise RuntimeError("memory row is missing a required timestamp")
    return parsed


def _normalize_key(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).strip().casefold()
    if not normalized:
        raise ValueError("memory key must not be empty")
    if len(normalized) > 256:
        raise ValueError("memory key exceeds 256 characters")
    return normalized


class MemoryStore:
    """Versioned memory storage with explicit lifecycle and scope boundaries.

    Lifecycle rows are retained for auditability. Forgetting inserts a tombstone and
    transitions older values to ``forgotten`` so a later importer cannot silently
    resurrect them.
    """

    def __init__(self, database: str | Path | sqlite3.Connection = ":memory:") -> None:
        if isinstance(database, (str, Path)):
            self._connection = sqlite3.connect(str(database), check_same_thread=False)
            self._owns_connection = True
            self._connection.row_factory = sqlite3.Row
        else:
            # SQLCipher exposes the same DB-API surface through a distinct
            # connection class; preserve its driver-specific Row factory.
            self._connection = cast(sqlite3.Connection, database)
            self._owns_connection = False
        self._lock = threading.RLock()
        with self._transaction() as connection:
            connection.executescript(_SCHEMA)

    def close(self) -> None:
        if self._owns_connection:
            self._connection.close()

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            try:
                self._connection.execute("BEGIN IMMEDIATE")
                yield self._connection
            except BaseException:
                self._connection.rollback()
                raise
            else:
                self._connection.commit()

    def remember(
        self,
        *,
        key: str,
        content: str,
        kind: MemoryKind,
        scope: MemoryScope,
        evidence: Sequence[Evidence] = (),
        confidence: float = 1.0,
        sensitive: bool = False,
        explicit: bool = True,
        expires_at: datetime | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> MemoryRecord:
        if not content.strip():
            raise ValueError("memory content must not be empty")
        if not 0 <= confidence <= 1:
            raise ValueError("confidence must be between 0 and 1")
        expires_at = ensure_utc(expires_at)
        state = MemoryState.ACTIVE if explicit and not sensitive else MemoryState.CANDIDATE
        return self._insert_version(
            key=key,
            content=content,
            kind=kind,
            scope=scope,
            evidence=evidence,
            confidence=confidence,
            sensitive=sensitive,
            explicit=explicit,
            expires_at=expires_at,
            state=state,
            metadata=metadata or {},
            supersede=state is MemoryState.ACTIVE,
        )

    def propose(
        self,
        *,
        key: str,
        content: str,
        kind: MemoryKind,
        scope: MemoryScope,
        evidence: Sequence[Evidence] = (),
        confidence: float = 0.5,
        sensitive: bool = False,
        expires_at: datetime | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> MemoryRecord:
        return self._insert_version(
            key=key,
            content=content,
            kind=kind,
            scope=scope,
            evidence=evidence,
            confidence=confidence,
            sensitive=sensitive,
            explicit=False,
            expires_at=ensure_utc(expires_at),
            state=MemoryState.CANDIDATE,
            metadata=metadata or {},
            supersede=False,
        )

    def activate(self, memory_id: str) -> MemoryRecord:
        now = _now()
        with self._transaction() as connection:
            row = connection.execute("SELECT * FROM memories WHERE id = ?", (memory_id,)).fetchone()
            if row is None:
                raise KeyError(memory_id)
            state = MemoryState(row["state"])
            if state is MemoryState.ACTIVE:
                return self._decode(row, connection)
            if state is not MemoryState.CANDIDATE:
                raise ValueError(f"cannot activate memory in state {state}")
            expires_at = _dt(row["expires_at"])
            if expires_at is not None and expires_at <= now:
                connection.execute(
                    "UPDATE memories SET state = ?, updated_at = ? WHERE id = ?",
                    (MemoryState.EXPIRED, _iso(now), memory_id),
                )
                raise ValueError("cannot activate an expired memory")
            previous = self._current_rows(connection, row)
            conflicts = [item for item in previous if item["content"] != row["content"]]
            for item in previous:
                connection.execute(
                    "UPDATE memories SET state = ?, updated_at = ? WHERE id = ?",
                    (MemoryState.SUPERSEDED, _iso(now), item["id"]),
                )
            connection.execute(
                "UPDATE memories SET state = ?, updated_at = ? WHERE id = ?",
                (MemoryState.ACTIVE, _iso(now), memory_id),
            )
            for item in conflicts:
                connection.execute(
                    """INSERT OR IGNORE INTO memory_conflicts(
                        memory_id, conflicting_id, created_at
                    ) VALUES (?, ?, ?)""",
                    (memory_id, item["id"], _iso(now)),
                )
            activated = connection.execute(
                "SELECT * FROM memories WHERE id = ?", (memory_id,)
            ).fetchone()
            return self._decode(activated, connection)

    def forget(self, *, key: str, scope: MemoryScope, reason: str | None = None) -> MemoryRecord:
        normalized = _normalize_key(key)
        now = _now()
        with self._transaction() as connection:
            prior = connection.execute(
                """SELECT * FROM memories
                   WHERE normalized_key = ? AND scope_kind = ?
                     AND project_id IS ? AND conversation_id IS ?
                   ORDER BY version DESC""",
                (normalized, scope.kind, scope.project_id, scope.conversation_id),
            ).fetchall()
            version = (prior[0]["version"] if prior else 0) + 1
            for row in prior:
                if row["state"] in (MemoryState.ACTIVE, MemoryState.CANDIDATE):
                    connection.execute(
                        """UPDATE memories
                           SET state = ?, forgotten_at = ?, updated_at = ?
                           WHERE id = ?""",
                        (MemoryState.FORGOTTEN, _iso(now), _iso(now), row["id"]),
                    )
            tombstone_id = _uuid7()
            connection.execute(
                """INSERT INTO memories(
                    id, normalized_key, display_key, content, kind, state, scope_kind,
                    project_id, conversation_id, confidence, sensitive, explicit,
                    version, supersedes_id, created_at, updated_at, expires_at,
                    forgotten_at, metadata_json
                ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, 1, 0, 1, ?, ?, ?, ?, NULL, ?, ?)""",
                (
                    tombstone_id,
                    normalized,
                    key.strip(),
                    MemoryKind.FACT,
                    MemoryState.FORGOTTEN,
                    scope.kind,
                    scope.project_id,
                    scope.conversation_id,
                    version,
                    prior[0]["id"] if prior else None,
                    _iso(now),
                    _iso(now),
                    _iso(now),
                    json.dumps({"tombstone": True, "reason": reason}, sort_keys=True),
                ),
            )
            row = connection.execute(
                "SELECT * FROM memories WHERE id = ?", (tombstone_id,)
            ).fetchone()
            return self._decode(row, connection)

    def query(self, query: MemoryQuery) -> list[MemoryRecord]:
        if query.limit < 1 or query.limit > 500:
            raise ValueError("limit must be between 1 and 500")
        self.expire_due()
        clauses: list[str] = []
        arguments: list[Any] = []
        states = query.states or (MemoryState.ACTIVE,)
        clauses.append(f"state IN ({','.join('?' for _ in states)})")
        arguments.extend(str(state) for state in states)
        clauses.append("json_extract(metadata_json, '$.tombstone') IS NOT 1")

        if query.project_id is None:
            # An unscoped caller is never allowed to enumerate project memories.
            clauses.append("scope_kind = ?")
            arguments.append(ScopeKind.GLOBAL)
        else:
            scope_parts = ["(project_id = ? AND scope_kind IN (?, ?))"]
            scope_args: list[Any] = [
                query.project_id,
                ScopeKind.PROJECT,
                ScopeKind.CONVERSATION,
            ]
            if query.include_global:
                scope_parts.append("scope_kind = ?")
                scope_args.append(ScopeKind.GLOBAL)
            clauses.append("(" + " OR ".join(scope_parts) + ")")
            arguments.extend(scope_args)
            if query.conversation_id:
                clauses.append("(conversation_id IS NULL OR conversation_id = ?)")
                arguments.append(query.conversation_id)
            else:
                clauses.append("conversation_id IS NULL")

        if query.kinds:
            clauses.append(f"kind IN ({','.join('?' for _ in query.kinds)})")
            arguments.extend(str(kind) for kind in query.kinds)
        if query.text and query.text.strip():
            terms = [term for term in query.text.casefold().split() if term]
            for term in terms:
                clauses.append(
                    "(lower(display_key) LIKE ? ESCAPE '\\' OR lower(content) LIKE ? ESCAPE '\\')"
                )
                escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                arguments.extend((f"%{escaped}%", f"%{escaped}%"))
        arguments.append(query.limit)
        sql = "SELECT * FROM memories WHERE " + " AND ".join(clauses)
        sql += " ORDER BY confidence DESC, updated_at DESC LIMIT ?"
        with self._lock:
            rows = self._connection.execute(sql, arguments).fetchall()
            return [self._decode(row, self._connection) for row in rows]

    def get(self, memory_id: str, *, include_forgotten: bool = False) -> MemoryRecord:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM memories WHERE id = ?", (memory_id,)
            ).fetchone()
            if row is None or (not include_forgotten and row["state"] == MemoryState.FORGOTTEN):
                raise KeyError(memory_id)
            return self._decode(row, self._connection)

    def expire_due(self, *, at: datetime | None = None) -> int:
        at = ensure_utc(at) or _now()
        with self._transaction() as connection:
            cursor = connection.execute(
                """UPDATE memories SET state = ?, updated_at = ?
                   WHERE state IN (?, ?) AND expires_at IS NOT NULL AND expires_at <= ?""",
                (
                    MemoryState.EXPIRED,
                    _iso(at),
                    MemoryState.ACTIVE,
                    MemoryState.CANDIDATE,
                    _iso(at),
                ),
            )
            return cursor.rowcount

    def record_usage(self, memory_id: str, run_id: str, outcome: str | None = None) -> MemoryUsage:
        self.get(memory_id)
        usage = MemoryUsage(_uuid7(), memory_id, run_id, _now(), outcome)
        with self._transaction() as connection:
            connection.execute(
                """INSERT INTO memory_usage(id, memory_id, run_id, used_at, outcome)
                   VALUES (?, ?, ?, ?, ?)""",
                (usage.id, usage.memory_id, usage.run_id, _iso(usage.used_at), usage.outcome),
            )
        return usage

    def usage_for(self, memory_id: str) -> list[MemoryUsage]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM memory_usage WHERE memory_id = ? ORDER BY used_at", (memory_id,)
            ).fetchall()
        return [
            MemoryUsage(
                row["id"],
                row["memory_id"],
                row["run_id"],
                _required_dt(row["used_at"]),
                row["outcome"],
            )
            for row in rows
        ]

    def history(self, *, key: str, scope: MemoryScope) -> list[MemoryRecord]:
        """Return every version, including tombstones, for explicit audit UI use."""
        normalized = _normalize_key(key)
        with self._lock:
            rows = self._connection.execute(
                """SELECT * FROM memories
                   WHERE normalized_key = ? AND scope_kind = ?
                     AND project_id IS ? AND conversation_id IS ?
                   ORDER BY version""",
                (normalized, scope.kind, scope.project_id, scope.conversation_id),
            ).fetchall()
            return [self._decode(row, self._connection) for row in rows]

    def set_suggestions_enabled(self, enabled: bool) -> None:
        with self._transaction() as connection:
            connection.execute(
                "INSERT INTO memory_settings(key, value) VALUES ('thoughts_dreams_enabled', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                ("1" if enabled else "0",),
            )

    def suggestions_enabled(self) -> bool:
        with self._lock:
            row = self._connection.execute(
                "SELECT value FROM memory_settings WHERE key = 'thoughts_dreams_enabled'"
            ).fetchone()
        return bool(row and row["value"] == "1")

    def create_suggestion(
        self, *, kind: SuggestionKind, title: str, content: str, scope: MemoryScope
    ) -> MemorySuggestion | None:
        if not self.suggestions_enabled():
            return None
        if not title.strip() or not content.strip():
            raise ValueError("suggestion title and content are required")
        suggestion = MemorySuggestion(_uuid7(), kind, title.strip(), content.strip(), scope, _now())
        with self._transaction() as connection:
            connection.execute(
                """INSERT INTO memory_suggestions(
                    id, kind, title, content, scope_kind, project_id,
                    conversation_id, created_at, dismissed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)""",
                (
                    suggestion.id,
                    suggestion.kind,
                    suggestion.title,
                    suggestion.content,
                    suggestion.scope.kind,
                    suggestion.scope.project_id,
                    suggestion.scope.conversation_id,
                    _iso(suggestion.created_at),
                ),
            )
        return suggestion

    def list_suggestions(
        self,
        *,
        project_id: str | None = None,
        conversation_id: str | None = None,
        include_global: bool = True,
        include_dismissed: bool = False,
        limit: int = 20,
    ) -> list[MemorySuggestion]:
        if not 1 <= limit <= 100:
            raise ValueError("limit must be between 1 and 100")
        clauses = [] if include_dismissed else ["dismissed_at IS NULL"]
        arguments: list[Any] = []
        if project_id is None:
            clauses.append("scope_kind = ?")
            arguments.append(ScopeKind.GLOBAL)
        else:
            scope_clauses = ["(project_id = ? AND scope_kind IN (?, ?))"]
            arguments.extend((project_id, ScopeKind.PROJECT, ScopeKind.CONVERSATION))
            if include_global:
                scope_clauses.append("scope_kind = ?")
                arguments.append(ScopeKind.GLOBAL)
            clauses.append("(" + " OR ".join(scope_clauses) + ")")
            if conversation_id:
                clauses.append("(conversation_id IS NULL OR conversation_id = ?)")
                arguments.append(conversation_id)
            else:
                clauses.append("conversation_id IS NULL")
        arguments.append(limit)
        sql = "SELECT * FROM memory_suggestions WHERE " + " AND ".join(clauses)
        sql += " ORDER BY created_at DESC LIMIT ?"
        with self._lock:
            rows = self._connection.execute(sql, arguments).fetchall()
        return [self._decode_suggestion(row) for row in rows]

    def dismiss_suggestion(self, suggestion_id: str) -> MemorySuggestion:
        now = _now()
        with self._transaction() as connection:
            cursor = connection.execute(
                """UPDATE memory_suggestions SET dismissed_at = ?
                   WHERE id = ? AND dismissed_at IS NULL""",
                (_iso(now), suggestion_id),
            )
            if cursor.rowcount != 1:
                raise KeyError(suggestion_id)
            row = connection.execute(
                "SELECT * FROM memory_suggestions WHERE id = ?", (suggestion_id,)
            ).fetchone()
        return self._decode_suggestion(row)

    def _insert_version(
        self,
        *,
        key: str,
        content: str,
        kind: MemoryKind,
        scope: MemoryScope,
        evidence: Sequence[Evidence],
        confidence: float,
        sensitive: bool,
        explicit: bool,
        expires_at: datetime | None,
        state: MemoryState,
        metadata: dict[str, Any],
        supersede: bool,
    ) -> MemoryRecord:
        normalized = _normalize_key(key)
        now = _now()
        if expires_at and expires_at <= now:
            state = MemoryState.EXPIRED
        with self._transaction() as connection:
            prior = connection.execute(
                """SELECT * FROM memories
                   WHERE normalized_key = ? AND scope_kind = ?
                     AND project_id IS ? AND conversation_id IS ?
                   ORDER BY version DESC""",
                (normalized, scope.kind, scope.project_id, scope.conversation_id),
            ).fetchall()
            version = (prior[0]["version"] if prior else 0) + 1
            current = [item for item in prior if item["state"] == MemoryState.ACTIVE]
            conflict_ids = [item["id"] for item in current if item["content"] != content]
            if supersede:
                for item in current:
                    connection.execute(
                        "UPDATE memories SET state = ?, updated_at = ? WHERE id = ?",
                        (MemoryState.SUPERSEDED, _iso(now), item["id"]),
                    )
            memory_id = _uuid7()
            connection.execute(
                """INSERT INTO memories(
                    id, normalized_key, display_key, content, kind, state, scope_kind,
                    project_id, conversation_id, confidence, sensitive, explicit,
                    version, supersedes_id, created_at, updated_at, expires_at,
                    forgotten_at, metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)""",
                (
                    memory_id,
                    normalized,
                    key.strip(),
                    content.strip(),
                    kind,
                    state,
                    scope.kind,
                    scope.project_id,
                    scope.conversation_id,
                    confidence,
                    int(sensitive),
                    int(explicit),
                    version,
                    prior[0]["id"] if prior else None,
                    _iso(now),
                    _iso(now),
                    _iso(expires_at),
                    json.dumps(metadata, sort_keys=True),
                ),
            )
            for item in evidence:
                connection.execute(
                    """INSERT INTO memory_evidence(
                        memory_id, source_kind, source_id, excerpt, locator_json, captured_at
                    ) VALUES (?, ?, ?, ?, ?, ?)""",
                    (
                        memory_id,
                        item.source_kind,
                        item.source_id,
                        item.excerpt,
                        json.dumps(dict(item.locator), sort_keys=True),
                        _iso(item.captured_at),
                    ),
                )
            for conflicting_id in conflict_ids:
                connection.execute(
                    """INSERT OR IGNORE INTO memory_conflicts(
                        memory_id, conflicting_id, created_at
                    ) VALUES (?, ?, ?)""",
                    (memory_id, conflicting_id, _iso(now)),
                )
            row = connection.execute("SELECT * FROM memories WHERE id = ?", (memory_id,)).fetchone()
            return self._decode(row, connection)

    @staticmethod
    def _current_rows(connection: sqlite3.Connection, row: sqlite3.Row) -> list[sqlite3.Row]:
        return connection.execute(
            """SELECT * FROM memories WHERE normalized_key = ? AND scope_kind = ?
               AND project_id IS ? AND conversation_id IS ? AND state = ? AND id <> ?""",
            (
                row["normalized_key"],
                row["scope_kind"],
                row["project_id"],
                row["conversation_id"],
                MemoryState.ACTIVE,
                row["id"],
            ),
        ).fetchall()

    @staticmethod
    def _decode(row: sqlite3.Row, connection: sqlite3.Connection) -> MemoryRecord:
        evidence_rows = connection.execute(
            "SELECT * FROM memory_evidence WHERE memory_id = ? ORDER BY rowid", (row["id"],)
        ).fetchall()
        conflict_rows = connection.execute(
            """SELECT conflicting_id FROM memory_conflicts
               WHERE memory_id = ? ORDER BY conflicting_id""",
            (row["id"],),
        ).fetchall()
        scope = MemoryScope(ScopeKind(row["scope_kind"]), row["project_id"], row["conversation_id"])
        evidence = tuple(
            Evidence(
                source_kind=item["source_kind"],
                source_id=item["source_id"],
                excerpt=item["excerpt"],
                locator=json.loads(item["locator_json"]),
                captured_at=_required_dt(item["captured_at"]),
            )
            for item in evidence_rows
        )
        return MemoryRecord(
            id=row["id"],
            key=row["display_key"],
            content=row["content"],
            kind=MemoryKind(row["kind"]),
            state=MemoryState(row["state"]),
            scope=scope,
            confidence=row["confidence"],
            sensitive=bool(row["sensitive"]),
            explicit=bool(row["explicit"]),
            version=row["version"],
            supersedes_id=row["supersedes_id"],
            conflict_ids=tuple(item["conflicting_id"] for item in conflict_rows),
            evidence=evidence,
            created_at=_required_dt(row["created_at"]),
            updated_at=_required_dt(row["updated_at"]),
            expires_at=_dt(row["expires_at"]),
            forgotten_at=_dt(row["forgotten_at"]),
            metadata=json.loads(row["metadata_json"]),
        )

    @staticmethod
    def _decode_suggestion(row: sqlite3.Row) -> MemorySuggestion:
        return MemorySuggestion(
            id=row["id"],
            kind=SuggestionKind(row["kind"]),
            title=row["title"],
            content=row["content"],
            scope=MemoryScope(
                ScopeKind(row["scope_kind"]), row["project_id"], row["conversation_id"]
            ),
            created_at=_required_dt(row["created_at"]),
            dismissed_at=_dt(row["dismissed_at"]),
        )


_SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    normalized_key TEXT NOT NULL,
    display_key TEXT NOT NULL,
    content TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    project_id TEXT,
    conversation_id TEXT,
    confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
    sensitive INTEGER NOT NULL,
    explicit INTEGER NOT NULL,
    version INTEGER NOT NULL,
    supersedes_id TEXT REFERENCES memories(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    forgotten_at TEXT,
    metadata_json TEXT NOT NULL,
    UNIQUE(normalized_key, scope_kind, project_id, conversation_id, version)
);
CREATE INDEX IF NOT EXISTS memories_scope_state_idx
    ON memories(scope_kind, project_id, conversation_id, state, updated_at);
CREATE TABLE IF NOT EXISTS memory_evidence (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    excerpt TEXT,
    locator_json TEXT NOT NULL,
    captured_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_conflicts (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    conflicting_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY(memory_id, conflicting_id)
);
CREATE TABLE IF NOT EXISTS memory_usage (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    used_at TEXT NOT NULL,
    outcome TEXT
);
CREATE TABLE IF NOT EXISTS memory_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT OR IGNORE INTO memory_settings(key, value) VALUES ('thoughts_dreams_enabled', '0');
CREATE TABLE IF NOT EXISTS memory_suggestions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    project_id TEXT,
    conversation_id TEXT,
    created_at TEXT NOT NULL,
    dismissed_at TEXT
);
"""
