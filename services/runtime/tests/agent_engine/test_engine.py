from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import pytest
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel

from cupcake_runtime.agent_engine import (
    AgentCancellation,
    CupcakeAgentEngine,
    OutputLimitExceeded,
)
from cupcake_runtime.providers import ProviderRegistry
from cupcake_runtime.providers.base import ProviderConfig
from cupcake_runtime.providers.mock import MOCK_DESCRIPTOR
from cupcake_runtime.providers.types import (
    CanonicalMessage,
    ModelCapabilities,
    ModelDescriptor,
    ModelPricing,
    ModelRequest,
    ReasoningEffort,
    StreamEventType,
)


async def collect(engine: CupcakeAgentEngine, request: ModelRequest, **kwargs: Any):
    return [event async for event in engine.stream(request, **kwargs)]


@dataclass
class FixedFactory:
    model: Any

    def build(
        self,
        descriptor: ModelDescriptor,
        config: ProviderConfig,
        request: ModelRequest,
    ) -> Any:
        del descriptor, config, request
        return self.model


@pytest.mark.asyncio
async def test_real_pydantic_agent_streams_text_usage_cost_and_explicit_personality() -> None:
    observed: dict[str, Any] = {}

    async def stream_function(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str]:
        observed["messages"] = messages
        observed["instructions"] = info.instructions
        observed["settings"] = info.model_settings
        yield "Hello "
        yield "from Pydantic AI."

    model = FunctionModel(stream_function=stream_function, model_name="function-agent")
    registry = ProviderRegistry()
    descriptor = ModelDescriptor(
        id="mock:pydantic-engine",
        provider="mock",
        model="pydantic-engine",
        display_name="Pydantic engine",
        family="mock-v1",
        context_window=16_384,
        max_output_tokens=2_048,
        capabilities=ModelCapabilities(reasoning=False),
        pricing=ModelPricing(
            input_per_million=Decimal("1"),
            output_per_million=Decimal("2"),
            source="test-price",
        ),
    )
    registry.catalog.register(descriptor)
    engine = CupcakeAgentEngine(registry, model_factory=FixedFactory(model))
    request = ModelRequest(
        descriptor.id,
        (
            CanonicalMessage("system", "Never reveal hidden reasoning."),
            CanonicalMessage("user", "Previous question"),
            CanonicalMessage("assistant", "Previous answer"),
            CanonicalMessage("user", "Say hello"),
        ),
        max_output_tokens=200,
        temperature=0.3,
        metadata={"run_id": "agent-run-1"},
    )

    events = await collect(
        engine,
        request,
        personality_instructions=("Be warm and concise.",),
    )
    text = "".join(
        event.text or "" for event in events if event.type == StreamEventType.TEXT_DELTA
    )
    assert text == "Hello from Pydantic AI."
    assert [event.sequence for event in events] == list(range(len(events)))
    assert events[0].metadata["agent_engine"] == "pydantic-ai-core"
    assert events[0].metadata["personality_instructions"] == 1
    usage = next(event for event in events if event.type == StreamEventType.USAGE)
    assert usage.usage is not None
    assert usage.cost is not None
    assert usage.cost.pricing_source == "test-price"
    assert events[-1].type == StreamEventType.FINISH
    assert "Never reveal hidden reasoning." in observed["instructions"]
    assert "Be warm and concise." in observed["instructions"]
    assert observed["settings"]["max_tokens"] == 200
    assert observed["settings"]["temperature"] == 0.3


@pytest.mark.asyncio
async def test_tools_are_deferred_to_broker_and_never_executed_in_python() -> None:
    model = TestModel(call_tools=["web_search"])
    registry = ProviderRegistry()
    engine = CupcakeAgentEngine(registry, model_factory=FixedFactory(model))
    request = ModelRequest(
        MOCK_DESCRIPTOR.id,
        (CanonicalMessage("user", "Find the current documentation"),),
        tools=(
            {
                "id": "native.web.search",
                "name": "web_search",
                "description": "Search the web through the broker",
                "input_schema": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
                "effects": ["network"],
            },
        ),
    )

    events = await collect(engine, request)
    starts = [event for event in events if event.type == StreamEventType.TOOL_CALL_START]
    ends = [event for event in events if event.type == StreamEventType.TOOL_CALL_END]
    assert len(starts) == len(ends) == 1
    assert starts[0].name == "web_search"
    assert starts[0].metadata["destination"] == "rust-broker"
    assert ends[0].metadata["awaiting_broker"] is True
    assert events[-1].type == StreamEventType.FINISH
    assert events[-1].finish_reason == "tool_call"
    assert events[-1].metadata["pending_tool_calls"] == 1


@pytest.mark.asyncio
async def test_cancellation_interrupts_an_in_flight_pydantic_model_stream() -> None:
    entered = asyncio.Event()

    async def slow_stream(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str]:
        del messages, info
        entered.set()
        await asyncio.sleep(60)
        yield "unreachable"

    registry = ProviderRegistry()
    engine = CupcakeAgentEngine(
        registry,
        model_factory=FixedFactory(
            FunctionModel(stream_function=slow_stream, model_name="slow-function")
        ),
    )
    cancellation = AgentCancellation()
    stream = engine.stream(
        ModelRequest(MOCK_DESCRIPTOR.id, (CanonicalMessage("user", "wait"),)),
        cancellation=cancellation,
    )
    first = await anext(stream)
    assert first.type == StreamEventType.START
    pending = asyncio.ensure_future(anext(stream))
    await asyncio.wait_for(entered.wait(), timeout=2)
    cancellation.cancel()
    cancelled = await asyncio.wait_for(pending, timeout=2)
    assert cancelled.type == StreamEventType.ERROR
    assert cancelled.error_code == "cancelled"
    assert cancellation.cancelled
    with pytest.raises(StopAsyncIteration):
        await anext(stream)


def test_prepare_rejects_unsupported_output_without_silent_coercion() -> None:
    registry = ProviderRegistry()
    engine = CupcakeAgentEngine(registry)
    assert MOCK_DESCRIPTOR.max_output_tokens is not None
    with pytest.raises(OutputLimitExceeded):
        engine.prepare(
            ModelRequest(
                MOCK_DESCRIPTOR.id,
                (CanonicalMessage("user", "hello"),),
                max_output_tokens=MOCK_DESCRIPTOR.max_output_tokens + 1,
            )
        )


def test_reasoning_settings_are_explicit_and_provider_specific() -> None:
    registry = ProviderRegistry()
    openai_descriptor = registry.catalog.list(provider="openai")[0]
    settings = CupcakeAgentEngine._model_settings(
        openai_descriptor,
        ModelRequest(
            openai_descriptor.id,
            (CanonicalMessage("user", "reason"),),
            reasoning_effort=ReasoningEffort.HIGH,
        ),
        1_000,
    )
    settings_dict: dict[str, Any] = dict(settings)
    assert settings_dict["openai_reasoning_effort"] == "high"
    assert settings_dict["openai_reasoning_summary"] == "auto"


def test_only_openai_thinking_parts_are_normalized_as_requested_summaries() -> None:
    from pydantic_ai.messages import PartStartEvent, ThinkingPart

    from cupcake_runtime.providers.base import EventBuilder

    registry = ProviderRegistry()
    openai_descriptor = registry.catalog.list(provider="openai")[0]
    anthropic_descriptor = registry.catalog.list(provider="anthropic")[0]
    event = PartStartEvent(index=0, part=ThinkingPart("private or summary"))
    openai_events = CupcakeAgentEngine._normalize_pydantic_event(
        openai_descriptor, EventBuilder(openai_descriptor), event, set()
    )
    anthropic_events = CupcakeAgentEngine._normalize_pydantic_event(
        anthropic_descriptor, EventBuilder(anthropic_descriptor), event, set()
    )
    assert openai_events[0].type == StreamEventType.REASONING_SUMMARY_DELTA
    assert openai_events[0].metadata["summary"] is True
    assert anthropic_events == []


def test_continuity_contains_only_scoped_opaque_response_id() -> None:
    registry = ProviderRegistry()
    descriptor = registry.catalog.list(provider="openai")[0]
    response = ModelResponse(
        [TextPart("answer")],
        provider_response_id="resp_123",
        provider_details={"hidden": "must-not-cross"},
    )
    continuity = CupcakeAgentEngine._continuity(descriptor, response)
    assert continuity is not None
    assert continuity.provider == descriptor.provider
    assert continuity.model_family == descriptor.family
    assert continuity.opaque_state == {"response_id": "resp_123"}
