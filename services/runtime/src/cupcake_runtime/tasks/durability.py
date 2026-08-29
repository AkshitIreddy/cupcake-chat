"""Product task state and the deterministic direct-execution fallback.

The packaged runtime uses :mod:`cupcake_runtime.tasks.dbos_runtime` for actual
DBOS workflows and steps.  This module keeps authoritative product-visible state
in SQLite and provides a small direct adapter for deterministic unit tests.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable, Mapping
from dataclasses import replace
from datetime import UTC, datetime
from threading import RLock
from typing import Any, Protocol

from .models import (
    ApprovalRecord,
    ApprovalStatus,
    CommandKind,
    ControlCommand,
    RevisionCompatibility,
    RunMode,
    RunRecord,
    RunStatus,
    RuntimeRevision,
    TaskSpec,
    new_product_id,
    require_transition,
)


class CheckpointConflictError(RuntimeError):
    pass


class DurabilityStore(Protocol):
    def create_run(self, run: RunRecord) -> None: ...
    def get_run(self, run_id: str) -> RunRecord: ...
    def list_recoverable(self) -> list[RunRecord]: ...
    def list_runs(
        self, *, statuses: tuple[RunStatus, ...] = (), limit: int = 200
    ) -> list[RunRecord]: ...
    def transition(
        self,
        run_id: str,
        status: RunStatus,
        *,
        current_step: int | None = None,
        error: str | None = None,
        recovery: bool = False,
    ) -> RunRecord: ...
    def get_checkpoint(self, run_id: str, step_key: str) -> Mapping[str, Any] | None: ...
    def save_checkpoint(
        self,
        run_id: str,
        step_key: str,
        input_digest: str,
        output: Mapping[str, Any],
        revision: RuntimeRevision,
    ) -> bool: ...
    def request_cancellation(self, run_id: str) -> bool: ...
    def enqueue_command(
        self, run_id: str, kind: CommandKind, payload: Mapping[str, Any]
    ) -> ControlCommand: ...
    def pending_commands(self, run_id: str) -> list[ControlCommand]: ...
    def mark_command_applied(self, command_id: str) -> None: ...
    def request_approval(
        self, run_id: str, step_key: str, intent_digest: str
    ) -> ApprovalRecord: ...
    def get_approval(self, run_id: str, step_key: str) -> ApprovalRecord | None: ...
    def resolve_approval(
        self,
        approval_id: str,
        status: ApprovalStatus,
        response: Mapping[str, Any] | None = None,
    ) -> ApprovalRecord: ...


class SqliteDurabilityStore:
    def __init__(self, path: str) -> None:
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._lock = RLock()
        self._configure()

    def _configure(self) -> None:
        with self._connection:
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA foreign_keys=ON")
            self._connection.execute("PRAGMA busy_timeout=5000")
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS durable_runs (
                    run_id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL UNIQUE,
                    spec_json TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    status TEXT NOT NULL,
                    runtime_revision TEXT NOT NULL,
                    current_step INTEGER NOT NULL DEFAULT 0,
                    cancellation_requested INTEGER NOT NULL DEFAULT 0,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS durable_checkpoints (
                    run_id TEXT NOT NULL REFERENCES durable_runs(run_id) ON DELETE CASCADE,
                    step_key TEXT NOT NULL,
                    input_digest TEXT NOT NULL,
                    output_json TEXT NOT NULL,
                    runtime_revision TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(run_id, step_key)
                );

                CREATE TABLE IF NOT EXISTS durable_commands (
                    command_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL REFERENCES durable_runs(run_id) ON DELETE CASCADE,
                    kind TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    applied_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_durable_commands_pending
                    ON durable_commands(run_id, applied_at, created_at);

                CREATE TABLE IF NOT EXISTS durable_approvals (
                    approval_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL REFERENCES durable_runs(run_id) ON DELETE CASCADE,
                    step_key TEXT NOT NULL,
                    intent_digest TEXT NOT NULL,
                    status TEXT NOT NULL,
                    response_json TEXT,
                    created_at TEXT NOT NULL,
                    resolved_at TEXT,
                    UNIQUE(run_id, step_key)
                );
                """
            )

    @staticmethod
    def _run_from_row(row: sqlite3.Row) -> RunRecord:
        return RunRecord(
            run_id=row["run_id"],
            task_id=row["task_id"],
            spec=TaskSpec.from_json(row["spec_json"]),
            mode=RunMode(row["mode"]),
            status=RunStatus(row["status"]),
            runtime_revision=RuntimeRevision.parse(row["runtime_revision"]),
            current_step=int(row["current_step"]),
            cancellation_requested=bool(row["cancellation_requested"]),
            error=row["error"],
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )

    def create_run(self, run: RunRecord) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO durable_runs (
                    run_id, task_id, spec_json, mode, status, runtime_revision,
                    current_step, cancellation_requested, error, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run.run_id,
                    run.task_id,
                    run.spec.to_json(),
                    run.mode.value,
                    run.status.value,
                    str(run.runtime_revision),
                    run.current_step,
                    int(run.cancellation_requested),
                    run.error,
                    run.created_at.isoformat(),
                    run.updated_at.isoformat(),
                ),
            )

    def get_run(self, run_id: str) -> RunRecord:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM durable_runs WHERE run_id=?", (run_id,)
            ).fetchone()
        if row is None:
            raise KeyError(run_id)
        return self._run_from_row(row)

    def list_recoverable(self) -> list[RunRecord]:
        terminal = tuple(status.value for status in RunStatus if status.terminal)
        placeholders = ",".join("?" for _ in terminal)
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM durable_runs "
                f"WHERE status NOT IN ({placeholders}) ORDER BY created_at",
                terminal,
            ).fetchall()
        return [self._run_from_row(row) for row in rows]

    def list_runs(
        self, *, statuses: tuple[RunStatus, ...] = (), limit: int = 200
    ) -> list[RunRecord]:
        if not 1 <= limit <= 2_000:
            raise ValueError("limit must be between 1 and 2000")
        arguments: list[object] = []
        where = ""
        if statuses:
            placeholders = ",".join("?" for _ in statuses)
            where = f"WHERE status IN ({placeholders})"
            arguments.extend(status.value for status in statuses)
        arguments.append(limit)
        with self._lock:
            rows = self._connection.execute(
                f"""SELECT * FROM durable_runs {where}
                    ORDER BY updated_at DESC, run_id DESC LIMIT ?""",
                arguments,
            ).fetchall()
        return [self._run_from_row(row) for row in rows]

    def transition(
        self,
        run_id: str,
        status: RunStatus,
        *,
        current_step: int | None = None,
        error: str | None = None,
        recovery: bool = False,
    ) -> RunRecord:
        with self._lock, self._connection:
            current = self.get_run(run_id)
            if not recovery:
                require_transition(current.status, status)
            elif current.status.terminal:
                raise ValueError("terminal runs cannot be recovered")
            now = datetime.now(UTC)
            self._connection.execute(
                """
                UPDATE durable_runs
                SET status=?, current_step=?, error=?, updated_at=?
                WHERE run_id=?
                """,
                (
                    status.value,
                    current.current_step if current_step is None else current_step,
                    error,
                    now.isoformat(),
                    run_id,
                ),
            )
            return replace(
                current,
                status=status,
                current_step=current.current_step if current_step is None else current_step,
                error=error,
                updated_at=now,
            )

    def request_cancellation(self, run_id: str) -> bool:
        with self._lock, self._connection:
            run = self.get_run(run_id)
            if run.status.terminal:
                return False
            self._connection.execute(
                "UPDATE durable_runs SET cancellation_requested=1, updated_at=? WHERE run_id=?",
                (datetime.now(UTC).isoformat(), run_id),
            )
            return not run.cancellation_requested

    def get_checkpoint(self, run_id: str, step_key: str) -> Mapping[str, Any] | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM durable_checkpoints WHERE run_id=? AND step_key=?",
                (run_id, step_key),
            ).fetchone()
        if row is None:
            return None
        return {
            "run_id": row["run_id"],
            "step_key": row["step_key"],
            "input_digest": row["input_digest"],
            "output": json.loads(row["output_json"]),
            "runtime_revision": row["runtime_revision"],
            "created_at": row["created_at"],
        }

    def save_checkpoint(
        self,
        run_id: str,
        step_key: str,
        input_digest: str,
        output: Mapping[str, Any],
        revision: RuntimeRevision,
    ) -> bool:
        output_json = json.dumps(output, sort_keys=True, separators=(",", ":"), default=str)
        with self._lock, self._connection:
            existing = self._connection.execute(
                "SELECT * FROM durable_checkpoints WHERE run_id=? AND step_key=?",
                (run_id, step_key),
            ).fetchone()
            if existing is not None:
                if (
                    existing["input_digest"] != input_digest
                    or existing["output_json"] != output_json
                ):
                    raise CheckpointConflictError(
                        f"checkpoint {run_id}/{step_key} was reused with different content"
                    )
                return False
            self._connection.execute(
                """
                INSERT INTO durable_checkpoints (
                    run_id, step_key, input_digest, output_json, runtime_revision, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    step_key,
                    input_digest,
                    output_json,
                    str(revision),
                    datetime.now(UTC).isoformat(),
                ),
            )
            return True

    def enqueue_command(
        self, run_id: str, kind: CommandKind, payload: Mapping[str, Any]
    ) -> ControlCommand:
        command = ControlCommand(
            command_id=new_product_id("cmd"),
            run_id=run_id,
            kind=kind,
            payload=dict(payload),
            created_at=datetime.now(UTC),
        )
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO durable_commands (
                    command_id, run_id, kind, payload_json, created_at, applied_at
                ) VALUES (?, ?, ?, ?, ?, NULL)
                """,
                (
                    command.command_id,
                    command.run_id,
                    command.kind.value,
                    json.dumps(command.payload, sort_keys=True, separators=(",", ":")),
                    command.created_at.isoformat(),
                ),
            )
        return command

    def pending_commands(self, run_id: str) -> list[ControlCommand]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT * FROM durable_commands
                WHERE run_id=? AND applied_at IS NULL ORDER BY created_at, command_id
                """,
                (run_id,),
            ).fetchall()
        return [
            ControlCommand(
                command_id=row["command_id"],
                run_id=row["run_id"],
                kind=CommandKind(row["kind"]),
                payload=json.loads(row["payload_json"]),
                created_at=datetime.fromisoformat(row["created_at"]),
            )
            for row in rows
        ]

    def mark_command_applied(self, command_id: str) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "UPDATE durable_commands SET applied_at=? "
                "WHERE command_id=? AND applied_at IS NULL",
                (datetime.now(UTC).isoformat(), command_id),
            )

    def request_approval(self, run_id: str, step_key: str, intent_digest: str) -> ApprovalRecord:
        with self._lock, self._connection:
            existing = self._connection.execute(
                "SELECT * FROM durable_approvals WHERE run_id=? AND step_key=?",
                (run_id, step_key),
            ).fetchone()
            if existing is not None:
                if existing["intent_digest"] != intent_digest:
                    raise CheckpointConflictError("approval intent changed for a persisted step")
                return self._approval_from_row(existing)
            approval = ApprovalRecord(
                approval_id=new_product_id("apr"),
                run_id=run_id,
                step_key=step_key,
                intent_digest=intent_digest,
                status=ApprovalStatus.PENDING,
            )
            self._connection.execute(
                """
                INSERT INTO durable_approvals (
                    approval_id, run_id, step_key, intent_digest, status,
                    response_json, created_at, resolved_at
                ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)
                """,
                (
                    approval.approval_id,
                    run_id,
                    step_key,
                    intent_digest,
                    approval.status.value,
                    datetime.now(UTC).isoformat(),
                ),
            )
            return approval

    @staticmethod
    def _approval_from_row(row: sqlite3.Row) -> ApprovalRecord:
        return ApprovalRecord(
            approval_id=row["approval_id"],
            run_id=row["run_id"],
            step_key=row["step_key"],
            intent_digest=row["intent_digest"],
            status=ApprovalStatus(row["status"]),
            response=json.loads(row["response_json"]) if row["response_json"] else None,
        )

    def get_approval(self, run_id: str, step_key: str) -> ApprovalRecord | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM durable_approvals WHERE run_id=? AND step_key=?",
                (run_id, step_key),
            ).fetchone()
        return self._approval_from_row(row) if row is not None else None

    def resolve_approval(
        self,
        approval_id: str,
        status: ApprovalStatus,
        response: Mapping[str, Any] | None = None,
    ) -> ApprovalRecord:
        if status is ApprovalStatus.PENDING:
            raise ValueError("approval resolution must be approved or denied")
        with self._lock, self._connection:
            row = self._connection.execute(
                "SELECT * FROM durable_approvals WHERE approval_id=?", (approval_id,)
            ).fetchone()
            if row is None:
                raise KeyError(approval_id)
            current = self._approval_from_row(row)
            if current.status is not ApprovalStatus.PENDING:
                if current.status is status and current.response == response:
                    return current
                raise CheckpointConflictError("approval was already resolved differently")
            self._connection.execute(
                """
                UPDATE durable_approvals
                SET status=?, response_json=?, resolved_at=? WHERE approval_id=?
                """,
                (
                    status.value,
                    json.dumps(response, sort_keys=True, separators=(",", ":"))
                    if response is not None
                    else None,
                    datetime.now(UTC).isoformat(),
                    approval_id,
                ),
            )
            return ApprovalRecord(
                approval_id=current.approval_id,
                run_id=current.run_id,
                step_key=current.step_key,
                intent_digest=current.intent_digest,
                status=status,
                response=response,
            )

    def close(self) -> None:
        self._connection.close()


class DeterministicCheckpointAdapter:
    """Direct checkpoint adapter used outside the production DBOS workflow.

    The idempotency key must also be passed to the external tool/provider. That
    closes the unavoidable crash window between an external effect and a local
    product checkpoint without relying on a process-local lock.
    """

    def __init__(
        self,
        store: DurabilityStore,
        revision: RuntimeRevision,
        compatibility: RevisionCompatibility | None = None,
    ) -> None:
        self.store = store
        self.revision = revision
        self.compatibility = compatibility or RevisionCompatibility(revision)

    def checkpointed_step(
        self,
        run_id: str,
        step_key: str,
        input_digest: str,
        operation: Callable[[str], Mapping[str, Any]],
    ) -> tuple[Mapping[str, Any], bool]:
        existing = self.store.get_checkpoint(run_id, step_key)
        if existing is not None:
            self.compatibility.assert_can_resume(
                RuntimeRevision.parse(str(existing["runtime_revision"]))
            )
            if existing["input_digest"] != input_digest:
                raise CheckpointConflictError("persisted step input changed")
            return existing["output"], True
        idempotency_key = f"{run_id}:{step_key}:{input_digest}"
        output = operation(idempotency_key)
        self.store.save_checkpoint(run_id, step_key, input_digest, output, self.revision)
        return output, False


# Backward-compatible import for callers built against the earlier scaffold.
# It is intentionally not the production DBOS adapter.
DbosCompatibleDurabilityAdapter = DeterministicCheckpointAdapter
