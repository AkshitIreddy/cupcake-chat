from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any


class MemoryKind(StrEnum):
    PREFERENCE = "preference"
    FACT = "fact"
    INSTRUCTION = "instruction"
    DECISION = "decision"
    EVENT = "event"
    TASK_STATE = "task_state"
    TEMPORARY_CONTEXT = "temporary_context"


class MemoryState(StrEnum):
    CANDIDATE = "candidate"
    ACTIVE = "active"
    SUPERSEDED = "superseded"
    EXPIRED = "expired"
    FORGOTTEN = "forgotten"


class ScopeKind(StrEnum):
    GLOBAL = "global"
    PROJECT = "project"
    CONVERSATION = "conversation"


class SuggestionKind(StrEnum):
    THOUGHT = "thought"
    DREAM = "dream"


@dataclass(frozen=True, slots=True)
class MemoryScope:
    kind: ScopeKind
    project_id: str | None = None
    conversation_id: str | None = None

    def __post_init__(self) -> None:
        if self.kind is ScopeKind.GLOBAL and (self.project_id or self.conversation_id):
            raise ValueError("global scope cannot name a project or conversation")
        if self.kind is ScopeKind.PROJECT and not self.project_id:
            raise ValueError("project scope requires project_id")
        if self.kind is ScopeKind.PROJECT and self.conversation_id:
            raise ValueError("project scope cannot name a conversation")
        if self.kind is ScopeKind.CONVERSATION and (
            not self.project_id or not self.conversation_id
        ):
            raise ValueError("conversation scope requires project_id and conversation_id")


@dataclass(frozen=True, slots=True)
class Evidence:
    source_kind: str
    source_id: str
    excerpt: str | None = None
    locator: Mapping[str, Any] = field(default_factory=dict[str, Any])
    captured_at: datetime = field(default_factory=lambda: datetime.now(UTC))


@dataclass(frozen=True, slots=True)
class MemoryRecord:
    id: str
    key: str
    content: str
    kind: MemoryKind
    state: MemoryState
    scope: MemoryScope
    confidence: float
    sensitive: bool
    explicit: bool
    version: int
    supersedes_id: str | None
    conflict_ids: tuple[str, ...]
    evidence: tuple[Evidence, ...]
    created_at: datetime
    updated_at: datetime
    expires_at: datetime | None
    forgotten_at: datetime | None
    metadata: Mapping[str, Any] = field(default_factory=dict[str, Any])


@dataclass(frozen=True, slots=True)
class MemoryUsage:
    id: str
    memory_id: str
    run_id: str
    used_at: datetime
    outcome: str | None = None


@dataclass(frozen=True, slots=True)
class MemorySuggestion:
    id: str
    kind: SuggestionKind
    title: str
    content: str
    scope: MemoryScope
    created_at: datetime
    dismissed_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class MemoryQuery:
    text: str | None = None
    project_id: str | None = None
    conversation_id: str | None = None
    include_global: bool = True
    kinds: tuple[MemoryKind, ...] = ()
    states: tuple[MemoryState, ...] = (MemoryState.ACTIVE,)
    limit: int = 50


def ensure_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        raise ValueError("timestamps must be timezone-aware")
    return value.astimezone(UTC)
