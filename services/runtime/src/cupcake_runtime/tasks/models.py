"""Durable task domain model and legal state transitions."""

from __future__ import annotations

import json
import secrets
import time
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any


def new_product_id(prefix: str) -> str:
    """Return a sortable UUIDv7-shaped identifier without a third-party dependency."""
    timestamp_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    rand_a = secrets.randbits(12)
    rand_b = secrets.randbits(62)
    value = (timestamp_ms << 80) | (0x7 << 76) | (rand_a << 64) | (0b10 << 62) | rand_b
    hexadecimal = f"{value:032x}"
    uuid_text = (
        f"{hexadecimal[:8]}-{hexadecimal[8:12]}-{hexadecimal[12:16]}-"
        f"{hexadecimal[16:20]}-{hexadecimal[20:]}"
    )
    return f"{prefix}_{uuid_text}"


class RunMode(StrEnum):
    INTERACTIVE = "interactive"
    BACKGROUND = "background"


class RunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    WAITING_APPROVAL = "waiting_approval"
    WAITING_INPUT = "waiting_input"
    CANCELLING = "cancelling"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"

    @property
    def terminal(self) -> bool:
        return self in {self.SUCCEEDED, self.FAILED, self.CANCELLED}


LEGAL_TRANSITIONS: Mapping[RunStatus, frozenset[RunStatus]] = {
    RunStatus.QUEUED: frozenset({RunStatus.RUNNING, RunStatus.CANCELLED, RunStatus.FAILED}),
    RunStatus.RUNNING: frozenset(
        {
            RunStatus.WAITING_APPROVAL,
            RunStatus.WAITING_INPUT,
            RunStatus.CANCELLING,
            RunStatus.SUCCEEDED,
            RunStatus.FAILED,
        }
    ),
    RunStatus.WAITING_APPROVAL: frozenset(
        {RunStatus.QUEUED, RunStatus.CANCELLING, RunStatus.CANCELLED, RunStatus.FAILED}
    ),
    RunStatus.WAITING_INPUT: frozenset(
        {
            RunStatus.QUEUED,
            RunStatus.RUNNING,
            RunStatus.WAITING_APPROVAL,
            RunStatus.CANCELLING,
            RunStatus.CANCELLED,
            RunStatus.FAILED,
        }
    ),
    RunStatus.CANCELLING: frozenset({RunStatus.CANCELLED, RunStatus.FAILED}),
    RunStatus.SUCCEEDED: frozenset(),
    RunStatus.FAILED: frozenset({RunStatus.QUEUED}),
    RunStatus.CANCELLED: frozenset(),
}


class InvalidTransitionError(RuntimeError):
    pass


def require_transition(source: RunStatus, destination: RunStatus) -> None:
    if source == destination:
        return
    if destination not in LEGAL_TRANSITIONS[source]:
        raise InvalidTransitionError(
            f"illegal run transition: {source.value} -> {destination.value}"
        )


class WorkKind(StrEnum):
    CHAT = "chat"
    REPOSITORY_INDEX = "repository_index"
    DOCUMENT_INDEX = "document_index"
    CODE_EXECUTION = "code_execution"
    ARTIFACT_GENERATION = "artifact_generation"
    TOOL_WORKFLOW = "tool_workflow"


@dataclass(frozen=True, slots=True, order=True)
class RuntimeRevision:
    major: int
    minor: int = 0
    patch: int = 0

    def __post_init__(self) -> None:
        if min(self.major, self.minor, self.patch) < 0:
            raise ValueError("runtime revision components must be non-negative")

    def __str__(self) -> str:
        return f"{self.major}.{self.minor}.{self.patch}"

    @classmethod
    def parse(cls, value: str) -> RuntimeRevision:
        parts = value.split(".")
        if len(parts) != 3 or any(not part.isdigit() for part in parts):
            raise ValueError(f"invalid runtime revision: {value!r}")
        return cls(*(int(part) for part in parts))


class IncompatibleRuntimeError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class RevisionCompatibility:
    current: RuntimeRevision
    supported_majors: frozenset[int] = frozenset()

    def assert_can_resume(self, persisted: RuntimeRevision) -> None:
        supported = self.supported_majors or frozenset({self.current.major})
        if persisted.major not in supported:
            raise IncompatibleRuntimeError(
                f"runtime {self.current} cannot resume checkpoint revision {persisted}"
            )
        if persisted > self.current:
            raise IncompatibleRuntimeError(
                f"checkpoint revision {persisted} is newer than runtime {self.current}"
            )


@dataclass(frozen=True, slots=True)
class TaskStep:
    key: str
    operation: str
    arguments: Mapping[str, Any] = field(default_factory=dict[str, Any])
    requires_approval: bool = False
    approval_intent_digest: str | None = None

    def __post_init__(self) -> None:
        if not self.key.strip() or not self.operation.strip():
            raise ValueError("task step key and operation are required")
        if self.requires_approval and not self.approval_intent_digest:
            raise ValueError("approval-gated steps require an intent digest")


@dataclass(frozen=True, slots=True)
class TaskSpec:
    title: str
    prompt: str
    steps: Sequence[TaskStep]
    work_kind: WorkKind = WorkKind.CHAT
    estimated_seconds: float | None = None
    explicitly_background: bool = False
    parent_run_id: str | None = None
    project_id: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict[str, Any])

    def __post_init__(self) -> None:
        if not self.title.strip() or not self.prompt.strip():
            raise ValueError("task title and prompt are required")
        keys = [step.key for step in self.steps]
        if len(keys) != len(set(keys)):
            raise ValueError("step keys must be unique")
        if self.estimated_seconds is not None and self.estimated_seconds < 0:
            raise ValueError("estimated_seconds cannot be negative")

    def to_json(self) -> str:
        payload = asdict(self)
        payload["work_kind"] = self.work_kind.value
        return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)

    @classmethod
    def from_json(cls, value: str) -> TaskSpec:
        payload = json.loads(value)
        payload["work_kind"] = WorkKind(payload["work_kind"])
        payload["steps"] = tuple(TaskStep(**step) for step in payload["steps"])
        return cls(**payload)


@dataclass(frozen=True, slots=True)
class RunRecord:
    run_id: str
    task_id: str
    spec: TaskSpec
    mode: RunMode
    status: RunStatus
    runtime_revision: RuntimeRevision
    current_step: int = 0
    cancellation_requested: bool = False
    error: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))


class CommandKind(StrEnum):
    CANCEL = "cancel"
    STEER = "steer"
    FOLLOWUP = "followup"


@dataclass(frozen=True, slots=True)
class ControlCommand:
    command_id: str
    run_id: str
    kind: CommandKind
    payload: Mapping[str, Any]
    created_at: datetime
    applied_at: datetime | None = None


class ApprovalStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    DENIED = "denied"


@dataclass(frozen=True, slots=True)
class ApprovalRecord:
    approval_id: str
    run_id: str
    step_key: str
    intent_digest: str
    status: ApprovalStatus
    response: Mapping[str, Any] | None = None
