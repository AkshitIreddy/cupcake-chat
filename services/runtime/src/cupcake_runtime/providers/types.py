"""Product-owned provider contracts.

These types deliberately contain no provider SDK objects.  They are safe to
persist, replay in tests, and transport over the desktop protocol.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from decimal import Decimal
from enum import StrEnum
from typing import Any


def uuid7() -> str:
    """Return a sortable UUIDv7-compatible identifier on Python < 3.14."""

    milliseconds = int(time.time() * 1000)
    random_bits = uuid.uuid4().int
    value = (milliseconds & ((1 << 48) - 1)) << 80
    value |= 0x7 << 76
    value |= ((random_bits >> 62) & 0xFFF) << 64
    value |= 0b10 << 62
    value |= random_bits & ((1 << 62) - 1)
    return str(uuid.UUID(int=value))


class PrivacyRoute(StrEnum):
    CLOUD = "cloud"
    LOCAL = "local"
    SELF_HOSTED = "self_hosted"


class SpeedClass(StrEnum):
    FAST = "fast"
    BALANCED = "balanced"
    DELIBERATE = "deliberate"


class CostClass(StrEnum):
    FREE = "free"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    UNKNOWN = "unknown"


class ReasoningEffort(StrEnum):
    NONE = "none"
    MINIMAL = "minimal"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    XHIGH = "xhigh"
    MAX = "max"


class StreamEventType(StrEnum):
    START = "start"
    TEXT_DELTA = "text_delta"
    REASONING_SUMMARY_DELTA = "reasoning_summary_delta"
    TOOL_CALL_START = "tool_call_start"
    TOOL_CALL_DELTA = "tool_call_delta"
    TOOL_CALL_END = "tool_call_end"
    CITATION = "citation"
    USAGE = "usage"
    FINISH = "finish"
    ERROR = "error"


@dataclass(frozen=True, slots=True)
class ModelCapabilities:
    streaming: bool = True
    tools: bool = True
    images: bool = False
    documents: bool = False
    citations: bool = False
    reasoning: bool = False
    structured_output: bool = True


@dataclass(frozen=True, slots=True)
class ModelPricing:
    input_per_million: Decimal | None = None
    output_per_million: Decimal | None = None
    cached_input_per_million: Decimal | None = None
    currency: str = "USD"
    source: str = "provider-published"
    effective_at: str | None = None

    def estimate(self, usage: TokenUsage) -> Decimal | None:
        if self.input_per_million is None or self.output_per_million is None:
            return None
        cached = min(usage.cached_input_tokens, usage.input_tokens)
        uncached = usage.input_tokens - cached
        cached_price = self.cached_input_per_million or self.input_per_million
        return (
            Decimal(uncached) * self.input_per_million
            + Decimal(cached) * cached_price
            + Decimal(usage.output_tokens) * self.output_per_million
        ) / Decimal(1_000_000)


@dataclass(frozen=True, slots=True)
class ModelDescriptor:
    id: str
    provider: str
    model: str
    display_name: str
    family: str
    context_window: int
    max_output_tokens: int | None
    capabilities: ModelCapabilities
    reasoning_efforts: tuple[ReasoningEffort, ...] = ()
    default_reasoning_effort: ReasoningEffort = ReasoningEffort.NONE
    privacy_route: PrivacyRoute = PrivacyRoute.CLOUD
    speed_class: SpeedClass = SpeedClass.BALANCED
    cost_class: CostClass = CostClass.UNKNOWN
    pricing: ModelPricing = field(default_factory=ModelPricing)
    knowledge_cutoff: str | None = None
    deprecated: bool = False
    metadata: Mapping[str, Any] = field(default_factory=dict[str, Any])

    def with_reasoning(self, effort: ReasoningEffort) -> ModelDescriptor:
        if effort not in self.reasoning_efforts:
            raise UnsupportedReasoningEffort(self.id, effort, self.reasoning_efforts)
        return replace(self, default_reasoning_effort=effort)


class UnsupportedReasoningEffort(ValueError):
    def __init__(
        self, model_id: str, requested: ReasoningEffort, supported: Sequence[ReasoningEffort]
    ):
        choices = ", ".join(item.value for item in supported) or "none"
        super().__init__(f"{model_id} does not support {requested.value}; supported: {choices}")


@dataclass(frozen=True, slots=True)
class CanonicalMessage:
    role: str
    content: str
    id: str = field(default_factory=uuid7)
    attachments: tuple[Mapping[str, Any], ...] = ()
    tool_call_id: str | None = None
    name: str | None = None


@dataclass(frozen=True, slots=True)
class ProviderContinuity:
    provider: str
    model_family: str
    opaque_state: Mapping[str, Any]
    issued_at_ms: int = field(default_factory=lambda: int(time.time() * 1000))

    def applies_to(self, descriptor: ModelDescriptor) -> bool:
        return self.provider == descriptor.provider and self.model_family == descriptor.family


@dataclass(frozen=True, slots=True)
class ModelRequest:
    model_id: str
    messages: tuple[CanonicalMessage, ...]
    reasoning_effort: ReasoningEffort | None = None
    max_output_tokens: int | None = None
    temperature: float | None = None
    tools: tuple[Mapping[str, Any], ...] = ()
    continuity: ProviderContinuity | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict[str, Any])


@dataclass(frozen=True, slots=True)
class TokenUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    cached_input_tokens: int = 0
    reasoning_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


@dataclass(frozen=True, slots=True)
class UsageCost:
    amount: Decimal | None
    currency: str
    pricing_source: str
    estimated: bool = True


@dataclass(frozen=True, slots=True)
class NormalizedStreamEvent:
    type: StreamEventType
    sequence: int
    run_id: str
    text: str | None = None
    item_id: str | None = None
    name: str | None = None
    arguments_delta: str | None = None
    citation: Mapping[str, Any] | None = None
    usage: TokenUsage | None = None
    cost: UsageCost | None = None
    continuity: ProviderContinuity | None = None
    finish_reason: str | None = None
    error_code: str | None = None
    retryable: bool | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict[str, Any])
