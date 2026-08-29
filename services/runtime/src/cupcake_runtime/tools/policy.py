from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from .models import FRESH_APPROVAL_EFFECTS, Effect, ToolDescriptor, ToolIntent


class PolicyDecision(StrEnum):
    DENY = "deny"
    ALLOW = "allow"
    ASK = "ask"


@dataclass(frozen=True, slots=True)
class PolicyRule:
    decision: PolicyDecision
    tool_name: str | None = None
    category: str | None = None
    effect: Effect | None = None
    project_id: str | None = None

    def matches(self, intent: ToolIntent, descriptor: ToolDescriptor) -> bool:
        return (
            (self.tool_name is None or self.tool_name == descriptor.name)
            and (self.category is None or self.category == descriptor.category)
            and (self.effect is None or self.effect in descriptor.effects)
            and (self.project_id is None or self.project_id == intent.project_id)
        )


@dataclass(frozen=True, slots=True)
class Grant:
    decision: PolicyDecision
    scope: str
    value: str
    tool_name: str | None = None

    def __post_init__(self) -> None:
        if self.scope not in {"exact", "session", "project"}:
            raise ValueError("grant scope must be exact, session, or project")


class PolicyEngine:
    """Deterministic precedence: deny, exact, session/project, category, ask."""

    def __init__(self, rules: tuple[PolicyRule, ...] = (), grants: tuple[Grant, ...] = ()) -> None:
        self.rules = rules
        self.grants = grants

    def decide(
        self,
        intent: ToolIntent,
        descriptor: ToolDescriptor,
        *,
        intent_digest: str,
        session_id: str | None = None,
    ) -> PolicyDecision:
        matching_rules = tuple(rule for rule in self.rules if rule.matches(intent, descriptor))
        if any(rule.decision == PolicyDecision.DENY for rule in matching_rules):
            return PolicyDecision.DENY
        if any(
            grant.decision == PolicyDecision.DENY
            and self._grant_matches(grant, intent, descriptor, intent_digest, session_id)
            for grant in self.grants
        ):
            return PolicyDecision.DENY
        # Irreversible/high-impact categories always use a one-shot approval.
        if descriptor.effects & FRESH_APPROVAL_EFFECTS:
            return PolicyDecision.ASK
        for scope in ("exact", "session", "project"):
            if any(
                grant.scope == scope
                and grant.decision == PolicyDecision.ALLOW
                and self._grant_matches(grant, intent, descriptor, intent_digest, session_id)
                for grant in self.grants
            ):
                return PolicyDecision.ALLOW
        if any(rule.decision == PolicyDecision.ALLOW for rule in matching_rules):
            return PolicyDecision.ALLOW
        return PolicyDecision.ASK

    @staticmethod
    def _grant_matches(
        grant: Grant,
        intent: ToolIntent,
        descriptor: ToolDescriptor,
        intent_digest: str,
        session_id: str | None,
    ) -> bool:
        if grant.tool_name not in {None, descriptor.name}:
            return False
        expected = {
            "exact": intent_digest,
            "session": session_id,
            "project": intent.project_id,
        }[grant.scope]
        return expected is not None and grant.value == expected
