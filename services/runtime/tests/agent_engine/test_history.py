from __future__ import annotations

import pytest
from pydantic_ai.messages import ModelRequest as PydanticModelRequest
from pydantic_ai.messages import ModelResponse, UserPromptPart

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


@pytest.mark.parametrize("messages", [(), (message("assistant", "answer"),)])
def test_current_user_prompt_is_required(messages: tuple[CanonicalMessage, ...]) -> None:
    with pytest.raises(ValueError):
        prepare_visible_history(messages, context_token_budget=100, max_output_tokens=10)
