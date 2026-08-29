from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from .models import utc_now


@dataclass(frozen=True, slots=True)
class AuditEvent:
    event_id: str
    kind: str
    outcome: str
    invocation_id: str | None = None
    run_id: str | None = None
    task_id: str | None = None
    actor: str = "runtime"
    details: Mapping[str, Any] = field(default_factory=dict[str, Any])
    occurred_at: datetime = field(default_factory=utc_now)


class AuditSink(Protocol):
    def record(self, event: AuditEvent) -> None: ...


class InMemoryAuditSink:
    def __init__(self) -> None:
        self.events: list[AuditEvent] = []

    def record(self, event: AuditEvent) -> None:
        self.events.append(event)
