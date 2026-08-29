"""OpenAI Responses API adapter."""

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

OPENAI_EFFORT = {
    ReasoningEffort.MINIMAL: "minimal",
    ReasoningEffort.LOW: "low",
    ReasoningEffort.MEDIUM: "medium",
    ReasoningEffort.HIGH: "high",
    ReasoningEffort.XHIGH: "xhigh",
    ReasoningEffort.MAX: "max",
}


class OpenAIResponsesAdapter(ProviderAdapter):
    provider = "openai"

    def _client_or_create(self) -> Any:
        if self._client is not None:
            return self._client
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:
            raise MissingProviderDependency(self.provider, "openai") from exc
        self._client = AsyncOpenAI(
            api_key=self.config.api_key,
            base_url=self.config.base_url,
            organization=self.config.organization,
            timeout=self.config.timeout_seconds,
            default_headers=dict(self.config.headers or {}),
        )
        return self._client

    def build_request(self, request: ModelRequest) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.descriptor.model,
            "input": openai_messages(request.messages),
            "stream": True,
        }
        effort = self.effort(request)
        if effort != ReasoningEffort.NONE:
            payload["reasoning"] = {"effort": OPENAI_EFFORT[effort], "summary": "auto"}
        if request.max_output_tokens:
            payload["max_output_tokens"] = request.max_output_tokens
        if request.tools:
            payload["tools"] = list(request.tools)
        continuity = self.usable_continuity(request)
        if continuity and continuity.opaque_state.get("response_id"):
            payload["previous_response_id"] = continuity.opaque_state["response_id"]
        return payload

    async def stream(self, request: ModelRequest) -> AsyncIterator[NormalizedStreamEvent]:
        self.validate_request(request)
        builder = EventBuilder(self.descriptor, request.metadata.get("run_id"))
        yield builder.make(
            StreamEventType.START,
            metadata={"provider": self.provider, "model": self.descriptor.model},
        )
        try:
            stream = await self._client_or_create().responses.create(**self.build_request(request))
            response_id: str | None = None
            tool_calls: dict[str, str] = {}
            finished = False
            async for event in stream:
                event_type = get_path(event, "type", "")
                response_id = get_path(event, "response.id", response_id)
                if event_type == "response.output_text.delta":
                    yield builder.make(
                        StreamEventType.TEXT_DELTA,
                        text=require_event_field(
                            self.provider, event_type, "delta", get_path(event, "delta")
                        ),
                        item_id=get_path(event, "item_id"),
                    )
                elif event_type == "response.reasoning_summary_text.delta":
                    yield builder.make(
                        StreamEventType.REASONING_SUMMARY_DELTA,
                        text=require_event_field(
                            self.provider, event_type, "delta", get_path(event, "delta")
                        ),
                        item_id=get_path(event, "item_id"),
                    )
                elif (
                    event_type == "response.output_item.added"
                    and get_path(event, "item.type") == "function_call"
                ):
                    item_id = require_event_field(
                        self.provider, event_type, "item.id", get_path(event, "item.id")
                    )
                    name = require_event_field(
                        self.provider, event_type, "item.name", get_path(event, "item.name")
                    )
                    tool_calls[item_id] = name
                    yield builder.make(
                        StreamEventType.TOOL_CALL_START,
                        item_id=item_id,
                        name=name,
                        metadata={"provider_call_id": get_path(event, "item.call_id")},
                    )
                elif event_type == "response.function_call_arguments.delta":
                    item_id = require_event_field(
                        self.provider, event_type, "item_id", get_path(event, "item_id")
                    )
                    yield builder.make(
                        StreamEventType.TOOL_CALL_DELTA,
                        item_id=item_id,
                        name=tool_calls.get(item_id),
                        arguments_delta=require_event_field(
                            self.provider, event_type, "delta", get_path(event, "delta")
                        ),
                    )
                elif event_type == "response.function_call_arguments.done":
                    item_id = require_event_field(
                        self.provider, event_type, "item_id", get_path(event, "item_id")
                    )
                    yield builder.make(
                        StreamEventType.TOOL_CALL_END,
                        item_id=item_id,
                        name=tool_calls.pop(item_id, None),
                        arguments_delta=get_path(event, "arguments"),
                    )
                elif event_type == "response.output_text.annotation.added":
                    annotation = require_event_field(
                        self.provider, event_type, "annotation", get_path(event, "annotation")
                    )
                    yield builder.make(
                        StreamEventType.CITATION,
                        item_id=get_path(event, "item_id"),
                        citation={
                            "url": get_path(annotation, "url"),
                            "title": get_path(annotation, "title"),
                            "start": get_path(annotation, "start_index"),
                            "end": get_path(annotation, "end_index"),
                        },
                    )
                elif event_type == "response.completed":
                    finished = True
                    usage_raw = get_path(event, "response.usage")
                    if usage_raw:
                        usage = TokenUsage(
                            int(get_path(usage_raw, "input_tokens", 0) or 0),
                            int(get_path(usage_raw, "output_tokens", 0) or 0),
                            int(get_path(usage_raw, "input_tokens_details.cached_tokens", 0) or 0),
                            int(
                                get_path(usage_raw, "output_tokens_details.reasoning_tokens", 0)
                                or 0
                            ),
                        )
                        yield builder.make(
                            StreamEventType.USAGE, usage=usage, cost=self.cost(usage)
                        )
                    continuity = (
                        ProviderContinuity(
                            self.provider, self.descriptor.family, {"response_id": response_id}
                        )
                        if response_id
                        else None
                    )
                    yield builder.make(
                        StreamEventType.FINISH, finish_reason="stop", continuity=continuity
                    )
                elif event_type in {"response.failed", "error"}:
                    finished = True
                    error = get_path(event, "response.error") or get_path(event, "error")
                    code = get_path(error, "code", "provider_error")
                    retryable = code in {"rate_limit_exceeded", "server_error"}
                    yield builder.make(
                        StreamEventType.ERROR,
                        text="The provider reported a failed response.",
                        error_code=code,
                        retryable=retryable,
                    )
                    return
            if not finished:
                raise MalformedProviderEvent(self.provider, "stream", "terminal event")
        except Exception as exc:
            yield provider_error_event(builder, exc)


def build_pydantic_model(model_name: str, *, api_key: str | None = None):
    """Build Pydantic AI's native OpenAI Responses model when installed."""
    try:
        from pydantic_ai.models.openai import OpenAIResponsesModel
        from pydantic_ai.providers.openai import OpenAIProvider
    except ImportError as exc:
        raise MissingProviderDependency("openai", "pydantic-ai-slim[openai]") from exc
    return OpenAIResponsesModel(model_name, provider=OpenAIProvider(api_key=api_key))
