from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import pytest
from httpx2 import AsyncClient, MockTransport, Request, Response
from openai import AsyncOpenAI
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models import Model
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.settings import ModelSettings

from cupcake_runtime.agent_engine import (
    AgentCancellation,
    CupcakeAgentEngine,
    OutputLimitExceeded,
)
from cupcake_runtime.providers import ProviderRegistry
from cupcake_runtime.providers.base import EventBuilder, ProviderConfig
from cupcake_runtime.providers.mock import MOCK_DESCRIPTOR
from cupcake_runtime.providers.nvidia_nim import NVIDIA_NIM_PROVIDER, build_pydantic_model
from cupcake_runtime.providers.types import (
    CanonicalMessage,
    ModelCapabilities,
    ModelDescriptor,
    ModelPricing,
    ModelRequest,
    NormalizedStreamEvent,
    ProviderContinuity,
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


class NonStreamingTestModel(TestModel):
    """Exercise the ordinary-request fallback used by CohereModel."""

    request_stream = Model.request_stream


class CupcakeAgentEngineProbe(CupcakeAgentEngine):
    """Typed probes for implementation-level normalization contracts."""

    @staticmethod
    def model_settings_for_test(
        descriptor: ModelDescriptor,
        request: ModelRequest,
        output_tokens: int,
    ) -> ModelSettings:
        return CupcakeAgentEngineProbe._model_settings(
            descriptor,
            request,
            output_tokens,
        )

    @staticmethod
    def normalize_event_for_test(
        descriptor: ModelDescriptor,
        builder: EventBuilder,
        event: Any,
        open_calls: set[str],
    ) -> list[NormalizedStreamEvent]:
        return CupcakeAgentEngineProbe._normalize_pydantic_event(
            descriptor,
            builder,
            event,
            open_calls,
        )

    @staticmethod
    def continuity_for_test(
        descriptor: ModelDescriptor,
        response: ModelResponse | None,
    ) -> ProviderContinuity | None:
        return CupcakeAgentEngineProbe._continuity(descriptor, response)


@pytest.mark.asyncio
async def test_real_pydantic_agent_streams_text_usage_cost_and_explicit_personality() -> None:
    observed: dict[str, Any] = {}

    async def stream_function(messages: list[ModelMessage], info: AgentInfo) -> AsyncIterator[str]:
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
    text = "".join(event.text or "" for event in events if event.type == StreamEventType.TEXT_DELTA)
    assert text == "Hello from Pydantic AI."
    assert [event.sequence for event in events] == list(range(len(events)))
    assert events[0].metadata["agent_engine"] == "pydantic-ai-core"
    assert events[0].metadata["personality_instructions"] == 1
    usage = next(event for event in events if event.type == StreamEventType.USAGE)
    assert usage.usage is not None
    assert usage.cost is not None
    assert usage.cost.pricing_source == "test-price"
    assert events[-1].type == StreamEventType.FINISH
    rendered_instructions = (
        observed["instructions"]
        if isinstance(observed["instructions"], str)
        else "\n".join(observed["instructions"])
    )
    assert "untrusted reference material" in rendered_instructions.lower()
    assert "state only claims directly supported by the shown calculation" in (
        rendered_instructions.lower()
    )
    assert "do not extrapolate" in rendered_instructions.lower()
    assert "Never reveal hidden reasoning." in observed["instructions"]
    assert "Be warm and concise." in observed["instructions"]
    assert observed["settings"]["max_tokens"] == 200
    assert observed["settings"]["temperature"] == 0.3


@pytest.mark.asyncio
async def test_non_streaming_pydantic_model_is_normalized_to_text_events() -> None:
    registry = ProviderRegistry()
    model = NonStreamingTestModel(custom_output_text="Fallback response")
    engine = CupcakeAgentEngine(registry, model_factory=FixedFactory(model))

    events = await collect(
        engine,
        ModelRequest(
            MOCK_DESCRIPTOR.id,
            (CanonicalMessage("user", "Use the ordinary request path"),),
            max_output_tokens=128,
        ),
    )

    assert [event.type for event in events] == [
        StreamEventType.START,
        StreamEventType.TEXT_DELTA,
        StreamEventType.USAGE,
        StreamEventType.FINISH,
    ]
    assert events[1].text == "Fallback response"


@pytest.mark.asyncio
async def test_nvidia_nim_non_thinking_setting_reaches_openai_chat_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    async def capture(request: Request) -> Response:
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        stream = "".join(
            (
                'data: {"id":"chatcmpl-nim","object":"chat.completion.chunk",'
                '"created":1,"model":"nvidia/nemotron-test","choices":[{"index":0,'
                '"delta":{"role":"assistant","content":"safe answer"},'
                '"finish_reason":null}]}\n\n',
                'data: {"id":"chatcmpl-nim","object":"chat.completion.chunk",'
                '"created":1,"model":"nvidia/nemotron-test","choices":[{"index":0,'
                '"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,'
                '"completion_tokens":2,"total_tokens":6}}\n\n',
                "data: [DONE]\n\n",
            )
        )
        return Response(200, headers={"content-type": "text/event-stream"}, content=stream)

    async with AsyncClient(transport=MockTransport(capture)) as http_client:
        client = AsyncOpenAI(
            api_key="recorded-test-key",
            base_url="https://integrate.api.nvidia.com/v1",
            http_client=http_client,
            max_retries=0,
        )
        provider = OpenAIProvider(openai_client=client)

        def recorded_provider(**_kwargs: Any) -> OpenAIProvider:
            return provider

        monkeypatch.setattr(
            "pydantic_ai.providers.openai.OpenAIProvider",
            recorded_provider,
        )
        model = build_pydantic_model("nvidia/nemotron-test", api_key="recorded-test-key")
        assert isinstance(model, OpenAIChatModel)
        assert model.settings is not None
        assert model.settings.get("extra_body") == {
            "chat_template_kwargs": {"enable_thinking": False}
        }
        descriptor = ModelDescriptor(
            id="nvidia-nim:nvidia/nemotron-test",
            provider=NVIDIA_NIM_PROVIDER,
            model="nvidia/nemotron-test",
            display_name="Recorded NVIDIA NIM",
            family="nvidia-nim:nemotron-test",
            context_window=8_192,
            max_output_tokens=1_024,
            capabilities=ModelCapabilities(reasoning=True),
            reasoning_efforts=(ReasoningEffort.NONE, ReasoningEffort.HIGH),
        )
        registry = ProviderRegistry()
        registry.catalog.register(descriptor)
        registry.configure(NVIDIA_NIM_PROVIDER, ProviderConfig(api_key="recorded-test-key"))
        engine = CupcakeAgentEngine(registry, model_factory=FixedFactory(model))

        events = await collect(
            engine,
            ModelRequest(
                descriptor.id,
                (CanonicalMessage("user", "Answer without private reasoning."),),
                max_output_tokens=128,
                reasoning_effort=ReasoningEffort.HIGH,
            ),
        )

    assert captured["url"] == "https://integrate.api.nvidia.com/v1/chat/completions"
    assert captured["body"]["model"] == "nvidia/nemotron-test"
    assert captured["body"]["reasoning_effort"] == "high"
    assert captured["body"]["chat_template_kwargs"] == {"enable_thinking": False}
    assert (
        "".join(event.text or "" for event in events if event.type == StreamEventType.TEXT_DELTA)
        == "safe answer"
    )


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

    async def slow_stream(messages: list[ModelMessage], info: AgentInfo) -> AsyncIterator[str]:
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
    settings = CupcakeAgentEngineProbe.model_settings_for_test(
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

    xai_descriptor = registry.catalog.list(provider="xai")[0]
    xai_settings = CupcakeAgentEngineProbe.model_settings_for_test(
        xai_descriptor,
        ModelRequest(
            xai_descriptor.id,
            (CanonicalMessage("user", "reason"),),
            reasoning_effort=ReasoningEffort.XHIGH,
            temperature=0.2,
        ),
        1_000,
    )
    xai_settings_dict: dict[str, Any] = dict(xai_settings)
    assert xai_settings_dict["openai_reasoning_effort"] == "xhigh"
    assert "temperature" not in xai_settings_dict

    anthropic_descriptor = registry.catalog.list(provider="anthropic")[0]
    anthropic_settings = CupcakeAgentEngineProbe.model_settings_for_test(
        anthropic_descriptor,
        ModelRequest(
            anthropic_descriptor.id,
            (CanonicalMessage("user", "reason"),),
            reasoning_effort=ReasoningEffort.HIGH,
            temperature=0.2,
        ),
        1_000,
    )
    anthropic_settings_dict: dict[str, Any] = dict(anthropic_settings)
    assert anthropic_settings_dict["anthropic_thinking"] == {"type": "adaptive"}
    assert anthropic_settings_dict["anthropic_effort"] == "high"
    assert "temperature" not in anthropic_settings_dict


def test_only_openai_thinking_parts_are_normalized_as_requested_summaries() -> None:
    from pydantic_ai.messages import (
        PartDeltaEvent,
        PartStartEvent,
        ThinkingPart,
        ThinkingPartDelta,
    )

    registry = ProviderRegistry()
    openai_descriptor = registry.catalog.list(provider="openai")[0]
    anthropic_descriptor = registry.catalog.list(provider="anthropic")[0]
    nim_descriptor = ModelDescriptor(
        id="nvidia-nim:nvidia/nemotron-test",
        provider=NVIDIA_NIM_PROVIDER,
        model="nvidia/nemotron-test",
        display_name="Recorded NVIDIA NIM",
        family="nvidia-nim:nemotron-test",
        context_window=8_192,
        max_output_tokens=1_024,
        capabilities=ModelCapabilities(reasoning=True),
        reasoning_efforts=(ReasoningEffort.NONE, ReasoningEffort.HIGH),
    )
    event = PartStartEvent(index=0, part=ThinkingPart("private or summary"))
    openai_events = CupcakeAgentEngineProbe.normalize_event_for_test(
        openai_descriptor, EventBuilder(openai_descriptor), event, set()
    )
    anthropic_events = CupcakeAgentEngineProbe.normalize_event_for_test(
        anthropic_descriptor, EventBuilder(anthropic_descriptor), event, set()
    )
    nim_events = CupcakeAgentEngineProbe.normalize_event_for_test(
        nim_descriptor, EventBuilder(nim_descriptor), event, set()
    )
    nim_delta_events = CupcakeAgentEngineProbe.normalize_event_for_test(
        nim_descriptor,
        EventBuilder(nim_descriptor),
        PartDeltaEvent(index=0, delta=ThinkingPartDelta(content_delta="private delta")),
        set(),
    )
    assert openai_events[0].type == StreamEventType.REASONING_SUMMARY_DELTA
    assert openai_events[0].metadata["summary"] is True
    assert anthropic_events == []
    assert nim_events == []
    assert nim_delta_events == []


def test_continuity_contains_only_scoped_opaque_response_id() -> None:
    registry = ProviderRegistry()
    descriptor = registry.catalog.list(provider="openai")[0]
    response = ModelResponse(
        [TextPart("answer")],
        provider_response_id="resp_123",
        provider_details={"hidden": "must-not-cross"},
    )
    continuity = CupcakeAgentEngineProbe.continuity_for_test(descriptor, response)
    assert continuity is not None
    assert continuity.provider == descriptor.provider
    assert continuity.model_family == descriptor.family
    assert continuity.opaque_state == {"response_id": "resp_123"}


def test_non_openai_response_ids_are_not_persisted_as_unusable_continuity() -> None:
    registry = ProviderRegistry()
    descriptor = registry.catalog.list(provider="xai")[0]
    response = ModelResponse([TextPart("answer")], provider_response_id="xai_opaque")
    assert CupcakeAgentEngineProbe.continuity_for_test(descriptor, response) is None
