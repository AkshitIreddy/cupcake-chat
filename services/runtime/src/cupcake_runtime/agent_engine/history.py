"""Compile canonical visible conversation history for Pydantic AI.

Provider SDK messages, hidden thinking, signatures, and server checkpoints never
enter this module. A provider switch therefore recompiles the same visible truth.
"""

from __future__ import annotations

from collections.abc import Sequence

from pydantic_ai.messages import (
    BinaryContent,
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
    # Binary inputs are bounded independently at the provider boundary. This
    # allowance keeps local context pruning deterministic without pretending
    # that vendor image/PDF tokenization can be inferred from file bytes.
    binary_allowance = sum(
        2_048 + ((len(data) + 2_047) // 2_048)
        for attachment in message.attachments
        if isinstance((data := attachment.get("data")), bytes)
    )
    return 12 + estimate_tokens(message.content) + binary_allowance


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

    candidate_messages = [
        message for message in messages[:prompt_index] if message.role != "system"
    ]
    # Failed provider attempts are persisted as assistant receipts even when no
    # text arrived. They belong in product history so the UI can explain and
    # recover the turn, but an empty assistant part is not visible context and
    # several provider APIs reject it as a malformed wire message. Keep the
    # preceding user turn while omitting only the empty assistant payload.
    candidates = [
        message
        for message in candidate_messages
        if message.role != "assistant" or bool(message.content.strip())
    ]
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

    prompt: str | tuple[str | BinaryContent, ...] = prompt_message.content
    if prompt_message.attachments:
        prompt = (
            prompt_message.content,
            *(
                BinaryContent(
                    data=attachment["data"],
                    media_type=str(attachment["media_type"]),
                    identifier=(
                        str(attachment["name"]) if isinstance(attachment.get("name"), str) else None
                    ),
                )
                for attachment in prompt_message.attachments
            ),
        )

    plan = PreparedAgentRequest(
        prompt=prompt,
        system_instructions=system_messages,
        history_message_count=len(selected),
        dropped_history_messages=len(candidate_messages) - len(selected),
        estimated_context_tokens=used_tokens,
        max_output_tokens=max_output_tokens,
    )
    return plan, history
