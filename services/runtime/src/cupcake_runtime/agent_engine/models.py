"""Product-owned contracts for the Pydantic AI agent boundary."""

from __future__ import annotations

from dataclasses import dataclass

from pydantic_ai.messages import UserContent


class AgentEngineError(RuntimeError):
    """Base error for requests rejected before a provider call is made."""


class ContextLimitExceeded(AgentEngineError):
    """Raised when the current user turn alone cannot fit the selected model."""


class OutputLimitExceeded(AgentEngineError):
    """Raised when a request asks for more output than the selected model supports."""


@dataclass(frozen=True, slots=True)
class AgentLimits:
    """Hard per-run safety limits applied in addition to provider limits."""

    max_context_tokens: int = 128_000
    default_max_output_tokens: int = 8_192
    max_model_requests: int = 8
    max_tool_calls: int = 16

    def __post_init__(self) -> None:
        if (
            min(
                self.max_context_tokens,
                self.default_max_output_tokens,
                self.max_model_requests,
                self.max_tool_calls,
            )
            <= 0
        ):
            raise ValueError("agent limits must be positive")


@dataclass(frozen=True, slots=True)
class PreparedAgentRequest:
    """Observable, provider-neutral request plan passed to the Pydantic backend."""

    prompt: str | tuple[UserContent, ...]
    system_instructions: tuple[str, ...]
    history_message_count: int
    dropped_history_messages: int
    estimated_context_tokens: int
    max_output_tokens: int
