"""Product-owned tool orchestration contracts.

This package intentionally contains no process execution implementation.  It
builds immutable, auditable requests for the native ToolBroker.
"""

from .approvals import ApprovalAuthority, ApprovalError
from .audit import AuditEvent, AuditSink, InMemoryAuditSink
from .models import (
    ApprovalBinding,
    BrokerApprovalRequest,
    BrokerCancelRequest,
    BrokerExecuteRequest,
    BrokerPreflightRequest,
    DataDestination,
    DataFlowDisclosure,
    Effect,
    ToolDescriptor,
    ToolIntent,
    ToolPreflight,
    ToolResult,
)
from .native import native_tool_descriptors
from .orchestrator import ToolAuthorizationError, ToolOrchestrator
from .policy import Grant, PolicyDecision, PolicyEngine, PolicyRule
from .registry import ToolRegistry

__all__ = [
    "ApprovalAuthority",
    "ApprovalBinding",
    "ApprovalError",
    "AuditEvent",
    "AuditSink",
    "BrokerApprovalRequest",
    "BrokerCancelRequest",
    "BrokerExecuteRequest",
    "BrokerPreflightRequest",
    "DataDestination",
    "DataFlowDisclosure",
    "Effect",
    "Grant",
    "InMemoryAuditSink",
    "PolicyDecision",
    "PolicyEngine",
    "PolicyRule",
    "ToolAuthorizationError",
    "ToolDescriptor",
    "ToolIntent",
    "ToolOrchestrator",
    "ToolPreflight",
    "ToolRegistry",
    "ToolResult",
    "native_tool_descriptors",
]
