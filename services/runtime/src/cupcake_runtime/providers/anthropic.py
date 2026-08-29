"""Anthropic Messages API adapter."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from .base import (
    EventBuilder,
    MalformedProviderEvent,
    MissingProviderDependency,
    ProviderAdapter,
    anthropic_messages,
    get_path,
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


class AnthropicAdapter(ProviderAdapter):
    provider = "anthropic"

    def _client_or_create(self) -> Any:
        if self._client is not None:
            return self._client
        try:
            from anthropic import AsyncAnthropic
        except ImportError as exc:
            raise MissingProviderDependency(self.provider, "anthropic") from exc
        self._client = AsyncAnthropic(
            api_key=self.config.api_key,
            base_url=self.config.base_url,
            timeout=self.config.timeout_seconds,
        )
        return self._client

    def build_request(self, request: ModelRequest) -> dict[str, Any]:
        system, messages = anthropic_messages(request.messages)
        payload: dict[str, Any] = {
            "model": self.descriptor.model,
            "messages": messages,
            "max_tokens": request.max_output_tokens or self.descriptor.max_output_tokens or 4096,
        }
        if system:
            payload["system"] = system
        if request.temperature is not None and self.descriptor.family != "claude-5":
            payload["temperature"] = request.temperature
        if request.tools:
            payload["tools"] = list(request.tools)
        effort = self.effort(request)
        if self.descriptor.family == "claude-5":
            if effort == ReasoningEffort.NONE:
                payload["thinking"] = {"type": "disabled"}
            else:
                payload["thinking"] = {"type": "adaptive", "display": "summarized"}
                payload["output_config"] = {"effort": effort.value}
        elif effort != ReasoningEffort.NONE:
            # Anthropic exposes thinking via a token budget rather than CUPCAKE's
            # portable effort vocabulary.
            budgets = {
                ReasoningEffort.LOW: 1024,
                ReasoningEffort.MEDIUM: 4096,
                ReasoningEffort.HIGH: 8192,
                ReasoningEffort.XHIGH: 16384,
                ReasoningEffort.MAX: 32768,
            }
            payload["thinking"] = {"type": "enabled", "budget_tokens": budgets[effort]}
        return payload

    async def stream(self, request: ModelRequest) -> AsyncIterator[NormalizedStreamEvent]:
        self.validate_request(request)
        builder = EventBuilder(self.descriptor, request.metadata.get("run_id"))
        yield builder.make(
            StreamEventType.START,
            metadata={"provider": self.provider, "model": self.descriptor.model},
        )
        input_tokens = 0
        output_tokens = 0
        message_id: str | None = None
        tool_blocks: dict[int, tuple[str, str]] = {}
        finished = False
        try:
            async with self._client_or_create().messages.stream(
                **self.build_request(request)
            ) as stream:
                async for event in stream:
                    kind = get_path(event, "type", "")
                    message_id = get_path(event, "message.id", message_id)
                    index = int(get_path(event, "index", 0) or 0)
                    if (
                        kind == "content_block_start"
                        and get_path(event, "content_block.type") == "tool_use"
                    ):
                        item_id = require_event_field(
                            self.provider,
                            kind,
                            "content_block.id",
                            get_path(event, "content_block.id"),
                        )
                        name = require_event_field(
                            self.provider,
                            kind,
                            "content_block.name",
                            get_path(event, "content_block.name"),
                        )
                        tool_blocks[index] = (item_id, name)
                        yield builder.make(
                            StreamEventType.TOOL_CALL_START, item_id=item_id, name=name
                        )
                    elif kind == "content_block_delta":
                        delta_type = require_event_field(
                            self.provider, kind, "delta.type", get_path(event, "delta.type")
                        )
                        if delta_type == "text_delta":
                            yield builder.make(
                                StreamEventType.TEXT_DELTA,
                                text=require_event_field(
                                    self.provider,
                                    kind,
                                    "delta.text",
                                    get_path(event, "delta.text"),
                                ),
                            )
                        elif delta_type in {"thinking_delta", "signature_delta"}:
                            # Signatures are provider-private and intentionally omitted.
                            if delta_type == "thinking_delta":
                                yield builder.make(
                                    StreamEventType.REASONING_SUMMARY_DELTA,
                                    text=require_event_field(
                                        self.provider,
                                        kind,
                                        "delta.thinking",
                                        get_path(event, "delta.thinking"),
                                    ),
                                )
                        elif delta_type == "input_json_delta":
                            item_id, name = tool_blocks.get(index, (str(index), ""))
                            yield builder.make(
                                StreamEventType.TOOL_CALL_DELTA,
                                item_id=item_id,
                                name=name or None,
                                arguments_delta=require_event_field(
                                    self.provider,
                                    kind,
                                    "delta.partial_json",
                                    get_path(event, "delta.partial_json"),
                                ),
                            )
                    elif kind == "content_block_stop" and index in tool_blocks:
                        item_id, name = tool_blocks.pop(index)
                        yield builder.make(
                            StreamEventType.TOOL_CALL_END, item_id=item_id, name=name
                        )
                    elif kind == "message_start":
                        input_tokens = int(get_path(event, "message.usage.input_tokens", 0) or 0)
                    elif kind == "message_delta":
                        output_tokens = int(get_path(event, "usage.output_tokens", 0) or 0)
                        reason = get_path(event, "delta.stop_reason")
                        if reason:
                            finished = True
                            usage = TokenUsage(input_tokens, output_tokens)
                            yield builder.make(
                                StreamEventType.USAGE, usage=usage, cost=self.cost(usage)
                            )
                            continuity = (
                                ProviderContinuity(
                                    self.provider,
                                    self.descriptor.family,
                                    {"message_id": message_id},
                                )
                                if message_id
                                else None
                            )
                            yield builder.make(
                                StreamEventType.FINISH,
                                finish_reason=reason,
                                continuity=continuity,
                            )
            if not finished:
                raise MalformedProviderEvent(self.provider, "stream", "terminal message_delta")
        except Exception as exc:
            yield provider_error_event(builder, exc)


def build_pydantic_model(model_name: str, *, api_key: str | None = None):
    try:
        from pydantic_ai.models.anthropic import AnthropicModel
        from pydantic_ai.providers.anthropic import AnthropicProvider
    except ImportError as exc:
        raise MissingProviderDependency("anthropic", "pydantic-ai-slim[anthropic]") from exc
    return AnthropicModel(model_name, provider=AnthropicProvider(api_key=api_key))
