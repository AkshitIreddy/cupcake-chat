from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest

from cupcake_runtime.providers.anthropic import AnthropicAdapter
from cupcake_runtime.providers.base import ProviderAdapter, ProviderConfig
from cupcake_runtime.providers.catalog import ModelCatalog
from cupcake_runtime.providers.cohere import CohereAdapter
from cupcake_runtime.providers.gemini import GeminiAdapter
from cupcake_runtime.providers.mistral import MistralAdapter
from cupcake_runtime.providers.nvidia_nim import NvidiaNimAdapter
from cupcake_runtime.providers.openai import OpenAIResponsesAdapter
from cupcake_runtime.providers.openai_compatible import GenericOpenAICompatibleAdapter
from cupcake_runtime.providers.registry import ProviderRegistry
from cupcake_runtime.providers.types import (
    CanonicalMessage,
    ModelCapabilities,
    ModelDescriptor,
    ModelRequest,
    NormalizedStreamEvent,
    ProviderContinuity,
    ReasoningEffort,
    StreamEventType,
)
from cupcake_runtime.providers.xai import XAIAdapter

FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "recorded_streams.json").read_text(encoding="utf-8")
)
TOOL = {
    "type": "function",
    "function": {
        "name": "get_recipe",
        "description": "Fetch a recipe",
        "parameters": {"type": "object", "properties": {"flavor": {"type": "string"}}},
    },
}


class RecordedAsyncStream:
    def __init__(self, events: list[dict[str, Any]]):
        self.events = events

    def __aiter__(self) -> AsyncIterator[dict[str, Any]]:
        async def iterate() -> AsyncIterator[dict[str, Any]]:
            for event in self.events:
                await asyncio.sleep(0)
                yield event

        return iterate()


class BlockingAsyncStream:
    def __init__(self):
        self.waiting = asyncio.Event()

    def __aiter__(self) -> AsyncIterator[dict[str, Any]]:
        async def iterate() -> AsyncIterator[dict[str, Any]]:
            self.waiting.set()
            await asyncio.Event().wait()
            yield {}

        return iterate()


class AsyncContextStream:
    def __init__(self, stream: Any):
        self.stream = stream

    async def __aenter__(self) -> Any:
        return self.stream

    async def __aexit__(self, *_args: object) -> None:
        return None


class RaisingCall:
    def __init__(self, error: Exception):
        self.error = error

    async def __call__(self, **_kwargs: Any) -> Any:
        raise self.error


class StatusError(RuntimeError):
    def __init__(self, status_code: int):
        super().__init__(f"recorded HTTP {status_code}; secret=must-not-leak")
        self.status_code = status_code


def _generic_descriptor(registry: ProviderRegistry, endpoint: str = "lab"):
    return registry.register_openai_compatible_endpoint(
        endpoint,
        model="cupcake-chat",
        display_name=f"Cupcake Chat ({endpoint})",
        base_url=f"https://{endpoint}.example.test/v1",
        context_window=16_384,
        max_output_tokens=2_048,
        reasoning_efforts=(ReasoningEffort.NONE, ReasoningEffort.MEDIUM),
    )


def _client(provider: str, stream: Any) -> Any:
    if provider == "openai":

        async def create(**_kwargs: Any) -> Any:
            return stream

        return SimpleNamespace(responses=SimpleNamespace(create=create))
    if provider in {"xai", "nvidia-nim", "openai-compatible"}:

        async def create(**_kwargs: Any) -> Any:
            return stream

        return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    if provider == "anthropic":

        def anthropic_stream(**_kwargs: Any) -> AsyncContextStream:
            return AsyncContextStream(stream)

        return SimpleNamespace(messages=SimpleNamespace(stream=anthropic_stream))
    if provider == "google":

        async def generate_content_stream(**_kwargs: Any) -> Any:
            return stream

        return SimpleNamespace(
            aio=SimpleNamespace(
                models=SimpleNamespace(generate_content_stream=generate_content_stream)
            )
        )
    if provider == "mistral":

        async def stream_async(**_kwargs: Any) -> Any:
            return stream

        return SimpleNamespace(chat=SimpleNamespace(stream_async=stream_async))
    if provider == "cohere":

        def cohere_stream(**_kwargs: Any) -> Any:
            return stream

        return SimpleNamespace(v2=SimpleNamespace(chat_stream=cohere_stream))
    raise AssertionError(provider)


def _raising_client(provider: str, error: Exception) -> Any:
    call = RaisingCall(error)
    if provider == "anthropic":

        class RaisingContext:
            async def __aenter__(self) -> Any:
                raise error

            async def __aexit__(self, *_args: object) -> None:
                return None

        def raising_stream(**_kwargs: Any) -> RaisingContext:
            return RaisingContext()

        return SimpleNamespace(messages=SimpleNamespace(stream=raising_stream))
    if provider == "cohere":

        def raise_sync(**_kwargs: Any) -> Any:
            raise error

        return SimpleNamespace(v2=SimpleNamespace(chat_stream=raise_sync))
    if provider == "openai":
        return SimpleNamespace(responses=SimpleNamespace(create=call))
    if provider in {"xai", "nvidia-nim", "openai-compatible"}:
        return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=call)))
    if provider == "google":
        return SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content_stream=call))
        )
    if provider == "mistral":
        return SimpleNamespace(chat=SimpleNamespace(stream_async=call))
    raise AssertionError(provider)


def _adapter(provider: str, stream: Any | None = None, *, client: Any | None = None):
    catalog = ModelCatalog.builtins()
    config = ProviderConfig(api_key="recorded-test")
    if provider == "openai":
        descriptor = catalog.get("openai:gpt-5.6-sol")
        cls: type[ProviderAdapter] = OpenAIResponsesAdapter
    elif provider == "anthropic":
        descriptor = catalog.get("anthropic:claude-sonnet-5")
        cls = AnthropicAdapter
    elif provider == "google":
        descriptor = catalog.get("google:gemini-3.5-flash")
        cls = GeminiAdapter
    elif provider == "xai":
        descriptor = catalog.get("xai:grok-4.3")
        cls = XAIAdapter
    elif provider == "mistral":
        descriptor = catalog.get("mistral:mistral-medium-3-5")
        cls = MistralAdapter
    elif provider == "cohere":
        descriptor = catalog.get("cohere:command-a-03-2025")
        cls = CohereAdapter
    elif provider == "nvidia-nim":
        descriptor = ModelDescriptor(
            id="nvidia-nim:meta/recorded-chat",
            provider="nvidia-nim",
            model="meta/recorded-chat",
            display_name="Recorded NVIDIA NIM",
            family="nvidia-nim:meta/recorded-chat",
            context_window=32_768,
            max_output_tokens=4_096,
            capabilities=ModelCapabilities(citations=True, reasoning=True),
            reasoning_efforts=(ReasoningEffort.NONE, ReasoningEffort.MEDIUM),
        )
        cls = NvidiaNimAdapter
    elif provider == "openai-compatible":
        registry = ProviderRegistry(catalog)
        descriptor = _generic_descriptor(registry)
        config = ProviderConfig(api_key="recorded-test", base_url="https://lab.example.test/v1")
        cls = GenericOpenAICompatibleAdapter
    else:
        raise AssertionError(provider)
    resolved_client = client if client is not None else _client(provider, stream)
    return cls(descriptor, config, client=resolved_client), descriptor


PROVIDERS = tuple(FIXTURES)


async def _collect(adapter: ProviderAdapter, request: ModelRequest) -> list[NormalizedStreamEvent]:
    return [event async for event in adapter.stream(request)]


@pytest.mark.parametrize("provider", PROVIDERS)
def test_recorded_streams_normalize_full_provider_matrix(provider: str) -> None:
    adapter, descriptor = _adapter(provider, RecordedAsyncStream(FIXTURES[provider]))
    effort = (
        ReasoningEffort.MEDIUM if ReasoningEffort.MEDIUM in descriptor.reasoning_efforts else None
    )
    request = ModelRequest(
        descriptor.id,
        (
            CanonicalMessage("system", "Use cited project facts."),
            CanonicalMessage("user", "Prepare the berry recipe."),
        ),
        reasoning_effort=effort,
        tools=(TOOL,),
        metadata={"run_id": f"recorded-{provider}"},
    )
    events = asyncio.run(_collect(adapter, request))

    assert [event.sequence for event in events] == list(range(len(events)))
    assert events[0].type == StreamEventType.START
    assert events[-1].type == StreamEventType.FINISH
    assert (
        "".join(event.text or "" for event in events if event.type == StreamEventType.TEXT_DELTA)
        == "Cupcakes are ready."
    )
    starts = [event for event in events if event.type == StreamEventType.TOOL_CALL_START]
    deltas = [event for event in events if event.type == StreamEventType.TOOL_CALL_DELTA]
    ends = [event for event in events if event.type == StreamEventType.TOOL_CALL_END]
    assert len(starts) == len(ends) == 1
    assert starts[0].item_id == deltas[0].item_id == ends[0].item_id
    assert starts[0].name == deltas[0].name == ends[0].name == "get_recipe"
    usage = next(event for event in events if event.type == StreamEventType.USAGE)
    assert usage.usage is not None and usage.usage.total_tokens > 0
    assert usage.cost is not None and usage.cost.currency == "USD"
    if events[-1].continuity is not None:
        assert events[-1].continuity.applies_to(descriptor)


MALFORMED_EVENTS: tuple[tuple[str, dict[str, Any]], ...] = (
    ("openai", {"type": "response.output_text.delta"}),
    ("anthropic", {"type": "content_block_delta", "index": 0, "delta": {}}),
    (
        "google",
        {"candidates": [{"content": {"parts": [{"thought": True}]}}]},
    ),
    (
        "xai",
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {}}]}}]},
    ),
    (
        "mistral",
        {"data": {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {}}]}}]}},
    ),
    ("cohere", {"type": "content-delta", "delta": {"message": {"content": {}}}}),
    (
        "openai-compatible",
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {}}]}}]},
    ),
    (
        "nvidia-nim",
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {}}]}}]},
    ),
)


@pytest.mark.parametrize(
    ("provider", "event"),
    MALFORMED_EVENTS,
)
def test_malformed_known_events_fail_closed(provider: str, event: dict[str, Any]) -> None:
    adapter, descriptor = _adapter(provider, RecordedAsyncStream([event]))
    events = asyncio.run(
        _collect(adapter, ModelRequest(descriptor.id, (CanonicalMessage("user", "hello"),)))
    )
    assert [event.type for event in events] == [StreamEventType.START, StreamEventType.ERROR]
    assert events[-1].error_code == "malformed_provider_event"
    assert events[-1].retryable is False


@pytest.mark.parametrize("provider", PROVIDERS)
def test_truncated_or_empty_streams_never_report_success(provider: str) -> None:
    adapter, descriptor = _adapter(provider, RecordedAsyncStream([]))
    events = asyncio.run(
        _collect(adapter, ModelRequest(descriptor.id, (CanonicalMessage("user", "hello"),)))
    )
    assert [event.type for event in events] == [StreamEventType.START, StreamEventType.ERROR]
    assert events[-1].error_code == "malformed_provider_event"


@pytest.mark.parametrize("provider", PROVIDERS)
@pytest.mark.parametrize(
    ("status", "code", "retryable"),
    (
        (401, "authentication_failed", False),
        (429, "rate_limit", True),
        (503, "provider_unavailable", True),
    ),
)
def test_sdk_failures_have_stable_redacted_retry_semantics(
    provider: str, status: int, code: str, retryable: bool
) -> None:
    client = _raising_client(provider, StatusError(status))
    adapter, descriptor = _adapter(provider, client=client)
    events = asyncio.run(
        _collect(adapter, ModelRequest(descriptor.id, (CanonicalMessage("user", "hello"),)))
    )
    assert [event.type for event in events] == [StreamEventType.START, StreamEventType.ERROR]
    assert events[-1].error_code == code
    assert events[-1].retryable is retryable
    assert "must-not-leak" not in (events[-1].text or "")


@pytest.mark.parametrize("provider", PROVIDERS)
def test_consumer_cancellation_is_never_converted_to_provider_error(provider: str) -> None:
    async def scenario() -> None:
        stream = BlockingAsyncStream()
        adapter, descriptor = _adapter(provider, stream)

        async def consume() -> None:
            async for _event in adapter.stream(
                ModelRequest(descriptor.id, (CanonicalMessage("user", "hello"),))
            ):
                pass

        task = asyncio.create_task(consume())
        await asyncio.wait_for(stream.waiting.wait(), timeout=1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())


def test_reasoning_summaries_are_emitted_only_for_recorded_supported_adapters() -> None:
    for provider in (
        "openai",
        "anthropic",
        "google",
        "xai",
        "nvidia-nim",
        "openai-compatible",
    ):
        adapter, descriptor = _adapter(provider, RecordedAsyncStream(FIXTURES[provider]))
        events = asyncio.run(
            _collect(
                adapter,
                ModelRequest(
                    descriptor.id,
                    (CanonicalMessage("user", "hello"),),
                    reasoning_effort=ReasoningEffort.MEDIUM,
                ),
            )
        )
        summaries = [
            event.text for event in events if event.type == StreamEventType.REASONING_SUMMARY_DELTA
        ]
        assert summaries and all(summaries)


def test_citations_are_normalized_where_recorded() -> None:
    for provider in (
        "openai",
        "google",
        "xai",
        "cohere",
        "nvidia-nim",
        "openai-compatible",
    ):
        adapter, descriptor = _adapter(provider, RecordedAsyncStream(FIXTURES[provider]))
        events = asyncio.run(
            _collect(adapter, ModelRequest(descriptor.id, (CanonicalMessage("user", "hello"),)))
        )
        citations = [event.citation for event in events if event.type == StreamEventType.CITATION]
        assert citations and all(citation is not None for citation in citations)


def test_generic_endpoints_are_selectable_isolated_and_retain_canonical_history() -> None:
    registry = ProviderRegistry()
    lab = _generic_descriptor(registry, "lab")
    private = _generic_descriptor(registry, "private")
    assert registry.catalog.get(lab.id) is lab
    assert registry.adapter(lab.id).config.base_url == "https://lab.example.test/v1"
    assert registry.adapter(private.id).config.base_url == "https://private.example.test/v1"

    state = ProviderContinuity("openai-compatible", lab.family, {"response_id": "opaque"})
    assert state.applies_to(lab)
    assert not state.applies_to(private)

    visible_history = (
        CanonicalMessage("user", "first turn"),
        CanonicalMessage("assistant", "first answer"),
        CanonicalMessage("user", "second turn"),
    )
    adapter = registry.adapter(private.id, client=object())
    request = ModelRequest(private.id, visible_history, continuity=state)
    adapter.validate_request(request)
    payload = cast(dict[str, Any], cast(Any, adapter).build_request(request))
    assert [message["content"] for message in payload["messages"]] == [
        "first turn",
        "first answer",
        "second turn",
    ]
    assert "previous_response_id" not in payload


def test_openai_continuity_is_used_only_within_the_exact_model_family() -> None:
    catalog = ModelCatalog.builtins()
    descriptor = catalog.get("openai:gpt-5.6-sol")
    adapter = OpenAIResponsesAdapter(
        descriptor, ProviderConfig(api_key="recorded-test"), client=object()
    )
    history = (
        CanonicalMessage("user", "first turn"),
        CanonicalMessage("assistant", "first answer"),
        CanonicalMessage("user", "second turn"),
    )
    same = ModelRequest(
        descriptor.id,
        history,
        continuity=ProviderContinuity("openai", descriptor.family, {"response_id": "resp_1"}),
    )
    switched = ModelRequest(
        descriptor.id,
        history,
        continuity=ProviderContinuity("anthropic", "claude-5", {"message_id": "msg_1"}),
    )
    assert adapter.build_request(same)["previous_response_id"] == "resp_1"
    switched_payload = adapter.build_request(switched)
    assert "previous_response_id" not in switched_payload
    assert [message["content"] for message in switched_payload["input"]] == [
        "first turn",
        "first answer",
        "second turn",
    ]


def test_registry_scrubs_incompatible_opaque_state_before_runtime_use() -> None:
    registry = ProviderRegistry()
    request = ModelRequest(
        "anthropic:claude-sonnet-5",
        (CanonicalMessage("user", "continue visibly"),),
        continuity=ProviderContinuity("openai", "gpt-5.6", {"response_id": "resp_1"}),
    )
    _adapter_instance, sanitized = registry.prepare_request(request)
    assert sanitized.messages == request.messages
    assert sanitized.continuity is None
