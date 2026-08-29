"""Bounded subagent contracts."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class AgentRole(StrEnum):
    RESEARCHER = "researcher"
    CODER = "coder"
    REVIEWER = "reviewer"
    DOCUMENT_ANALYST = "document_analyst"


class DelegateStatus(StrEnum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    BUDGET_EXCEEDED = "budget_exceeded"
    POLICY_DENIED = "policy_denied"


@dataclass(frozen=True, slots=True)
class BudgetLimits:
    max_input_tokens: int = 24_000
    max_output_tokens: int = 8_000
    max_tool_calls: int = 12
    max_cost_usd: float = 2.0
    max_duration_seconds: float = 300.0

    def __post_init__(self) -> None:
        if (
            min(
                self.max_input_tokens,
                self.max_output_tokens,
                self.max_tool_calls,
                self.max_cost_usd,
                self.max_duration_seconds,
            )
            < 0
        ):
            raise ValueError("budget limits cannot be negative")


@dataclass(frozen=True, slots=True)
class BudgetUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    tool_calls: int = 0
    cost_usd: float = 0.0
    duration_seconds: float = 0.0

    def __add__(self, other: BudgetUsage) -> BudgetUsage:
        return BudgetUsage(
            input_tokens=self.input_tokens + other.input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
            tool_calls=self.tool_calls + other.tool_calls,
            cost_usd=self.cost_usd + other.cost_usd,
            duration_seconds=self.duration_seconds + other.duration_seconds,
        )


@dataclass(frozen=True, slots=True)
class RoleProfile:
    role: AgentRole
    system_purpose: str
    allowed_tools: frozenset[str]
    default_budget: BudgetLimits
    max_delegation_depth: int = 1


@dataclass(frozen=True, slots=True)
class DelegateRequest:
    delegate_id: str
    parent_run_id: str
    role: AgentRole
    instruction: str
    requested_tools: frozenset[str] = frozenset()
    budget: BudgetLimits | None = None
    project_id: str | None = None
    delegation_depth: int = 1
    context: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class DelegateResult:
    delegate_id: str
    status: DelegateStatus
    content: str
    usage: BudgetUsage = BudgetUsage()
    tool_outputs: tuple[Mapping[str, Any], ...] = ()
    error: str | None = None
