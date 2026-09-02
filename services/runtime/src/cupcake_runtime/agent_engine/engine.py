"""Provider-neutral Pydantic AI Core execution engine."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterable, AsyncIterator, Mapping, Sequence
from contextlib import suppress
from typing import Any, cast

from pydantic_ai import Agent, DeferredToolRequests
from pydantic_ai.exceptions import RunCancelled
from pydantic_ai.messages import (
    AgentStreamEvent,
    DeferredToolRequestsEvent,
    FunctionToolCallEvent,
    ModelResponse,
    PartDeltaEvent,
    PartStartEvent,
    TextPart,
    TextPartDelta,
    ThinkingPart,
    ThinkingPartDelta,
    ToolCallPart,
    ToolCallPartDelta,
)
from pydantic_ai.models import Model
from pydantic_ai.settings import ModelSettings
from pydantic_ai.tools import RunContext
from pydantic_ai.usage import UsageLimits

from cupcake_runtime.personality import BASE_SYSTEM_INSTRUCTION
from cupcake_runtime.providers.base import EventBuilder
from cupcake_runtime.providers.nvidia_nim import NVIDIA_NIM_PROVIDER
from cupcake_runtime.providers.registry import ProviderRegistry
from cupcake_runtime.providers.types import (
    ModelDescriptor,
    ModelRequest,
    NormalizedStreamEvent,
    ProviderContinuity,
    ReasoningEffort,
    StreamEventType,
    TokenUsage,
)

from .cancellation import AgentCancellation
from .factory import AgentModelFactory, PydanticModelFactory
from .history import prepare_visible_history
from .models import AgentLimits, OutputLimitExceeded, PreparedAgentRequest
from .toolset import BrokerDeferredToolset

_DONE = object()


class CupcakeAgentEngine:
    """Run one explicitly selected model through Pydantic AI Core.

    The public stream contains only product-owned canonical events. Pydantic
    messages remain ephemeral and no Python function receives authority to run a
    privileged tool.
    """

    def __init__(
        self,
        registry: ProviderRegistry,
        *,
        model_factory: AgentModelFactory | None = None,
        limits: AgentLimits | None = None,
    ) -> None:
        self._registry = registry
        self._model_factory = model_factory or PydanticModelFactory()
        self._limits = limits or AgentLimits()

    def prepare(
        self,
        request: ModelRequest,
        *,
        personality_instructions: Sequence[str] = (),
    ) -> PreparedAgentRequest:
        """Validate selection and return the bounded, observable request plan."""

        descriptor = self._registry.catalog.select(request.model_id)
        adapter = self._registry.adapter(request.model_id)
        adapter.validate_request(request)
        output_tokens = self._output_tokens(descriptor, request)
        context_budget = self._input_budget(descriptor, output_tokens)
        plan, _ = prepare_visible_history(
            request.messages,
            context_token_budget=context_budget,
            max_output_tokens=output_tokens,
            additional_instructions=(*personality_instructions, BASE_SYSTEM_INSTRUCTION),
        )
        return plan

    async def stream(
        self,
        request: ModelRequest,
        *,
        cancellation: AgentCancellation | None = None,
        personality_instructions: Sequence[str] = (),
    ) -> AsyncIterator[NormalizedStreamEvent]:
        """Stream a Pydantic agent run as canonical CUPCAKEAGI events."""

        descriptor = self._registry.catalog.select(request.model_id)
        adapter = self._registry.adapter(request.model_id)
        adapter.validate_request(request)
        output_tokens = self._output_tokens(descriptor, request)
        context_budget = self._input_budget(descriptor, output_tokens)
        plan, history = prepare_visible_history(
            request.messages,
            context_token_budget=context_budget,
            max_output_tokens=output_tokens,
            additional_instructions=(*personality_instructions, BASE_SYSTEM_INSTRUCTION),
        )
        run_id = str(request.metadata.get("run_id") or "") or None
        events = EventBuilder(descriptor, run_id)
        yield events.make(
            StreamEventType.START,
            metadata={
                "provider": descriptor.provider,
                "model": descriptor.model,
                "agent_engine": "pydantic-ai-core",
                "history_messages": plan.history_message_count,
                "dropped_history_messages": plan.dropped_history_messages,
                "estimated_context_tokens": plan.estimated_context_tokens,
                "max_output_tokens": plan.max_output_tokens,
                "personality_instructions": len(personality_instructions),
            },
        )

        cancellation = cancellation or AgentCancellation()
        if cancellation.cancelled:
            yield events.make(
                StreamEventType.ERROR,
                text="The run was cancelled before it started.",
                error_code="cancelled",
                retryable=False,
            )
            return

        model = self._model_factory.build(descriptor, adapter.config, request)
        # Third-party model subclasses are not fully typed at this reflection
        # boundary. Keep the dynamic comparison local instead of letting an
        # unknown member type contaminate the product-owned result path.
        supports_streaming = (
            cast(Any, type(model)).request_stream is not cast(Any, Model).request_stream
        )
        toolsets = [BrokerDeferredToolset(request.tools)] if request.tools else []
        agent: Agent[object, Any] = Agent(
            model,
            output_type=[str, DeferredToolRequests],
            name="cupcake_agent",
            description="CupcakeAI provider-neutral text agent",
            toolsets=toolsets,
            retries={"tools": 0, "output": 1},
        )
        queue: asyncio.Queue[NormalizedStreamEvent | object] = asyncio.Queue()
        open_calls: set[str] = set()

        async def handle_stream(
            _context: RunContext[object], source: AsyncIterable[AgentStreamEvent]
        ) -> None:
            async for event in source:
                for normalized in self._normalize_pydantic_event(
                    descriptor, events, event, open_calls
                ):
                    await queue.put(normalized)

        async def produce() -> None:
            try:
                run_kwargs: dict[str, Any] = {}
                if supports_streaming:
                    run_kwargs["event_stream_handler"] = handle_stream
                result = await agent.run(
                    plan.prompt,
                    message_history=history,
                    instructions=list(plan.system_instructions),
                    model_settings=self._model_settings(descriptor, request, output_tokens),
                    usage_limits=UsageLimits(
                        request_limit=self._limits.max_model_requests,
                        tool_calls_limit=self._limits.max_tool_calls,
                        output_tokens_limit=output_tokens,
                        per_request_input_tokens_limit=context_budget,
                    ),
                    cancellation_token=cancellation.pydantic_token,
                    run_id=events.run_id,
                    **run_kwargs,
                )
                deferred = (
                    result.output if isinstance(result.output, DeferredToolRequests) else None
                )
                pending = deferred is not None
                if not supports_streaming and isinstance(result.output, str):
                    await queue.put(events.make(StreamEventType.TEXT_DELTA, text=result.output))
                if deferred is not None:
                    for call in (*deferred.calls, *deferred.approvals):
                        if not supports_streaming and call.tool_call_id not in open_calls:
                            await queue.put(
                                events.make(
                                    StreamEventType.TOOL_CALL_START,
                                    item_id=call.tool_call_id,
                                    name=call.tool_name,
                                )
                            )
                            open_calls.add(call.tool_call_id)
                        if call.tool_call_id in open_calls:
                            open_calls.remove(call.tool_call_id)
                            await queue.put(
                                events.make(
                                    StreamEventType.TOOL_CALL_END,
                                    item_id=call.tool_call_id,
                                    name=call.tool_name,
                                    arguments_delta=call.args_as_json_str(),
                                    metadata={"awaiting_broker": True},
                                )
                            )
                usage = self._token_usage(result.usage)
                await queue.put(
                    events.make(StreamEventType.USAGE, usage=usage, cost=adapter.cost(usage))
                )
                last_response = next(
                    (
                        message
                        for message in reversed(result.all_messages())
                        if isinstance(message, ModelResponse)
                    ),
                    None,
                )
                continuity = self._continuity(descriptor, last_response)
                await queue.put(
                    events.make(
                        StreamEventType.FINISH,
                        finish_reason=(
                            "tool_call" if pending else self._finish_reason(last_response)
                        ),
                        continuity=continuity,
                        metadata={
                            "awaiting_broker": pending,
                            "pending_tool_calls": (
                                len(deferred.calls) + len(deferred.approvals)
                                if deferred is not None
                                else 0
                            ),
                        },
                    )
                )
            except RunCancelled:
                await queue.put(
                    events.make(
                        StreamEventType.ERROR,
                        text="The run was cancelled.",
                        error_code="cancelled",
                        retryable=False,
                    )
                )
            except Exception as exc:
                await queue.put(
                    events.make(
                        StreamEventType.ERROR,
                        text="The selected model could not complete the request.",
                        error_code=self._error_code(exc),
                        retryable=self._retryable(exc),
                        metadata={"exception_type": type(exc).__name__},
                    )
                )
            finally:
                await queue.put(_DONE)

        producer = asyncio.create_task(produce(), name=f"cupcake-agent-{events.run_id}")
        try:
            while True:
                item = await queue.get()
                if item is _DONE:
                    break
                yield cast(NormalizedStreamEvent, item)
        finally:
            if not producer.done():
                cancellation.cancel()
                producer.cancel()
            with suppress(asyncio.CancelledError):
                await producer

    def _output_tokens(self, descriptor: ModelDescriptor, request: ModelRequest) -> int:
        requested = request.max_output_tokens or min(
            self._limits.default_max_output_tokens,
            descriptor.max_output_tokens or self._limits.default_max_output_tokens,
        )
        if requested <= 0:
            raise ValueError("max_output_tokens must be positive")
        if descriptor.max_output_tokens is not None and requested > descriptor.max_output_tokens:
            raise OutputLimitExceeded(
                f"{descriptor.id} supports at most {descriptor.max_output_tokens} output tokens"
            )
        return requested

    def _input_budget(self, descriptor: ModelDescriptor, output_tokens: int) -> int:
        capacity = min(descriptor.context_window, self._limits.max_context_tokens)
        input_budget = capacity - output_tokens
        if input_budget <= 0:
            raise OutputLimitExceeded(
                "the requested output leaves no room for input in the selected model context"
            )
        return input_budget

    @staticmethod
    def _model_settings(
        descriptor: ModelDescriptor, request: ModelRequest, output_tokens: int
    ) -> ModelSettings:
        settings: dict[str, Any] = {"max_tokens": output_tokens}
        if request.temperature is not None:
            if not 0 <= request.temperature <= 2:
                raise ValueError("temperature must be between 0 and 2")
            settings["temperature"] = request.temperature
        effort = request.reasoning_effort or descriptor.default_reasoning_effort
        if descriptor.provider == NVIDIA_NIM_PROVIDER:
            # NVIDIA's hosted Nemotron-family chat templates can emit a raw
            # reasoning trace inside ordinary `content` unless thinking is
            # explicitly disabled. This setting is carried by the actual
            # Pydantic/OpenAI request path rather than the adapter-only payload
            # helper. An explicitly selected effort remains explicit as the
            # OpenAI-compatible `reasoning_effort` field.
            settings["extra_body"] = {
                "chat_template_kwargs": {"enable_thinking": False},
            }
            if effort is not ReasoningEffort.NONE:
                settings["openai_reasoning_effort"] = effort.value
        elif effort == ReasoningEffort.NONE:
            settings["thinking"] = False
        elif descriptor.provider == "anthropic":
            settings["anthropic_effort"] = effort.value
        elif descriptor.provider == "openai":
            settings["openai_reasoning_effort"] = effort.value
            settings["openai_reasoning_summary"] = "auto"
        else:
            settings["thinking"] = effort.value

        continuity = request.continuity
        if continuity and continuity.applies_to(descriptor) and descriptor.provider == "openai":
            response_id = continuity.opaque_state.get("response_id")
            if isinstance(response_id, str) and response_id:
                settings["openai_previous_response_id"] = response_id
        return cast(ModelSettings, settings)

    @staticmethod
    def _normalize_pydantic_event(
        descriptor: ModelDescriptor,
        builder: EventBuilder,
        event: Any,
        open_calls: set[str],
    ) -> list[NormalizedStreamEvent]:
        normalized: list[NormalizedStreamEvent] = []
        if isinstance(event, PartStartEvent):
            part = event.part
            if isinstance(part, TextPart) and part.content:
                normalized.append(builder.make(StreamEventType.TEXT_DELTA, text=part.content))
            elif (
                isinstance(part, ThinkingPart) and part.content and descriptor.provider == "openai"
            ):
                # OpenAI Responses maps its requested reasoning summary to a
                # ThinkingPart. Anthropic/Google ThinkingParts may contain raw
                # private reasoning and are deliberately never emitted.
                normalized.append(
                    builder.make(
                        StreamEventType.REASONING_SUMMARY_DELTA,
                        text=part.content,
                        metadata={"summary": True},
                    )
                )
            elif isinstance(part, ToolCallPart):
                call_id = part.tool_call_id
                open_calls.add(call_id)
                normalized.append(
                    builder.make(
                        StreamEventType.TOOL_CALL_START,
                        item_id=call_id,
                        name=part.tool_name,
                        metadata={"destination": "rust-broker"},
                    )
                )
                if part.has_content():
                    normalized.append(
                        builder.make(
                            StreamEventType.TOOL_CALL_DELTA,
                            item_id=call_id,
                            name=part.tool_name,
                            arguments_delta=part.args_as_json_str(),
                        )
                    )
        elif isinstance(event, PartDeltaEvent):
            delta = event.delta
            if isinstance(delta, TextPartDelta) and delta.content_delta:
                normalized.append(
                    builder.make(StreamEventType.TEXT_DELTA, text=delta.content_delta)
                )
            elif (
                isinstance(delta, ThinkingPartDelta)
                and delta.content_delta
                and descriptor.provider == "openai"
            ):
                normalized.append(
                    builder.make(
                        StreamEventType.REASONING_SUMMARY_DELTA,
                        text=delta.content_delta,
                        metadata={"summary": True},
                    )
                )
            elif isinstance(delta, ToolCallPartDelta):
                argument_delta = delta.args_delta
                if isinstance(argument_delta, Mapping):
                    argument_delta = json.dumps(
                        argument_delta, separators=(",", ":"), ensure_ascii=False
                    )
                if argument_delta:
                    normalized.append(
                        builder.make(
                            StreamEventType.TOOL_CALL_DELTA,
                            item_id=delta.tool_call_id,
                            name=delta.tool_name_delta,
                            arguments_delta=str(argument_delta),
                        )
                    )
        elif isinstance(event, FunctionToolCallEvent):
            call_id = event.part.tool_call_id
            if call_id in open_calls:
                open_calls.remove(call_id)
                normalized.append(
                    builder.make(
                        StreamEventType.TOOL_CALL_END,
                        item_id=call_id,
                        name=event.part.tool_name,
                        arguments_delta=event.part.args_as_json_str(),
                        metadata={"awaiting_broker": True},
                    )
                )
        elif isinstance(event, DeferredToolRequestsEvent):
            # FunctionToolCallEvent already emitted each complete call. This
            # marker exists only to guarantee every unusual provider stream is
            # closed before the run pauses for the broker.
            for call in (*event.requests.calls, *event.requests.approvals):
                if call.tool_call_id in open_calls:
                    open_calls.remove(call.tool_call_id)
                    normalized.append(
                        builder.make(
                            StreamEventType.TOOL_CALL_END,
                            item_id=call.tool_call_id,
                            name=call.tool_name,
                            arguments_delta=call.args_as_json_str(),
                            metadata={"awaiting_broker": True},
                        )
                    )
        return normalized

    @staticmethod
    def _token_usage(value: Any) -> TokenUsage:
        details = getattr(value, "details", {}) or {}
        reasoning = int(
            details.get("reasoning_tokens", details.get("thoughts_token_count", 0)) or 0
        )
        return TokenUsage(
            input_tokens=int(getattr(value, "input_tokens", 0) or 0),
            output_tokens=int(getattr(value, "output_tokens", 0) or 0),
            cached_input_tokens=int(getattr(value, "cache_read_tokens", 0) or 0),
            reasoning_tokens=reasoning,
        )

    @staticmethod
    def _continuity(
        descriptor: ModelDescriptor, response: ModelResponse | None
    ) -> ProviderContinuity | None:
        if response is None or not response.provider_response_id:
            return None
        # Only an opaque response identifier crosses the engine boundary. Raw
        # provider details, thinking signatures, SDK messages, and checkpoints do not.
        return ProviderContinuity(
            descriptor.provider,
            descriptor.family,
            {"response_id": response.provider_response_id},
        )

    @staticmethod
    def _finish_reason(response: ModelResponse | None) -> str:
        return response.finish_reason if response and response.finish_reason else "stop"

    @staticmethod
    def _error_code(error: Exception) -> str:
        code = getattr(error, "code", None)
        return str(code) if isinstance(code, str) and len(code) <= 80 else "agent_error"

    @staticmethod
    def _retryable(error: Exception) -> bool:
        retryable = getattr(error, "retryable", None)
        if isinstance(retryable, bool):
            return retryable
        status = getattr(error, "status_code", None)
        return status in {408, 409, 429, 500, 502, 503, 504}
