from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from cupcake_runtime.tools.approvals import ApprovalAuthority, ApprovalError
from cupcake_runtime.tools.models import (
    BrokerExecuteRequest,
    DataDestination,
    DataFlowDisclosure,
    Effect,
    ToolDescriptor,
    ToolIntent,
    ToolPreflight,
)
from cupcake_runtime.tools.native import native_tool_descriptors
from cupcake_runtime.tools.orchestrator import ToolAuthorizationError, ToolOrchestrator
from cupcake_runtime.tools.policy import Grant, PolicyDecision, PolicyEngine, PolicyRule
from cupcake_runtime.tools.registry import ToolRegistry


def descriptor(*effects: Effect) -> ToolDescriptor:
    return ToolDescriptor(
        name="test.read",
        version="1.0.0",
        display_name="Test reader",
        description="Read a test resource.",
        input_schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
            "additionalProperties": False,
        },
        output_schema={"type": "object"},
        effects=frozenset(effects or (Effect.READ_FILES,)),
    )


def intent(**arguments: object) -> ToolIntent:
    return ToolIntent(
        "invoke-1", "run-1", "test.read", "1.0.0", arguments or {"path": "a.txt"}, "project-1"
    )


def preflight(
    tool: ToolDescriptor | None = None, current_intent: ToolIntent | None = None
) -> ToolPreflight:
    tool = tool or descriptor()
    current_intent = current_intent or intent()
    flow = DataFlowDisclosure(
        DataDestination.LOCAL, "This device", ("path",), "Read the requested file"
    )
    return ToolPreflight.create(current_intent, tool, ("grant:/a.txt",), (flow,), "ask")


def test_registry_rejects_conflicting_versions_and_bad_arguments() -> None:
    first = descriptor()
    registry = ToolRegistry((first,))
    registry.validate_arguments(first, {"path": "ok"})
    with pytest.raises(ValueError, match="missing required"):
        registry.validate_arguments(first, {})
    with pytest.raises(ValueError, match="unknown tool arguments"):
        registry.validate_arguments(first, {"path": "ok", "surprise": True})
    with pytest.raises(ValueError, match="conflicting"):
        registry.register(replace(first, description="A different descriptor."))


def test_preflight_digest_binds_arguments_resources_and_disclosure() -> None:
    first = preflight(current_intent=intent(path="a.txt"))
    changed_argument = preflight(current_intent=intent(path="b.txt"))
    changed_resource = ToolPreflight.create(
        intent(), descriptor(), ("grant:/b.txt",), first.disclosures, "ask"
    )
    assert first.intent_digest != changed_argument.intent_digest
    assert first.intent_digest != changed_resource.intent_digest
    wire = BrokerExecuteRequest(intent(), replace(first, decision="allow")).to_wire()
    assert wire["request_type"] == "tool.execute"
    assert wire["protocol_version"] == 1
    assert wire["payload"]["preflight"]["effects"] == ["read_files"]
    with pytest.raises(ValueError, match="requires an approval"):
        BrokerExecuteRequest(intent(), first)


def test_policy_precedence_and_forced_fresh_approval() -> None:
    safe = descriptor()
    current = intent()
    digest = preflight(safe, current).intent_digest
    allow_exact = Grant(PolicyDecision.ALLOW, "exact", digest, safe.name)
    deny_rule = PolicyRule(PolicyDecision.DENY, tool_name=safe.name)
    assert (
        PolicyEngine(grants=(allow_exact,)).decide(current, safe, intent_digest=digest)
        == PolicyDecision.ALLOW
    )
    assert (
        PolicyEngine((deny_rule,), (allow_exact,)).decide(current, safe, intent_digest=digest)
        == PolicyDecision.DENY
    )
    dangerous = descriptor(Effect.DELETE)
    dangerous_digest = preflight(dangerous, current).intent_digest
    exact = Grant(PolicyDecision.ALLOW, "exact", dangerous_digest, dangerous.name)
    assert (
        PolicyEngine(grants=(exact,)).decide(current, dangerous, intent_digest=dangerous_digest)
        == PolicyDecision.ASK
    )


def test_approval_is_expiring_bound_and_one_use() -> None:
    authority = ApprovalAuthority(b"a" * 32)
    check = preflight()
    now = datetime(2026, 1, 1, tzinfo=UTC)
    approval = authority.issue("approval-1", check, ttl=timedelta(minutes=1), now=now)
    authority.verify_and_consume(approval, check, now=now + timedelta(seconds=30))
    with pytest.raises(ApprovalError, match="consumed"):
        authority.verify_and_consume(approval, check, now=now + timedelta(seconds=31))

    second = authority.issue("approval-2", check, ttl=timedelta(minutes=1), now=now)
    with pytest.raises(ApprovalError, match="signature"):
        authority.verify_and_consume(
            replace(second, approved_resources=("grant:/other",)), check, now=now
        )
    other = replace(check, intent_digest="0" * 64)
    with pytest.raises(ApprovalError, match="another intent"):
        authority.verify_and_consume(second, other, now=now)

    expired = authority.issue("approval-3", check, ttl=timedelta(seconds=1), now=now)
    with pytest.raises(ApprovalError, match="not currently valid"):
        authority.verify_and_consume(expired, check, now=now + timedelta(seconds=1))


def test_native_surface_has_no_raw_shell_and_covers_required_domains() -> None:
    tools = native_tool_descriptors()
    names = {tool.name for tool in tools}
    assert {
        "files.read",
        "repository.apply_patch",
        "web.search",
        "python.run",
        "models.manage",
        "artifacts.export",
    } <= names
    assert not any("shell" in name for name in names)
    assert next(tool for tool in tools if tool.name == "python.run").effects == frozenset(
        {Effect.EXECUTE_CODE}
    )


def test_orchestrator_validates_preflights_and_emits_redacted_audit() -> None:
    from cupcake_runtime.tools.audit import InMemoryAuditSink

    current_descriptor = descriptor()
    registry = ToolRegistry((current_descriptor,))
    policy = PolicyEngine(rules=(PolicyRule(PolicyDecision.ALLOW, tool_name="test.read"),))
    audit = InMemoryAuditSink()
    orchestrator = ToolOrchestrator(registry, policy, audit, ApprovalAuthority(b"b" * 32))
    checked = orchestrator.preflight(intent(), resolved_resources=("grant:/a.txt",))
    request = orchestrator.authorize(intent(), checked)
    assert request.preflight.decision == "allow"
    assert audit.events[-1].details.get("arguments") is None

    with pytest.raises(ToolAuthorizationError, match="descriptor changed"):
        orchestrator.authorize(intent(), replace(checked, descriptor_identity="other@1"))
