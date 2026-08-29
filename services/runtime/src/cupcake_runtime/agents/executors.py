"""Optional model-backed and deterministic delegate executors."""

from __future__ import annotations

import hashlib
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from threading import Event
from typing import Any, Protocol

from .models import BudgetUsage, DelegateRequest, DelegateResult, DelegateStatus, RoleProfile


class DelegateCancelledError(RuntimeError):
    pass


class DelegateControl:
    """Cooperative cancellation shared by a parent run and its delegate."""

    def __init__(self) -> None:
        self._cancelled = Event()

    @property
    def cancelled(self) -> bool:
        return self._cancelled.is_set()

    def cancel(self) -> None:
        self._cancelled.set()

    def wait(self, timeout: float | None = None) -> bool:
        """Wait until cancelled; useful for cooperative tool/provider adapters."""
        return self._cancelled.wait(timeout)

    def raise_if_cancelled(self) -> None:
        if self.cancelled:
            raise DelegateCancelledError("delegate cancelled")


class DelegateExecutor(Protocol):
    def execute(
        self,
        request: DelegateRequest,
        profile: RoleProfile,
        control: DelegateControl,
    ) -> DelegateResult: ...


@dataclass
class DeterministicDelegateExecutor:
    responses: Mapping[str, str] = field(default_factory=dict)
    usage: BudgetUsage = field(
        default_factory=lambda: BudgetUsage(input_tokens=100, output_tokens=50)
    )
    calls: list[str] = field(default_factory=list)

    def execute(
        self,
        request: DelegateRequest,
        profile: RoleProfile,
        control: DelegateControl,
    ) -> DelegateResult:
        control.raise_if_cancelled()
        self.calls.append(request.delegate_id)
        digest = hashlib.sha256(
            f"{request.role.value}\0{request.instruction}".encode()
        ).hexdigest()[:12]
        result = DelegateResult(
            delegate_id=request.delegate_id,
            status=DelegateStatus.SUCCEEDED,
            content=self.responses.get(request.role.value, f"deterministic:{digest}"),
            usage=self.usage,
        )
        control.raise_if_cancelled()
        return result


class PydanticAIExecutor:
    """Duck-typed Pydantic AI adapter with no mandatory runtime dependency.

    `agent_factory` receives the role profile and must return an object exposing
    `run_sync(prompt, deps=...)`. Applications can supply a real `pydantic_ai.Agent`
    factory; tests stay deterministic and dependency-free.
    """

    def __init__(self, agent_factory: Any) -> None:
        self._agent_factory = agent_factory

    def execute(
        self,
        request: DelegateRequest,
        profile: RoleProfile,
        control: DelegateControl,
    ) -> DelegateResult:
        control.raise_if_cancelled()
        started = time.monotonic()
        agent = self._agent_factory(profile)
        result = agent.run_sync(
            request.instruction,
            deps={
                "project_id": request.project_id,
                "allowed_tools": sorted(request.requested_tools),
                "context": dict(request.context),
                "cancellation": control,
            },
        )
        control.raise_if_cancelled()
        usage_object = result.usage() if callable(getattr(result, "usage", None)) else None
        usage = BudgetUsage(
            input_tokens=int(getattr(usage_object, "input_tokens", 0) or 0),
            output_tokens=int(getattr(usage_object, "output_tokens", 0) or 0),
            tool_calls=int(getattr(usage_object, "tool_calls", 0) or 0),
            cost_usd=float(getattr(usage_object, "cost_usd", 0.0) or 0.0),
            duration_seconds=time.monotonic() - started,
        )
        return DelegateResult(
            delegate_id=request.delegate_id,
            status=DelegateStatus.SUCCEEDED,
            content=str(getattr(result, "output", result)),
            usage=usage,
        )
