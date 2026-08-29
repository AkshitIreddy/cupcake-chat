"""Task step executor interfaces and a deterministic test/development executor."""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from .models import TaskStep


@dataclass(frozen=True, slots=True)
class StepContext:
    run_id: str
    task_id: str
    project_id: str | None
    steering: tuple[str, ...] = ()


class StepExecutor(Protocol):
    def execute(
        self,
        step: TaskStep,
        context: StepContext,
        *,
        idempotency_key: str,
    ) -> Mapping[str, Any]: ...


@dataclass
class DeterministicFakeExecutor:
    """Predictable executor with injectable operations and call accounting."""

    operations: Mapping[str, Callable[[TaskStep, StepContext, str], Mapping[str, Any]]] = field(
        default_factory=dict
    )
    calls: list[tuple[str, str]] = field(default_factory=list)

    def execute(
        self,
        step: TaskStep,
        context: StepContext,
        *,
        idempotency_key: str,
    ) -> Mapping[str, Any]:
        self.calls.append((step.key, idempotency_key))
        operation = self.operations.get(step.operation)
        if operation is not None:
            return operation(step, context, idempotency_key)
        digest = hashlib.sha256(
            f"{step.operation}\0{step.key}\0{idempotency_key}".encode()
        ).hexdigest()[:16]
        return {
            "operation": step.operation,
            "step_key": step.key,
            "result": f"fake_{digest}",
            "steering": list(context.steering),
        }
