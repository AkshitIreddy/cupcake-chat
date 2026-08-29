"""Product-owned delegate roles and default limits."""

from __future__ import annotations

from .models import AgentRole, BudgetLimits, RoleProfile

DEFAULT_ROLE_PROFILES = {
    AgentRole.RESEARCHER: RoleProfile(
        role=AgentRole.RESEARCHER,
        system_purpose=(
            "Collect and synthesize attributable evidence without changing project files."
        ),
        allowed_tools=frozenset({"web.search", "web.fetch", "project.read", "memory.search"}),
        default_budget=BudgetLimits(max_output_tokens=6_000, max_tool_calls=16, max_cost_usd=2.0),
    ),
    AgentRole.CODER: RoleProfile(
        role=AgentRole.CODER,
        system_purpose="Prepare scoped code changes and verified patch proposals.",
        allowed_tools=frozenset(
            {"project.read", "repo.inspect", "patch.propose", "sandbox.python", "test.run"}
        ),
        default_budget=BudgetLimits(max_output_tokens=8_000, max_tool_calls=20, max_cost_usd=3.0),
    ),
    AgentRole.REVIEWER: RoleProfile(
        role=AgentRole.REVIEWER,
        system_purpose="Review evidence and code for correctness, risk and missing tests.",
        allowed_tools=frozenset({"project.read", "repo.inspect", "test.read", "artifact.read"}),
        default_budget=BudgetLimits(max_output_tokens=5_000, max_tool_calls=10, max_cost_usd=1.5),
    ),
    AgentRole.DOCUMENT_ANALYST: RoleProfile(
        role=AgentRole.DOCUMENT_ANALYST,
        system_purpose="Extract, cite and compare structured content from provided documents.",
        allowed_tools=frozenset(
            {"file.read", "document.parse", "document.search", "artifact.propose"}
        ),
        default_budget=BudgetLimits(max_output_tokens=7_000, max_tool_calls=14, max_cost_usd=2.0),
    ),
}


def get_role_profile(role: AgentRole) -> RoleProfile:
    return DEFAULT_ROLE_PROFILES[role]
