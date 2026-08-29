from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

PROTOCOL_VERSION = 1


def utc_now() -> datetime:
    return datetime.now(UTC)


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )


def digest_payload(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


class Effect(StrEnum):
    READ_FILES = "read_files"
    WRITE_FILES = "write_files"
    NETWORK = "network"
    EXECUTE_CODE = "execute_code"
    DELETE = "delete"
    EXTERNAL_COMMUNICATION = "external_communication"
    MONEY = "money"
    INSTALL = "install"
    SYSTEM_CHANGE = "system_change"
    UNSANDBOXED_EXECUTION = "unsandboxed_execution"


FRESH_APPROVAL_EFFECTS = frozenset(
    {
        Effect.DELETE,
        Effect.EXTERNAL_COMMUNICATION,
        Effect.MONEY,
        Effect.INSTALL,
        Effect.SYSTEM_CHANGE,
        Effect.UNSANDBOXED_EXECUTION,
    }
)


class DataDestination(StrEnum):
    LOCAL = "local"
    PROVIDER = "provider"
    MCP_SERVER = "mcp_server"
    PUBLIC_WEB = "public_web"


@dataclass(frozen=True, slots=True)
class DataFlowDisclosure:
    destination: DataDestination
    destination_label: str
    categories: tuple[str, ...]
    purpose: str
    contains_user_content: bool = False

    def __post_init__(self) -> None:
        if not self.destination_label.strip() or not self.purpose.strip():
            raise ValueError("data-flow destination and purpose must be non-empty")
        if not self.categories:
            raise ValueError("data-flow categories must not be empty")


@dataclass(frozen=True, slots=True)
class ToolDescriptor:
    name: str
    version: str
    display_name: str
    description: str
    input_schema: Mapping[str, Any]
    output_schema: Mapping[str, Any]
    effects: frozenset[Effect]
    required_grants: tuple[str, ...] = ()
    default_data_flows: tuple[DataFlowDisclosure, ...] = ()
    timeout_seconds: int = 60
    cancellable: bool = True
    category: str = "native"

    def __post_init__(self) -> None:
        if not self.name or not all(
            part.replace("_", "").isalnum() for part in self.name.split(".")
        ):
            raise ValueError("tool name must be a dotted alphanumeric identifier")
        if not self.version or not self.display_name.strip() or not self.description.strip():
            raise ValueError("tool version, display name and description are required")
        if self.input_schema.get("type") != "object":
            raise ValueError("tool input schema must describe an object")
        if self.timeout_seconds < 1 or self.timeout_seconds > 86_400:
            raise ValueError("timeout must be between 1 and 86400 seconds")

    @property
    def identity(self) -> str:
        return f"{self.name}@{self.version}"

    @property
    def schema_digest(self) -> str:
        return digest_payload({"input": self.input_schema, "output": self.output_schema})


@dataclass(frozen=True, slots=True)
class ToolIntent:
    invocation_id: str
    run_id: str
    tool_name: str
    tool_version: str
    arguments: Mapping[str, Any]
    project_id: str | None = None
    task_id: str | None = None
    requested_at: datetime = field(default_factory=utc_now)

    def __post_init__(self) -> None:
        if not self.invocation_id or not self.run_id or not self.tool_name or not self.tool_version:
            raise ValueError("intent identity fields are required")
        canonical_json(self.arguments)


@dataclass(frozen=True, slots=True)
class ToolPreflight:
    invocation_id: str
    descriptor_identity: str
    schema_digest: str
    resolved_resources: tuple[str, ...]
    effects: frozenset[Effect]
    disclosures: tuple[DataFlowDisclosure, ...]
    decision: str
    requires_fresh_approval: bool
    intent_digest: str
    created_at: datetime = field(default_factory=utc_now)

    def __post_init__(self) -> None:
        if self.decision not in {"allow", "ask", "deny"}:
            raise ValueError("preflight decision must be allow, ask, or deny")

    @staticmethod
    def create(
        intent: ToolIntent,
        descriptor: ToolDescriptor,
        resolved_resources: Sequence[str],
        disclosures: Sequence[DataFlowDisclosure],
        decision: str,
    ) -> ToolPreflight:
        resources = tuple(sorted(set(resolved_resources)))
        flows = tuple(disclosures)
        digest = digest_payload(
            {
                "invocation_id": intent.invocation_id,
                "run_id": intent.run_id,
                "task_id": intent.task_id,
                "project_id": intent.project_id,
                "tool": descriptor.identity,
                "schema_digest": descriptor.schema_digest,
                "arguments": intent.arguments,
                "resolved_resources": resources,
                "effects": sorted(effect.value for effect in descriptor.effects),
                "disclosures": [_wire(flow) for flow in flows],
            }
        )
        return ToolPreflight(
            invocation_id=intent.invocation_id,
            descriptor_identity=descriptor.identity,
            schema_digest=descriptor.schema_digest,
            resolved_resources=resources,
            effects=descriptor.effects,
            disclosures=flows,
            decision=decision,
            requires_fresh_approval=bool(descriptor.effects & FRESH_APPROVAL_EFFECTS),
            intent_digest=digest,
        )


@dataclass(frozen=True, slots=True)
class ApprovalBinding:
    approval_id: str
    invocation_id: str
    intent_digest: str
    approved_effects: frozenset[Effect]
    approved_resources: tuple[str, ...]
    issued_at: datetime
    expires_at: datetime
    nonce: str
    signature: str


@dataclass(frozen=True, slots=True)
class ToolResult:
    invocation_id: str
    status: str
    output: Any = None
    error_code: str | None = None
    error_message: str | None = None
    artifacts: tuple[str, ...] = ()
    started_at: datetime | None = None
    finished_at: datetime = field(default_factory=utc_now)

    def __post_init__(self) -> None:
        if self.status not in {"succeeded", "failed", "cancelled", "denied"}:
            raise ValueError("invalid tool result status")
        if self.status == "failed" and not self.error_code:
            raise ValueError("failed results require an error code")


@dataclass(frozen=True, slots=True)
class BrokerPreflightRequest:
    intent: ToolIntent
    descriptor: ToolDescriptor
    request_type: str = field(default="tool.preflight", init=False)

    def to_wire(self) -> dict[str, Any]:
        return _broker_wire(
            self.request_type, {"intent": _wire(self.intent), "descriptor": _wire(self.descriptor)}
        )


@dataclass(frozen=True, slots=True)
class BrokerApprovalRequest:
    preflight: ToolPreflight
    approval: ApprovalBinding
    request_type: str = field(default="tool.approval.verify", init=False)

    def __post_init__(self) -> None:
        if self.preflight.invocation_id != self.approval.invocation_id:
            raise ValueError("approval and preflight invocation IDs differ")
        if self.preflight.intent_digest != self.approval.intent_digest:
            raise ValueError("approval and preflight intent digests differ")

    def to_wire(self) -> dict[str, Any]:
        return _broker_wire(
            self.request_type,
            {"preflight": _wire(self.preflight), "approval": _wire(self.approval)},
        )


@dataclass(frozen=True, slots=True)
class BrokerExecuteRequest:
    intent: ToolIntent
    preflight: ToolPreflight
    approval: ApprovalBinding | None = None
    request_type: str = field(default="tool.execute", init=False)

    def __post_init__(self) -> None:
        if self.intent.invocation_id != self.preflight.invocation_id:
            raise ValueError("intent and preflight invocation IDs differ")
        if self.preflight.decision == "deny":
            raise ValueError("denied preflight cannot be executed")
        if (
            self.preflight.decision == "ask" or self.preflight.requires_fresh_approval
        ) and not self.approval:
            raise ValueError("preflight requires an approval")
        if self.approval and (
            self.approval.invocation_id != self.preflight.invocation_id
            or self.approval.intent_digest != self.preflight.intent_digest
        ):
            raise ValueError("approval is bound to another preflight")

    def to_wire(self) -> dict[str, Any]:
        return _broker_wire(
            self.request_type,
            {
                "intent": _wire(self.intent),
                "preflight": _wire(self.preflight),
                "approval": _wire(self.approval),
            },
        )


@dataclass(frozen=True, slots=True)
class BrokerCancelRequest:
    invocation_id: str
    reason: str
    request_type: str = field(default="tool.cancel", init=False)

    def to_wire(self) -> dict[str, Any]:
        return _broker_wire(
            self.request_type, {"invocation_id": self.invocation_id, "reason": self.reason}
        )


def _broker_wire(request_type: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "protocol_version": PROTOCOL_VERSION,
        "request_type": request_type,
        "payload": _wire(payload),
    }


def _wire(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
    if isinstance(value, StrEnum):
        return value.value
    if isinstance(value, frozenset | set):
        return sorted(_wire(item) for item in value)
    if isinstance(value, tuple | list):
        return [_wire(item) for item in value]
    if isinstance(value, Mapping):
        return {str(key): _wire(item) for key, item in value.items()}
    if hasattr(value, "__dataclass_fields__"):
        return _wire(asdict(value))
    return value
