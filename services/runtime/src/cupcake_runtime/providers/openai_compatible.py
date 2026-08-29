"""OpenAI-compatible Chat Completions adapter used by xAI and self-hosted APIs."""

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
    ReasoningEffort,
    StreamEventType,
    TokenUsage,
)


class OpenAICompatibleAdapter(ProviderAdapter):
    provider = "openai-compatible"

    def _client_or_create(self) -> Any:
        if self._client is not None:
            return self._client
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:
            raise MissingProviderDependency(self.provider, "openai") from exc
        self._client = AsyncOpenAI(
            api_key=self.config.api_key or "not-required",
            base_url=self.config.base_url,
            timeout=self.config.timeout_seconds,
            default_headers=dict(self.config.headers or {}),
        )
        return self._client

    def build_request(self, request: ModelRequest) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.descriptor.model,
            "messages": openai_messages(request.messages),
            "stream": True,
            "stream_options": {"include_usage": True},
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
            client = self._client_or_create()
            stream = await client.chat.completions.create(**self.build_request(request))
            tool_calls: dict[int, tuple[str, str]] = {}
            finished = False
            async for chunk in stream:
                choice = (get_path(chunk, "choices", []) or [None])[0]
                delta = get_path(choice, "delta") if choice else None
                text = get_path(delta, "content")
                if text is not None:
                    yield builder.make(StreamEventType.TEXT_DELTA, text=text)
                reasoning = get_path(delta, "reasoning_content")
                if reasoning is None:
                    reasoning = get_path(delta, "reasoning")
                if reasoning is not None:
                    yield builder.make(StreamEventType.REASONING_SUMMARY_DELTA, text=reasoning)
                for call in get_path(delta, "tool_calls", []) or []:
                    index = int(get_path(call, "index", 0) or 0)
                    name = get_path(call, "function.name")
                    if index not in tool_calls:
                        item_id = require_event_field(
                            self.provider, "tool_call", "id", get_path(call, "id")
                        )
                        name = require_event_field(
                            self.provider, "tool_call", "function.name", name
                        )
                        tool_calls[index] = (item_id, name)
                        yield builder.make(
                            StreamEventType.TOOL_CALL_START, item_id=item_id, name=name
                        )
                    item_id, stable_name = tool_calls[index]
                    arguments = get_path(call, "function.arguments")
                    if arguments is not None:
                        yield builder.make(
                            StreamEventType.TOOL_CALL_DELTA,
                            item_id=item_id,
                            name=stable_name,
                            arguments_delta=arguments,
                        )
                for citation in (
                    get_path(delta, "citations", []) or get_path(chunk, "citations", []) or []
                ):
                    yield builder.make(
                        StreamEventType.CITATION,
                        citation={
                            "url": get_path(citation, "url"),
                            "title": get_path(citation, "title"),
                            "start": get_path(citation, "start_index"),
                            "end": get_path(citation, "end_index"),
                        },
                    )
                usage_raw = get_path(chunk, "usage")
                if usage_raw:
                    usage = TokenUsage(
                        int(get_path(usage_raw, "prompt_tokens", 0) or 0),
                        int(get_path(usage_raw, "completion_tokens", 0) or 0),
                        int(get_path(usage_raw, "prompt_tokens_details.cached_tokens", 0) or 0),
                        int(
                            get_path(usage_raw, "completion_tokens_details.reasoning_tokens", 0)
                            or 0
                        ),
                    )
                    yield builder.make(StreamEventType.USAGE, usage=usage, cost=self.cost(usage))
                finish = get_path(choice, "finish_reason") if choice else None
                if finish:
                    finished = True
                    for item_id, name in tool_calls.values():
                        yield builder.make(
                            StreamEventType.TOOL_CALL_END, item_id=item_id, name=name
                        )
                    response_id = get_path(chunk, "id")
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
                        finish_reason=finish,
                        continuity=continuity,
                    )
            if not finished:
                raise MalformedProviderEvent(self.provider, "stream", "finish_reason")
        except Exception as exc:
            yield provider_error_event(builder, exc)


class GenericOpenAICompatibleAdapter(OpenAICompatibleAdapter):
    provider = "openai-compatible"

    def build_request(self, request: ModelRequest) -> dict[str, Any]:
        payload = super().build_request(request)
        effort = self.effort(request)
        if effort != ReasoningEffort.NONE:
            payload["reasoning_effort"] = effort.value
        return payload
