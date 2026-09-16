from __future__ import annotations

import pytest
from pydantic_ai.messages import BinaryContent, ModelResponse, UserPromptPart
from pydantic_ai.messages import ModelRequest as PydanticModelRequest

from cupcake_runtime.agent_engine.history import prepare_visible_history
from cupcake_runtime.agent_engine.models import ContextLimitExceeded
from cupcake_runtime.providers.types import CanonicalMessage


def message(
    role: str,
    content: str,
    *,
    name: str | None = None,
    tool_call_id: str | None = None,
) -> CanonicalMessage:
    return CanonicalMessage(role, content, name=name, tool_call_id=tool_call_id)


def test_visible_history_keeps_newest_complete_messages_and_reports_drops() -> None:
    messages = (
        message("system", "Be precise."),
        message("user", "old " * 100),
        message("assistant", "old answer " * 100),
        message("user", "recent question"),
        message("assistant", "recent answer"),
        message("user", "current question"),
    )
    plan, history = prepare_visible_history(
        messages,
        context_token_budget=85,
        max_output_tokens=20,
        additional_instructions=("Use a warm, concise personality.",),
    )

    assert plan.prompt == "current question"
    assert plan.system_instructions == (
        "Be precise.",
        "Use a warm, concise personality.",
    )
    assert plan.dropped_history_messages == 2
    assert len(history) == 2
    assert isinstance(history[0], PydanticModelRequest)
    assert isinstance(history[1], ModelResponse)


def test_tool_result_becomes_visible_neutral_context_not_native_provider_state() -> None:
    plan, history = prepare_visible_history(
        (
            message("user", "look it up"),
            message("tool", "safe result", name="web.search", tool_call_id="provider-call"),
            message("user", "summarize"),
        ),
        context_token_budget=1_000,
        max_output_tokens=100,
    )
    assert plan.history_message_count == 2
    tool_context = history[1]
    assert isinstance(tool_context, PydanticModelRequest)
    part = tool_context.parts[0]
    assert isinstance(part, UserPromptPart)
    assert part.content == "[Visible result from web.search]\nsafe result"
    assert "provider-call" not in part.content


def test_current_prompt_is_never_silently_truncated() -> None:
    with pytest.raises(ContextLimitExceeded):
        prepare_visible_history(
            (message("user", "x" * 2_000),),
            context_token_budget=20,
            max_output_tokens=10,
        )


def test_current_binary_attachment_becomes_in_memory_user_content() -> None:
    payload = b"\x89PNG\r\n\x1a\nrecorded-image"
    plan, history = prepare_visible_history(
        (
            CanonicalMessage(
                "user",
                "Describe this image.",
                attachments=(
                    {
                        "data": payload,
                        "media_type": "image/png",
                        "name": "cupcake.png",
                    },
                ),
            ),
        ),
        context_token_budget=10_000,
        max_output_tokens=100,
    )
    assert history == []
    assert isinstance(plan.prompt, tuple)
    assert plan.prompt[0] == "Describe this image."
    binary = plan.prompt[1]
    assert isinstance(binary, BinaryContent)
    assert binary.data == payload
    assert binary.media_type == "image/png"
    assert binary.identifier == "cupcake.png"


def test_history_budget_never_keeps_an_orphan_assistant_message() -> None:
    plan, history = prepare_visible_history(
        (
            message("user", "first question " * 30),
            message("assistant", "tiny answer"),
            message("user", "current"),
        ),
        context_token_budget=50,
        max_output_tokens=10,
    )
    assert plan.dropped_history_messages == 2
    assert history == []


def test_empty_failed_assistant_receipt_stays_out_of_provider_history() -> None:
    plan, history = prepare_visible_history(
        (
            message("user", "question whose provider failed"),
            message("assistant", "   \n"),
            message("user", "try this with another model"),
        ),
        context_token_budget=1_000,
        max_output_tokens=100,
    )

    assert plan.prompt == "try this with another model"
    assert plan.history_message_count == 1
    assert plan.dropped_history_messages == 1
    assert len(history) == 1
    prior_user = history[0]
    assert isinstance(prior_user, PydanticModelRequest)
    assert isinstance(prior_user.parts[0], UserPromptPart)
    assert prior_user.parts[0].content == "question whose provider failed"
    assert not any(isinstance(item, ModelResponse) for item in history)


@pytest.mark.parametrize("messages", [(), (message("assistant", "answer"),)])
def test_current_user_prompt_is_required(messages: tuple[CanonicalMessage, ...]) -> None:
    with pytest.raises(ValueError):
        prepare_visible_history(messages, context_token_budget=100, max_output_tokens=10)
