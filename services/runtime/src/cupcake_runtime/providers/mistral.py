"""Mistral chat-completions adapter."""

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


class MistralAdapter(ProviderAdapter):
    provider = "mistral"

    def _client_or_create(self) -> Any:
        if self._client is not None:
            return self._client
        try:
            from mistralai import Mistral  # pyright: ignore[reportAttributeAccessIssue]
        except ImportError as exc:
            raise MissingProviderDependency(self.provider, "mistralai") from exc
        self._client = Mistral(api_key=self.config.api_key, server_url=self.config.base_url)
        return self._client

    def build_request(self, request: ModelRequest) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.descriptor.model,
            "messages": openai_messages(request.messages),
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
            stream = await self._client_or_create().chat.stream_async(**self.build_request(request))
            tool_calls: dict[int, tuple[str, str]] = {}
            finished = False
            async for event in stream:
                data = get_path(event, "data", event)
                choice = (get_path(data, "choices", []) or [None])[0]
                delta = get_path(choice, "delta") if choice else None
                if get_path(delta, "content") is not None:
                    yield builder.make(StreamEventType.TEXT_DELTA, text=get_path(delta, "content"))
                for call in get_path(delta, "tool_calls", []) or []:
                    index = int(get_path(call, "index", 0) or 0)
                    item_id = get_path(call, "id")
                    name = get_path(call, "function.name")
                    if index not in tool_calls:
                        item_id = require_event_field(self.provider, "tool_call", "id", item_id)
                        name = require_event_field(
                            self.provider, "tool_call", "function.name", name
                        )
                        tool_calls[index] = (item_id, name)
                        yield builder.make(
                            StreamEventType.TOOL_CALL_START, item_id=item_id, name=name
                        )
                    stable_id, stable_name = tool_calls[index]
                    arguments = get_path(call, "function.arguments")
                    if arguments is not None:
                        yield builder.make(
                            StreamEventType.TOOL_CALL_DELTA,
                            item_id=stable_id,
                            name=stable_name,
                            arguments_delta=arguments,
                        )
                usage_raw = get_path(data, "usage")
                if usage_raw:
                    usage = TokenUsage(
                        int(get_path(usage_raw, "prompt_tokens", 0) or 0),
                        int(get_path(usage_raw, "completion_tokens", 0) or 0),
                    )
                    yield builder.make(StreamEventType.USAGE, usage=usage, cost=self.cost(usage))
                reason = get_path(choice, "finish_reason") if choice else None
                if reason:
                    finished = True
                    for item_id, name in tool_calls.values():
                        yield builder.make(
                            StreamEventType.TOOL_CALL_END, item_id=item_id, name=name
                        )
                    response_id = get_path(data, "id")
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
                        finish_reason=reason,
                        continuity=continuity,
                    )
            if not finished:
                raise MalformedProviderEvent(self.provider, "stream", "finish_reason")
        except Exception as exc:
            yield provider_error_event(builder, exc)


def build_pydantic_model(model_name: str, *, api_key: str | None = None):
    try:
        from pydantic_ai.models.mistral import MistralModel
        from pydantic_ai.providers.mistral import MistralProvider
    except ImportError as exc:
        raise MissingProviderDependency("mistral", "pydantic-ai-slim[mistral]") from exc
    return MistralModel(model_name, provider=MistralProvider(api_key=api_key))
