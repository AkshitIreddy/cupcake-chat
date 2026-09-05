"""Provider boundary and shared normalization utilities."""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Iterable, Mapping
from dataclasses import dataclass
from typing import Any, cast

from .types import (
    CanonicalMessage,
    ModelDescriptor,
    ModelRequest,
    NormalizedStreamEvent,
    ProviderContinuity,
    ReasoningEffort,
    StreamEventType,
    TokenUsage,
    UsageCost,
    uuid7,
)


class ProviderError(RuntimeError):
    def __init__(self, message: str, *, code: str = "provider_error", retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class MalformedProviderEvent(ProviderError):
    """A recognized provider event omitted data required by our contract."""

    def __init__(self, provider: str, event_type: str, field: str):
        super().__init__(
            f"{provider} returned a malformed {event_type!r} event (missing {field})",
            code="malformed_provider_event",
            retryable=False,
        )


class MissingProviderDependency(ProviderError):
    def __init__(self, provider: str, package: str):
        super().__init__(
            f"{provider} support requires the optional package {package!r}",
            code="missing_provider_dependency",
        )


class MissingProviderCredential(ProviderError):
    def __init__(self, provider: str, env_name: str):
        super().__init__(
            f"{provider} is not configured; provide {env_name}",
            code="missing_provider_credential",
        )


@dataclass(frozen=True, slots=True)
class ProviderConfig:
    api_key: str | None = None
    base_url: str | None = None
    organization: str | None = None
    account_id: str | None = None
    timeout_seconds: float = 120.0
    headers: Mapping[str, str] | None = None


class ProviderAdapter(ABC):
    provider: str

    def __init__(self, descriptor: ModelDescriptor, config: ProviderConfig, *, client: Any = None):
        if descriptor.provider != self.provider:
            raise ValueError(
                f"descriptor provider {descriptor.provider!r} does not match {self.provider!r}"
            )
        self.descriptor = descriptor
        self.config = config
        self._client: Any = client

    def validate_request(self, request: ModelRequest) -> None:
        if request.model_id != self.descriptor.id:
            raise ValueError(
                f"request selected {request.model_id!r}, adapter is {self.descriptor.id!r}"
            )
        if (
            request.reasoning_effort is not None
            and request.reasoning_effort not in self.descriptor.reasoning_efforts
        ):
            supported = ", ".join(v.value for v in self.descriptor.reasoning_efforts) or "none"
            raise ValueError(f"unsupported reasoning effort; choose one of: {supported}")
        if request.tools and not self.descriptor.capabilities.tools:
            raise ValueError(f"{self.descriptor.id} does not support tools")
        total_attachment_bytes = 0
        for message in request.messages:
            for attachment in message.attachments:
                data = attachment.get("data")
                media_type = attachment.get("media_type")
                if not isinstance(data, bytes) or not data:
                    raise ValueError("attachments must contain non-empty app-owned bytes")
                if not isinstance(media_type, str):
                    raise ValueError("attachments must contain a validated media_type")
                if media_type.startswith("image/"):
                    if not self.descriptor.capabilities.images:
                        raise ValueError(f"{self.descriptor.id} does not support image input")
                elif media_type == "application/pdf":
                    if not self.descriptor.capabilities.documents:
                        raise ValueError(f"{self.descriptor.id} does not support document input")
                else:
                    raise ValueError(f"unsupported binary attachment media type: {media_type}")
                total_attachment_bytes += len(data)
                if len(data) > 20 * 1024 * 1024:
                    raise ValueError("an attachment exceeds the 20 MiB provider input limit")
        if total_attachment_bytes > 24 * 1024 * 1024:
            raise ValueError("attachments exceed the 24 MiB provider input limit")
        if request.continuity and not request.continuity.applies_to(self.descriptor):
            # Provider state is an optimization, never canonical history. Silently
            # dropping it prevents cross-provider leakage while retaining messages.
            return

    def usable_continuity(self, request: ModelRequest) -> ProviderContinuity | None:
        if request.continuity and request.continuity.applies_to(self.descriptor):
            return request.continuity
        return None

    def effort(self, request: ModelRequest) -> ReasoningEffort:
        return request.reasoning_effort or self.descriptor.default_reasoning_effort

    def cost(self, usage: TokenUsage) -> UsageCost:
        pricing = self.descriptor.pricing
        return UsageCost(pricing.estimate(usage), pricing.currency, pricing.source)

    @abstractmethod
    def stream(self, request: ModelRequest) -> AsyncIterator[NormalizedStreamEvent]:
        raise NotImplementedError


class EventBuilder:
    """Build monotonically sequenced events for one provider call."""

    def __init__(self, descriptor: ModelDescriptor, run_id: str | None = None):
        self.descriptor = descriptor
        self.run_id = run_id or uuid7()
        self.sequence = 0

    def make(self, event_type: StreamEventType, **kwargs: Any) -> NormalizedStreamEvent:
        event = NormalizedStreamEvent(event_type, self.sequence, self.run_id, **kwargs)
        self.sequence += 1
        return event


@dataclass(frozen=True, slots=True)
class ClassifiedProviderError:
    """Safe, product-owned error details derived from an SDK exception."""

    message: str
    code: str
    retryable: bool


def classify_provider_error(error: Exception) -> ClassifiedProviderError:
    """Normalize common SDK failure shapes without persisting raw response bodies.

    Provider SDK exceptions regularly embed request headers or response bodies in
    ``str(error)``.  The desktop event stream therefore uses short product-owned
    messages and only exposes a stable category and retryability bit.
    """

    current: BaseException | None = error
    status = None
    class_names: list[str] = []
    local_usage_limit: str | None = None
    for _ in range(5):
        if current is None:
            break
        if isinstance(current, ProviderError):
            return ClassifiedProviderError(str(current), current.code, current.retryable)
        class_names.append(type(current).__name__.lower())
        if type(current).__name__ == "UsageLimitExceeded" and type(current).__module__.startswith(
            "pydantic_ai"
        ):
            # This is Pydantic AI's product-side run budget, not a provider
            # account or quota response. Its message is locally generated and
            # safe to use only for choosing a stable product category.
            local_usage_limit = str(current)
        status = (
            get_path(current, "status_code")
            or get_path(current, "response.status_code")
            or get_path(current, "code")
        )
        if status is not None:
            break
        current = current.__cause__ or current.__context__
    try:
        status_code = int(status) if status is not None else None
    except (TypeError, ValueError):
        status_code = None
    class_name = " ".join(class_names)
    error_message = str(getattr(error, "message", ""))

    if "unexpectedmodelbehavior" in class_name and error_message.startswith("Model token limit ("):
        return ClassifiedProviderError(
            "The model used its output allowance before producing a response.",
            "output_limit",
            False,
        )

    if local_usage_limit is not None:
        if "output_tokens_limit" in local_usage_limit:
            return ClassifiedProviderError(
                "The response exceeded the app's output allowance.",
                "output_limit",
                False,
            )
        return ClassifiedProviderError(
            "The run reached an app usage safety limit.",
            "usage_limit",
            False,
        )

    if status_code in {401, 403} or "authentication" in class_name or "permission" in class_name:
        return ClassifiedProviderError(
            "The provider rejected the configured credential.",
            "authentication_failed",
            False,
        )
    if status_code == 429 or "ratelimit" in class_name or "rate_limit" in class_name:
        return ClassifiedProviderError(
            "The provider rate limit was exceeded.",
            "rate_limit",
            True,
        )
    if status_code == 408 or "timeout" in class_name:
        return ClassifiedProviderError(
            "The provider request timed out.",
            "timeout",
            True,
        )
    if status_code == 404:
        return ClassifiedProviderError(
            "The selected model is unavailable for this provider account.",
            "model_unavailable",
            False,
        )
    if status_code is not None and 400 <= status_code < 500:
        return ClassifiedProviderError(
            "The provider rejected the model request.",
            "invalid_request",
            False,
        )
    if status_code is not None and status_code >= 500:
        return ClassifiedProviderError(
            "The provider is temporarily unavailable.",
            "provider_unavailable",
            True,
        )
    if any(token in class_name for token in ("connection", "network", "transport")):
        return ClassifiedProviderError(
            "The provider could not be reached.",
            "network_error",
            True,
        )
    return ClassifiedProviderError(
        f"The provider request failed ({type(error).__name__}).",
        "provider_error",
        False,
    )


def provider_error_event(builder: EventBuilder, error: Exception) -> NormalizedStreamEvent:
    classified = classify_provider_error(error)
    return builder.make(
        StreamEventType.ERROR,
        text=classified.message,
        error_code=classified.code,
        retryable=classified.retryable,
    )


def require_event_field(provider: str, event_type: str, field: str, value: Any) -> Any:
    """Return an event field or fail deterministically for malformed known events."""

    if value is None:
        raise MalformedProviderEvent(provider, event_type, field)
    return value


def openai_messages(messages: tuple[CanonicalMessage, ...]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for message in messages:
        item: dict[str, Any] = {"role": message.role, "content": message.content}
        if message.name:
            item["name"] = message.name
        if message.tool_call_id:
            item["tool_call_id"] = message.tool_call_id
        result.append(item)
    return result


def anthropic_messages(
    messages: tuple[CanonicalMessage, ...],
) -> tuple[str | None, list[dict[str, Any]]]:
    system_parts = [m.content for m in messages if m.role == "system"]
    normal = [{"role": m.role, "content": m.content} for m in messages if m.role != "system"]
    return ("\n\n".join(system_parts) or None, normal)


def coerce_mapping(value: Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    if hasattr(value, "model_dump"):
        dumped = value.model_dump()
        return cast(Mapping[str, Any], dumped) if isinstance(dumped, Mapping) else {}
    if hasattr(value, "to_dict"):
        dumped = value.to_dict()
        return cast(Mapping[str, Any], dumped) if isinstance(dumped, Mapping) else {}
    return cast(dict[str, Any], vars(value)) if hasattr(value, "__dict__") else {}


def get_path(value: Any, path: str, default: Any = None) -> Any:
    current = value
    for part in path.split("."):
        if isinstance(current, Mapping):
            current = cast(Mapping[str, Any], current).get(part, default)
        else:
            current = getattr(current, part, default)
        if current is default:
            break
    return current


def provider_items(value: Any) -> Iterable[Any]:
    """Normalize dynamic SDK list fields at one typed provider boundary."""

    if isinstance(value, Iterable) and not isinstance(value, (str, bytes, Mapping)):
        return cast(Iterable[Any], value)
    return ()


def json_arguments(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
