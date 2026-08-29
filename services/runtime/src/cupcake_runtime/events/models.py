"""Canonical runtime events.

Events are product-owned records.  Framework callbacks and provider payloads must be
translated into this small contract before they are persisted or shown to a user.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any


class EventKind(StrEnum):
    RUN_CREATED = "run.created"
    RUN_PROMOTED = "run.promoted"
    RUN_STATUS = "run.status"
    RUN_RECOVERED = "run.recovered"
    RUN_STEERED = "run.steered"
    RUN_FOLLOWUP_QUEUED = "run.followup_queued"
    STEP_STARTED = "step.started"
    STEP_CHECKPOINTED = "step.checkpointed"
    STEP_REUSED = "step.reused"
    APPROVAL_REQUESTED = "approval.requested"
    APPROVAL_RESOLVED = "approval.resolved"
    SUBAGENT_STARTED = "subagent.started"
    SUBAGENT_FINISHED = "subagent.finished"
    USAGE_RECORDED = "usage.recorded"
    ERROR = "error"


@dataclass(frozen=True, slots=True)
class RunEvent:
    event_id: str
    run_id: str
    sequence: int
    kind: EventKind
    payload: Mapping[str, Any] = field(default_factory=dict)
    task_id: str | None = None
    parent_run_id: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    schema_version: int = 1

    def canonical_payload(self) -> str:
        return json.dumps(self.payload, sort_keys=True, separators=(",", ":"), default=str)

    def to_record(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "run_id": self.run_id,
            "task_id": self.task_id,
            "parent_run_id": self.parent_run_id,
            "sequence": self.sequence,
            "kind": self.kind.value,
            "payload": self.canonical_payload(),
            "created_at": self.created_at.isoformat(),
            "schema_version": self.schema_version,
        }

    @classmethod
    def from_record(cls, record: Mapping[str, Any]) -> RunEvent:
        return cls(
            event_id=str(record["event_id"]),
            run_id=str(record["run_id"]),
            task_id=record["task_id"],
            parent_run_id=record["parent_run_id"],
            sequence=int(record["sequence"]),
            kind=EventKind(record["kind"]),
            payload=json.loads(record["payload"]),
            created_at=datetime.fromisoformat(str(record["created_at"])),
            schema_version=int(record["schema_version"]),
        )
