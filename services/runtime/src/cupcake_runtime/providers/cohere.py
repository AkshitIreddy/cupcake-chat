"""Cohere v2 chat adapter."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from .base import (
    EventBuilder,
    MalformedProviderEvent,
    MissingProviderDependency,
    ProviderAdapter,
    get_path,
    openai_messages,
    provider_error_event,
    require_event_field,
)
from .types import (
    ModelRequest,
    NormalizedStreamEvent,
    ProviderContinuity,
    StreamEventType,
    TokenUsage,
)


class CohereAdapter(ProviderAdapter):
    provider = "cohere"

    def _client_or_create(self) -> Any:
        if self._client is not None:
            return self._client
        try:
            from cohere import AsyncClientV2
        except ImportError as exc:
            raise MissingProviderDependency(self.provider, "cohere") from exc
        self._client = AsyncClientV2(
            api_key=self.config.api_key,
            base_url=self.config.base_url,
            timeout=self.config.timeout_seconds,
        )
        return self._client

    def build_request(self, request: ModelRequest) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.descriptor.model,
            "messages": openai_messages(request.messages),
            # Command A otherwise spends short response budgets on private
            # thinking blocks. CUPCAKEAGI never displays hidden reasoning, and
            # this catalog entry intentionally exposes no reasoning control.
            "thinking": {"type": "disabled"},
        }
        if request.max_output_tokens:
            payload["max_tokens"] = request.max_output_tokens
        if request.temperature is not None:
            payload["temperature"] = request.temperature
        if request.tools:
            payload["tools"] = list(request.tools)
        return payload

    async def stream(self, request: ModelRequest) -> AsyncIterator[NormalizedStreamEvent]:
        self.validate_request(request)
        builder = EventBuilder(self.descriptor, request.metadata.get("run_id"))
        yield builder.make(
            StreamEventType.START,
            metadata={"provider": self.provider, "model": self.descriptor.model},
        )
        try:
            stream = self._client_or_create().v2.chat_stream(**self.build_request(request))
            active_tools: dict[str, str] = {}
            finished = False
            async for event in stream:
                kind = get_path(event, "type", "")
                if kind == "content-delta":
                    yield builder.make(
                        StreamEventType.TEXT_DELTA,
                        text=require_event_field(
                            self.provider,
                            kind,
                            "delta.message.content.text",
                            get_path(event, "delta.message.content.text"),
                        ),
                    )
                elif kind == "tool-call-start":
                    item_id = require_event_field(
                        self.provider,
                        kind,
                        "delta.message.tool_calls.id",
                        get_path(event, "delta.message.tool_calls.id"),
                    )
                    name = require_event_field(
                        self.provider,
                        kind,
                        "delta.message.tool_calls.function.name",
                        get_path(event, "delta.message.tool_calls.function.name"),
                    )
                    active_tools[item_id] = name
                    yield builder.make(StreamEventType.TOOL_CALL_START, item_id=item_id, name=name)
                elif kind == "tool-call-delta":
                    item_id = get_path(event, "delta.message.tool_calls.id")
                    if item_id is None and len(active_tools) == 1:
                        item_id = next(iter(active_tools))
                    item_id = require_event_field(
                        self.provider, kind, "delta.message.tool_calls.id", item_id
                    )
                    yield builder.make(
                        StreamEventType.TOOL_CALL_DELTA,
                        item_id=item_id,
                        name=active_tools.get(item_id),
                        arguments_delta=require_event_field(
                            self.provider,
                            kind,
                            "delta.message.tool_calls.function.arguments",
                            get_path(event, "delta.message.tool_calls.function.arguments"),
                        ),
                    )
                elif kind == "tool-call-end":
                    item_id = get_path(event, "delta.message.tool_calls.id")
                    if item_id is None and len(active_tools) == 1:
                        item_id = next(iter(active_tools))
                    item_id = require_event_field(
                        self.provider, kind, "delta.message.tool_calls.id", item_id
                    )
                    yield builder.make(
                        StreamEventType.TOOL_CALL_END,
                        item_id=item_id,
                        name=active_tools.pop(item_id, None),
                    )
                elif kind == "citation-start":
                    yield builder.make(
                        StreamEventType.CITATION,
                        citation={
                            "start": get_path(event, "delta.message.citations.start"),
                            "end": get_path(event, "delta.message.citations.end"),
                            "sources": get_path(event, "delta.message.citations.sources", []),
                        },
                    )
                elif kind == "message-end":
                    finished = True
                    for item_id, name in tuple(active_tools.items()):
                        yield builder.make(
                            StreamEventType.TOOL_CALL_END, item_id=item_id, name=name
                        )
                    active_tools.clear()
                    usage_raw = get_path(event, "delta.usage")
                    usage = TokenUsage(
                        int(get_path(usage_raw, "tokens.input_tokens", 0) or 0),
                        int(get_path(usage_raw, "tokens.output_tokens", 0) or 0),
                    )
                    yield builder.make(StreamEventType.USAGE, usage=usage, cost=self.cost(usage))
                    response_id = get_path(event, "delta.id")
                    continuity = (
                        ProviderContinuity(
                            self.provider,
                            self.descriptor.family,
                            {"response_id": response_id},
                        )
                        if response_id
                        else None
                    )
                    yield builder.make(
                        StreamEventType.FINISH,
                        finish_reason=get_path(event, "delta.finish_reason", "stop"),
                        continuity=continuity,
                    )
            if not finished:
                raise MalformedProviderEvent(self.provider, "stream", "message-end")
        except Exception as exc:
            yield provider_error_event(builder, exc)


def build_pydantic_model(model_name: str, *, api_key: str | None = None):
    try:
        from pydantic_ai.models.cohere import CohereModel
        from pydantic_ai.providers.cohere import CohereProvider
    except ImportError as exc:
        raise MissingProviderDependency("cohere", "pydantic-ai-slim[cohere]") from exc
    return CohereModel(model_name, provider=CohereProvider(api_key=api_key))
