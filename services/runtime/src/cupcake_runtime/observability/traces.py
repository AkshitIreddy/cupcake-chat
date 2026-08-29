"""Redacted developer traces with OpenTelemetry-compatible identifiers."""

from __future__ import annotations

import json
import secrets
import sqlite3
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from threading import RLock
from typing import Any

from .redaction import TraceRedactor


class TraceKind(StrEnum):
    RUN = "run"
    CHECKPOINT = "checkpoint"
    TOOL = "tool"
    APPROVAL = "approval"
    RETRIEVAL = "retrieval"
    SUBAGENT = "subagent"
    USAGE = "usage"
    FAILURE = "failure"


@dataclass(frozen=True, slots=True)
class DeveloperTrace:
    trace_id: str
    span_id: str
    run_id: str
    kind: TraceKind
    name: str
    payload: Mapping[str, Any]
    parent_span_id: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    expires_at: datetime | None = None


def new_trace_id() -> str:
    return secrets.token_hex(16)


def new_span_id() -> str:
    return secrets.token_hex(8)


class DeveloperTraceStore:
    DEFAULT_RETENTION_DAYS = 30

    def __init__(
        self,
        path: str,
        *,
        retention_days: int = DEFAULT_RETENTION_DAYS,
        redactor: TraceRedactor | None = None,
    ) -> None:
        if retention_days < 1:
            raise ValueError("trace retention must be at least one day")
        self.retention = timedelta(days=retention_days)
        self.redactor = redactor or TraceRedactor()
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._lock = RLock()
        with self._connection:
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA busy_timeout=5000")
            self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS developer_traces (
                    span_id TEXT PRIMARY KEY,
                    trace_id TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    parent_span_id TEXT,
                    kind TEXT NOT NULL,
                    name TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL
                )
                """
            )
            self._connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_developer_traces_run_created "
                "ON developer_traces(run_id, created_at)"
            )
            self._connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_developer_traces_expiry "
                "ON developer_traces(expires_at)"
            )

    def record(self, trace: DeveloperTrace) -> DeveloperTrace:
        created_at = trace.created_at.astimezone(UTC)
        maximum_expiry = created_at + self.retention
        requested_expiry = trace.expires_at.astimezone(UTC) if trace.expires_at else maximum_expiry
        expires_at = min(requested_expiry, maximum_expiry)
        payload = self.redactor.redact(trace.payload)
        redacted = DeveloperTrace(
            trace_id=trace.trace_id,
            span_id=trace.span_id,
            run_id=trace.run_id,
            parent_span_id=trace.parent_span_id,
            kind=trace.kind,
            name=trace.name,
            payload=payload,
            created_at=created_at,
            expires_at=expires_at,
        )
        payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
        with self._lock, self._connection:
            existing = self._connection.execute(
                "SELECT * FROM developer_traces WHERE span_id=?", (redacted.span_id,)
            ).fetchone()
            if existing is not None:
                if (
                    existing["trace_id"] != redacted.trace_id
                    or existing["run_id"] != redacted.run_id
                    or existing["parent_span_id"] != redacted.parent_span_id
                    or existing["kind"] != redacted.kind.value
                    or existing["name"] != redacted.name
                    or existing["payload_json"] != payload_json
                ):
                    raise ValueError("trace span id was reused for different content")
                return self._from_row(existing)
            self._connection.execute(
                """
                INSERT INTO developer_traces (
                    span_id, trace_id, run_id, parent_span_id, kind, name,
                    payload_json, created_at, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    redacted.span_id,
                    redacted.trace_id,
                    redacted.run_id,
                    redacted.parent_span_id,
                    redacted.kind.value,
                    redacted.name,
                    payload_json,
                    redacted.created_at.isoformat(),
                    expires_at.isoformat(),
                ),
            )
        return redacted

    @staticmethod
    def _from_row(row: sqlite3.Row) -> DeveloperTrace:
        return DeveloperTrace(
            trace_id=row["trace_id"],
            span_id=row["span_id"],
            run_id=row["run_id"],
            parent_span_id=row["parent_span_id"],
            kind=TraceKind(row["kind"]),
            name=row["name"],
            payload=json.loads(row["payload_json"]),
            created_at=datetime.fromisoformat(row["created_at"]),
            expires_at=datetime.fromisoformat(row["expires_at"]),
        )

    def list_run(self, run_id: str) -> list[DeveloperTrace]:
        rows = self._connection.execute(
            "SELECT * FROM developer_traces "
            "WHERE run_id=? AND expires_at>? ORDER BY created_at, span_id",
            (run_id, datetime.now(UTC).isoformat()),
        ).fetchall()
        return [self._from_row(row) for row in rows]

    def purge_expired(self, *, now: datetime | None = None) -> int:
        cutoff = (now or datetime.now(UTC)).astimezone(UTC).isoformat()
        with self._lock, self._connection:
            cursor = self._connection.execute(
                "DELETE FROM developer_traces WHERE expires_at<=?", (cutoff,)
            )
            return int(cursor.rowcount)

    def close(self) -> None:
        self._connection.close()


class TraceRecorder:
    def __init__(self, store: DeveloperTraceStore, *, trace_id: str | None = None) -> None:
        self.store = store
        self.trace_id = trace_id or new_trace_id()

    def record(
        self,
        run_id: str,
        kind: TraceKind,
        name: str,
        payload: Mapping[str, Any],
        *,
        parent_span_id: str | None = None,
        span_id: str | None = None,
    ) -> DeveloperTrace:
        return self.store.record(
            DeveloperTrace(
                trace_id=self.trace_id,
                span_id=span_id or new_span_id(),
                run_id=run_id,
                parent_span_id=parent_span_id,
                kind=kind,
                name=name,
                payload=payload,
            )
        )
