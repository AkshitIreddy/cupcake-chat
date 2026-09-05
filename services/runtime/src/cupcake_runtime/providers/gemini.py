"""Google Gemini generate-content adapter."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from .base import (
    EventBuilder,
    MalformedProviderEvent,
    MissingProviderDependency,
    ProviderAdapter,
    get_path,
    json_arguments,
    provider_error_event,
    provider_items,
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


class GeminiAdapter(ProviderAdapter):
    provider = "google"

    def _client_or_create(self) -> Any:
        if self._client is not None:
            return self._client
        try:
            from google import genai
        except ImportError as exc:
            raise MissingProviderDependency(self.provider, "google-genai") from exc
        self._client = genai.Client(
            api_key=self.config.api_key,
            http_options={"base_url": self.config.base_url} if self.config.base_url else None,
        )
        return self._client

    def build_request(self, request: ModelRequest) -> dict[str, Any]:
        system = "\n\n".join(
            message.content for message in request.messages if message.role == "system"
        )
        contents = [
            {
                "role": "model" if message.role == "assistant" else "user",
                "parts": [{"text": message.content}],
            }
            for message in request.messages
            if message.role != "system"
        ]
        config: dict[str, Any] = {}
        if system:
            config["system_instruction"] = system
        if request.max_output_tokens:
            config["max_output_tokens"] = request.max_output_tokens
        if request.temperature is not None and not self.descriptor.family.startswith("gemini-3"):
            config["temperature"] = request.temperature
        if request.tools:
            config["tools"] = list(request.tools)
        effort = self.effort(request)
        if self.descriptor.family.startswith("gemini-3"):
            level = (
                "minimal"
                if effort in {ReasoningEffort.NONE, ReasoningEffort.MINIMAL}
                else effort.value
            )
            config["thinking_config"] = {
                "thinking_level": level,
                "include_thoughts": True,
            }
        elif effort != ReasoningEffort.NONE:
            budgets = {
                ReasoningEffort.LOW: 1024,
                ReasoningEffort.MEDIUM: 4096,
                ReasoningEffort.HIGH: 8192,
                ReasoningEffort.XHIGH: 16384,
                ReasoningEffort.MAX: 32768,
            }
            config["thinking_config"] = {
                "thinking_budget": budgets[effort],
                "include_thoughts": True,
            }
        return {"model": self.descriptor.model, "contents": contents, "config": config}

    async def stream(self, request: ModelRequest) -> AsyncIterator[NormalizedStreamEvent]:
        self.validate_request(request)
        builder = EventBuilder(self.descriptor, request.metadata.get("run_id"))
        yield builder.make(
            StreamEventType.START,
            metadata={"provider": self.provider, "model": self.descriptor.model},
        )
        try:
            stream = await self._client_or_create().aio.models.generate_content_stream(
                **self.build_request(request)
            )
            last_usage: TokenUsage | None = None
            response_id: str | None = None
            finish_reason = "stop"
            saw_chunk = False
            async for chunk in stream:
                saw_chunk = True
                response_id = get_path(chunk, "response_id", response_id)
                for candidate in provider_items(get_path(chunk, "candidates", [])):
                    finish_reason = (
                        get_path(candidate, "finish_reason", finish_reason) or finish_reason
                    )
                    for part in provider_items(get_path(candidate, "content.parts", [])):
                        if get_path(part, "thought", False):
                            yield builder.make(
                                StreamEventType.REASONING_SUMMARY_DELTA,
                                text=require_event_field(
                                    self.provider, "thought", "text", get_path(part, "text")
                                ),
                            )
                        elif get_path(part, "text") is not None:
                            yield builder.make(
                                StreamEventType.TEXT_DELTA, text=get_path(part, "text")
                            )
                        elif get_path(part, "function_call"):
                            call = get_path(part, "function_call")
                            name = require_event_field(
                                self.provider, "function_call", "name", get_path(call, "name")
                            )
                            item_id = get_path(call, "id") or f"function:{name}"
                            yield builder.make(
                                StreamEventType.TOOL_CALL_START, item_id=item_id, name=name
                            )
                            yield builder.make(
                                StreamEventType.TOOL_CALL_DELTA,
                                item_id=item_id,
                                name=name,
                                arguments_delta=json_arguments(get_path(call, "args", {})),
                            )
                            yield builder.make(
                                StreamEventType.TOOL_CALL_END, item_id=item_id, name=name
                            )
                    for grounding in provider_items(
                        get_path(candidate, "grounding_metadata.grounding_chunks", [])
                    ):
                        web = get_path(grounding, "web")
                        if web:
                            yield builder.make(
                                StreamEventType.CITATION,
                                citation={
                                    "url": require_event_field(
                                        self.provider,
                                        "grounding_chunk",
                                        "web.uri",
                                        get_path(web, "uri"),
                                    ),
                                    "title": get_path(web, "title"),
                                },
                            )
                usage_raw = get_path(chunk, "usage_metadata")
                if usage_raw:
                    last_usage = TokenUsage(
                        int(get_path(usage_raw, "prompt_token_count", 0) or 0),
                        int(get_path(usage_raw, "candidates_token_count", 0) or 0),
                        int(get_path(usage_raw, "cached_content_token_count", 0) or 0),
                        int(get_path(usage_raw, "thoughts_token_count", 0) or 0),
                    )
            if not saw_chunk:
                raise MalformedProviderEvent(self.provider, "stream", "response chunk")
            if last_usage:
                yield builder.make(
                    StreamEventType.USAGE, usage=last_usage, cost=self.cost(last_usage)
                )
            continuity = (
                ProviderContinuity(
                    self.provider, self.descriptor.family, {"response_id": response_id}
                )
                if response_id
                else None
            )
            yield builder.make(
                StreamEventType.FINISH,
                finish_reason=_finish_reason_value(finish_reason),
                continuity=continuity,
            )
        except Exception as exc:
            yield provider_error_event(builder, exc)


def build_pydantic_model(
    model_name: str,
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    disable_retries: bool = False,
):
    try:
        from google.genai.types import HttpRetryOptions
        from pydantic_ai.models.google import GoogleModel
        from pydantic_ai.providers.google import GoogleProvider
    except ImportError as exc:
        raise MissingProviderDependency("google", "pydantic-ai-slim[google]") from exc
    if not api_key:
        raise ValueError("Google provider requires an API key")
    return GoogleModel(
        model_name,
        provider=GoogleProvider(
            api_key=api_key,
            base_url=base_url,
            retry_options=HttpRetryOptions(attempts=1) if disable_retries else None,
        ),
    )


def _finish_reason_value(value: Any) -> str:
    raw = getattr(value, "value", value)
    return str(raw).rsplit(".", 1)[-1].lower()
