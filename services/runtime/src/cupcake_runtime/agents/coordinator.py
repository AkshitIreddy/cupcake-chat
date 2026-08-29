"""Policy and budget enforcement for bounded subagents."""

from __future__ import annotations

import time
from collections.abc import Mapping
from threading import RLock

from cupcake_runtime.events import EventJournal, EventKind, RunEvent, deterministic_event_id
from cupcake_runtime.tasks import new_product_id

from .budgets import BudgetExceededError, BudgetLedger
from .executors import DelegateCancelledError, DelegateControl, DelegateExecutor
from .models import (
    AgentRole,
    BudgetLimits,
    BudgetUsage,
    DelegateRequest,
    DelegateResult,
    DelegateStatus,
    RoleProfile,
)
from .registry import DEFAULT_ROLE_PROFILES


class DelegatePolicyError(RuntimeError):
    pass


class DelegateCoordinator:
    def __init__(
        self,
        executor: DelegateExecutor,
        journal: EventJournal,
        parent_budget: BudgetLedger,
        *,
        profiles: Mapping[AgentRole, RoleProfile] = DEFAULT_ROLE_PROFILES,
    ) -> None:
        self.executor = executor
        self.journal = journal
        self.parent_budget = parent_budget
        self.profiles = dict(profiles)
        self._cancelled: set[str] = set()
        self._active: dict[str, tuple[str, DelegateControl]] = {}
        self._lock = RLock()

    def make_request(
        self,
        parent_run_id: str,
        role: AgentRole,
        instruction: str,
        *,
        requested_tools: frozenset[str] = frozenset(),
        budget: BudgetLimits | None = None,
        project_id: str | None = None,
        context: Mapping[str, object] | None = None,
    ) -> DelegateRequest:
        return DelegateRequest(
            delegate_id=new_product_id("delegate"),
            parent_run_id=parent_run_id,
            role=role,
            instruction=instruction,
            requested_tools=requested_tools,
            budget=budget,
            project_id=project_id,
            context=context or {},
        )

    def cancel(self, delegate_id: str) -> None:
        with self._lock:
            self._cancelled.add(delegate_id)
            active = self._active.get(delegate_id)
            if active is not None:
                active[1].cancel()

    def cancel_parent(self, parent_run_id: str) -> int:
        """Propagate parent cancellation to every currently running delegate."""
        with self._lock:
            matching = [
                (delegate_id, control)
                for delegate_id, (run_id, control) in self._active.items()
                if run_id == parent_run_id
            ]
            for delegate_id, control in matching:
                self._cancelled.add(delegate_id)
                control.cancel()
            return len(matching)

    def execute(self, request: DelegateRequest) -> DelegateResult:
        profile = self.profiles[request.role]
        try:
            self._validate(request, profile)
        except (DelegatePolicyError, BudgetExceededError) as exc:
            status = (
                DelegateStatus.BUDGET_EXCEEDED
                if isinstance(exc, BudgetExceededError)
                else DelegateStatus.POLICY_DENIED
            )
            result = DelegateResult(request.delegate_id, status, "", error=str(exc))
            self._emit_finished(request, result)
            return result

        with self._lock:
            was_cancelled = request.delegate_id in self._cancelled
        if was_cancelled:
            result = DelegateResult(request.delegate_id, DelegateStatus.CANCELLED, "")
            self._emit_finished(request, result)
            return result

        delegate_budget = request.budget or profile.default_budget
        try:
            reservation_id = self.parent_budget.reserve(delegate_budget)
        except BudgetExceededError as exc:
            result = DelegateResult(
                request.delegate_id,
                DelegateStatus.BUDGET_EXCEEDED,
                "",
                error=str(exc),
            )
            self._emit_finished(request, result)
            return result

        control = DelegateControl()
        with self._lock:
            self._active[request.delegate_id] = (request.parent_run_id, control)

        self._emit(
            request,
            EventKind.SUBAGENT_STARTED,
            "started",
            {"role": request.role.value, "tools": sorted(request.requested_tools)},
        )
        started = time.monotonic()
        try:
            try:
                result = self.executor.execute(request, profile, control)
            except DelegateCancelledError:
                result = DelegateResult(
                    request.delegate_id,
                    DelegateStatus.CANCELLED,
                    "",
                )
            except Exception as exc:
                result = DelegateResult(
                    request.delegate_id,
                    DelegateStatus.FAILED,
                    "",
                    error=f"{type(exc).__name__}: {exc}",
                )
        finally:
            duration = time.monotonic() - started
            with self._lock:
                self._active.pop(request.delegate_id, None)
        usage_with_duration = type(result.usage)(
            input_tokens=result.usage.input_tokens,
            output_tokens=result.usage.output_tokens,
            tool_calls=result.usage.tool_calls,
            cost_usd=result.usage.cost_usd,
            duration_seconds=max(result.usage.duration_seconds, duration),
        )
        result = DelegateResult(
            result.delegate_id,
            result.status,
            result.content,
            usage_with_duration,
            result.tool_outputs,
            result.error,
        )
        if self._exceeds(delegate_budget, result.usage):
            result = DelegateResult(
                request.delegate_id,
                DelegateStatus.BUDGET_EXCEEDED,
                "",
                usage=result.usage,
                error="delegate exceeded its token, tool, cost or duration budget",
            )
        if control.cancelled:
            result = DelegateResult(
                request.delegate_id,
                DelegateStatus.CANCELLED,
                "",
                usage=result.usage,
            )
        try:
            self.parent_budget.settle(reservation_id, result.usage)
        except BudgetExceededError as exc:
            result = DelegateResult(
                request.delegate_id,
                DelegateStatus.BUDGET_EXCEEDED,
                "",
                usage=result.usage,
                error=str(exc),
            )
        self._emit_finished(request, result)
        return result

    @staticmethod
    def _exceeds(limits: BudgetLimits, usage: BudgetUsage) -> bool:
        return bool(
            usage.input_tokens > limits.max_input_tokens
            or usage.output_tokens > limits.max_output_tokens
            or usage.tool_calls > limits.max_tool_calls
            or usage.cost_usd > limits.max_cost_usd + 1e-12
            or usage.duration_seconds > limits.max_duration_seconds
        )

    def _validate(self, request: DelegateRequest, profile: RoleProfile) -> None:
        if not request.instruction.strip():
            raise DelegatePolicyError("delegate instruction cannot be empty")
        if request.delegation_depth > profile.max_delegation_depth:
            raise DelegatePolicyError("recursive delegation is not allowed for this role")
        denied = request.requested_tools - profile.allowed_tools
        if denied:
            raise DelegatePolicyError("tools not allowed for role: " + ", ".join(sorted(denied)))
        budget = request.budget or profile.default_budget
        defaults = profile.default_budget
        if (
            budget.max_input_tokens > defaults.max_input_tokens
            or budget.max_output_tokens > defaults.max_output_tokens
            or budget.max_tool_calls > defaults.max_tool_calls
            or budget.max_cost_usd > defaults.max_cost_usd
            or budget.max_duration_seconds > defaults.max_duration_seconds
        ):
            raise DelegatePolicyError("delegate budget exceeds the role maximum")

    def _emit_finished(self, request: DelegateRequest, result: DelegateResult) -> None:
        self._emit(
            request,
            EventKind.SUBAGENT_FINISHED,
            "finished",
            {
                "role": request.role.value,
                "status": result.status.value,
                "usage": {
                    "input_tokens": result.usage.input_tokens,
                    "output_tokens": result.usage.output_tokens,
                    "tool_calls": result.usage.tool_calls,
                    "cost_usd": result.usage.cost_usd,
                    "duration_seconds": result.usage.duration_seconds,
                },
                "error": result.error,
            },
        )

    def _emit(
        self,
        request: DelegateRequest,
        kind: EventKind,
        suffix: str,
        payload: Mapping[str, object],
    ) -> None:
        self.journal.append_next(
            RunEvent(
                event_id=deterministic_event_id(
                    request.parent_run_id, f"delegate:{request.delegate_id}:{suffix}"
                ),
                run_id=request.parent_run_id,
                parent_run_id=request.parent_run_id,
                sequence=0,
                kind=kind,
                payload={"delegate_id": request.delegate_id, **payload},
            )
        )
