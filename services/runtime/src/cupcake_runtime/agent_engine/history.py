"""Compile canonical visible conversation history for Pydantic AI.

Provider SDK messages, hidden thinking, signatures, and server checkpoints never
enter this module. A provider switch therefore recompiles the same visible truth.
"""

from __future__ import annotations

from collections.abc import Sequence

from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    SystemPromptPart,
    TextPart,
    UserPromptPart,
)
from pydantic_ai.messages import (
    ModelRequest as PydanticModelRequest,
)

from cupcake_runtime.providers.types import CanonicalMessage

from .models import ContextLimitExceeded, PreparedAgentRequest


def estimate_tokens(text: str) -> int:
    """Conservative local estimate used only to enforce a pre-provider bound."""

    return max(1, (len(text.encode("utf-8")) + 2) // 3)


def _message_tokens(message: CanonicalMessage) -> int:
    return 12 + estimate_tokens(message.content)


def _visible_turns(messages: Sequence[CanonicalMessage]) -> list[list[CanonicalMessage]]:
    """Group history at user boundaries and discard malformed leading fragments."""

    turns: list[list[CanonicalMessage]] = []
    current: list[CanonicalMessage] = []
    for message in messages:
        if message.role == "user":
            if current:
                turns.append(current)
            current = [message]
        elif current:
            current.append(message)
    if current:
        turns.append(current)
    return turns


def prepare_visible_history(
    messages: Sequence[CanonicalMessage],
    *,
    context_token_budget: int,
    max_output_tokens: int,
    additional_instructions: Sequence[str] = (),
) -> tuple[PreparedAgentRequest, list[ModelMessage]]:
    """Keep the newest complete visible turns within a hard context budget."""

    if not messages:
        raise ValueError("at least one canonical message is required")

    prompt_index = next(
        (index for index in range(len(messages) - 1, -1, -1) if messages[index].role == "user"),
        None,
    )
    if prompt_index is None:
        raise ValueError("a canonical user message is required")
    if prompt_index != len(messages) - 1:
        raise ValueError("the final canonical message must be the current user prompt")

    prompt_message = messages[prompt_index]
    system_messages = (
        *(message.content for message in messages if message.role == "system"),
        *(instruction for instruction in additional_instructions if instruction.strip()),
    )
    fixed_tokens = _message_tokens(prompt_message) + sum(
        estimate_tokens(value) + 8 for value in system_messages
    )
    if fixed_tokens > context_token_budget:
        raise ContextLimitExceeded(
            "the current prompt and system instructions exceed the selected model context limit"
        )

    candidates = [message for message in messages[:prompt_index] if message.role != "system"]
    selected_turns_reversed: list[list[CanonicalMessage]] = []
    used_tokens = fixed_tokens
    for turn in reversed(_visible_turns(candidates)):
        cost = sum(_message_tokens(message) for message in turn)
        if used_tokens + cost > context_token_budget:
            break
        selected_turns_reversed.append(turn)
        used_tokens += cost
    selected = [message for turn in reversed(selected_turns_reversed) for message in turn]

    history: list[ModelMessage] = []
    for message in selected:
        if message.role == "assistant":
            history.append(ModelResponse(parts=[TextPart(message.content)]))
        elif message.role == "user":
            history.append(PydanticModelRequest(parts=[UserPromptPart(message.content)]))
        elif message.role == "tool":
            label = message.name or "tool"
            # Canonical history intentionally does not persist provider-native tool
            # call objects. Render the visible result as user context so malformed
            # or cross-provider call IDs cannot poison the next provider request.
            history.append(
                PydanticModelRequest(
                    parts=[UserPromptPart(f"[Visible result from {label}]\n{message.content}")]
                )
            )
        else:
            raise ValueError(f"unsupported canonical message role: {message.role!r}")

    # System instructions are passed separately to Agent.run, but constructing a
    # part here gives type checking an early validation point for their content.
    for instruction in system_messages:
        SystemPromptPart(instruction)

    plan = PreparedAgentRequest(
        prompt=prompt_message.content,
        system_instructions=system_messages,
        history_message_count=len(selected),
        dropped_history_messages=len(candidates) - len(selected),
        estimated_context_tokens=used_tokens,
        max_output_tokens=max_output_tokens,
    )
    return plan, history
