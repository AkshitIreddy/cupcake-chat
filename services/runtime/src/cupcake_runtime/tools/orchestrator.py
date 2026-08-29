from __future__ import annotations

from collections.abc import Sequence

from cupcake_runtime.domain.ids import new_id

from .approvals import ApprovalAuthority
from .audit import AuditEvent, AuditSink
from .models import (
    ApprovalBinding,
    BrokerExecuteRequest,
    DataFlowDisclosure,
    ToolIntent,
    ToolPreflight,
    ToolResult,
)
from .policy import PolicyDecision, PolicyEngine
from .registry import ToolRegistry


class ToolAuthorizationError(PermissionError):
    pass


class ToolOrchestrator:
    """Prepares and authorizes broker work without executing it in Python."""

    def __init__(
        self,
        registry: ToolRegistry,
        policy: PolicyEngine,
        audit: AuditSink,
        approvals: ApprovalAuthority,
    ) -> None:
        self._registry = registry
        self._policy = policy
        self._audit = audit
        self._approvals = approvals

    def preflight(
        self,
        intent: ToolIntent,
        *,
        resolved_resources: Sequence[str],
        disclosures: Sequence[DataFlowDisclosure] = (),
        session_id: str | None = None,
    ) -> ToolPreflight:
        descriptor = self._registry.get(intent.tool_name, intent.tool_version)
        self._registry.validate_arguments(descriptor, intent.arguments)
        flows = tuple(descriptor.default_data_flows) + tuple(disclosures)
        provisional = ToolPreflight.create(
            intent,
            descriptor,
            resolved_resources,
            flows,
            PolicyDecision.ASK.value,
        )
        decision = self._policy.decide(
            intent,
            descriptor,
            intent_digest=provisional.intent_digest,
            session_id=session_id,
        )
        result = ToolPreflight.create(
            intent,
            descriptor,
            resolved_resources,
            flows,
            decision.value,
        )
        self._audit.record(
            AuditEvent(
                event_id=new_id(),
                kind="tool.preflight",
                outcome=decision.value,
                invocation_id=intent.invocation_id,
                run_id=intent.run_id,
                task_id=intent.task_id,
                details={
                    "tool": descriptor.identity,
                    "intent_digest": result.intent_digest,
                    "effect_count": len(result.effects),
                    "resource_count": len(result.resolved_resources),
                    "destinations": sorted({flow.destination.value for flow in result.disclosures}),
                },
            )
        )
        return result

    def authorize(
        self,
        intent: ToolIntent,
        preflight: ToolPreflight,
        approval: ApprovalBinding | None = None,
    ) -> BrokerExecuteRequest:
        descriptor = self._registry.get(intent.tool_name, intent.tool_version)
        if descriptor.identity != preflight.descriptor_identity:
            raise ToolAuthorizationError("tool descriptor changed after preflight")
        if descriptor.schema_digest != preflight.schema_digest:
            raise ToolAuthorizationError("tool schema changed after preflight")
        if preflight.decision == PolicyDecision.DENY:
            raise ToolAuthorizationError("tool policy denied this invocation")
        if preflight.decision == PolicyDecision.ASK or preflight.requires_fresh_approval:
            if approval is None:
                raise ToolAuthorizationError("this invocation requires approval")
            self._approvals.verify_and_consume(approval, preflight)
        request = BrokerExecuteRequest(intent, preflight, approval)
        self._audit.record(
            AuditEvent(
                event_id=new_id(),
                kind="tool.authorized",
                outcome="approved" if approval else "policy_allow",
                invocation_id=intent.invocation_id,
                run_id=intent.run_id,
                task_id=intent.task_id,
                details={"tool": descriptor.identity, "intent_digest": preflight.intent_digest},
            )
        )
        return request

    def record_result(self, result: ToolResult, *, run_id: str, task_id: str | None = None) -> None:
        self._audit.record(
            AuditEvent(
                event_id=new_id(),
                kind="tool.result",
                outcome=result.status,
                invocation_id=result.invocation_id,
                run_id=run_id,
                task_id=task_id,
                details={
                    "error_code": result.error_code,
                    "artifact_count": len(result.artifacts),
                },
            )
        )
