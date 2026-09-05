"""Construct Pydantic AI models from an explicit product model selection."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, ClassVar, Protocol

from cupcake_runtime.providers import anthropic, cohere, gemini, mistral, nvidia_nim, openai, xai
from cupcake_runtime.providers.base import MissingProviderDependency, ProviderConfig
from cupcake_runtime.providers.types import ModelDescriptor, ModelRequest


class AgentModelFactory(Protocol):
    def build(
        self,
        descriptor: ModelDescriptor,
        config: ProviderConfig,
        request: ModelRequest,
    ) -> Any: ...


Builder = Callable[..., Any]


class PydanticModelFactory:
    """Use direct provider builders plus first-class and generic compatible routes."""

    _builders: ClassVar[dict[str, Builder]] = {
        "openai": openai.build_pydantic_model,
        "anthropic": anthropic.build_pydantic_model,
        "google": gemini.build_pydantic_model,
        "xai": xai.build_pydantic_model,
        "mistral": mistral.build_pydantic_model,
        "cohere": cohere.build_pydantic_model,
        "nvidia-nim": nvidia_nim.build_pydantic_model,
    }

    def build(
        self,
        descriptor: ModelDescriptor,
        config: ProviderConfig,
        request: ModelRequest,
    ) -> Any:
        disable_retries = is_bounded_group_call(request)
        if descriptor.provider == "mock":
            try:
                from pydantic_ai.models.test import TestModel
            except ImportError as exc:  # pragma: no cover - providers extra is bundled
                raise MissingProviderDependency("mock", "pydantic-ai-slim") from exc
            prompt = next(
                (
                    message.content
                    for message in reversed(request.messages)
                    if message.role == "user"
                ),
                "",
            )
            response = str(request.metadata.get("mock_response") or f"Cupcake received: {prompt}")
            return TestModel(custom_output_text=response, model_name=descriptor.model)
        if descriptor.provider == "openai-compatible":
            return self._openai_compatible(descriptor, config, request)
        try:
            builder = self._builders[descriptor.provider]
        except KeyError as exc:
            raise ValueError(f"no Pydantic model builder for {descriptor.provider!r}") from exc
        if descriptor.provider != "nvidia-nim":
            base_url = config.base_url
            if descriptor.provider == "xai":
                base_url = base_url or "https://api.x.ai/v1"
            return builder(
                descriptor.model,
                api_key=config.api_key,
                base_url=base_url,
                disable_retries=disable_retries,
            )
        return builder(
            descriptor.model,
            api_key=config.api_key,
            disable_retries=disable_retries,
        )

    @staticmethod
    def _openai_compatible(
        descriptor: ModelDescriptor,
        config: ProviderConfig,
        request: ModelRequest,
    ) -> Any:
        if not config.base_url:
            raise ValueError("an OpenAI-compatible endpoint requires an explicit base URL")
        try:
            from openai import AsyncOpenAI
            from pydantic_ai.models.openai import OpenAIChatModel
            from pydantic_ai.profiles.openai import OpenAIModelProfile
            from pydantic_ai.providers.openai import OpenAIProvider
        except ImportError as exc:
            raise MissingProviderDependency(
                "openai-compatible", "pydantic-ai-slim[openai]"
            ) from exc
        provider = (
            OpenAIProvider(
                openai_client=AsyncOpenAI(
                    api_key=config.api_key or "not-required",
                    base_url=config.base_url,
                    max_retries=0,
                )
            )
            if is_bounded_group_call(request)
            else OpenAIProvider(
                api_key=config.api_key or "not-required",
                base_url=config.base_url,
            )
        )
        endpoint_id = descriptor.metadata.get("endpoint_id")
        if endpoint_id in {"cloudflare", "openrouter"}:
            # These documented compatibility endpoints accept the established
            # Chat Completions `max_tokens` field. The generic OpenAI profile
            # otherwise emits the newer OpenAI-only `max_completion_tokens`,
            # which Cloudflare ignores and then falls back to its own default.
            return OpenAIChatModel(
                descriptor.model,
                provider=provider,
                profile=OpenAIModelProfile(
                    openai_chat_supports_max_completion_tokens=False,
                ),
            )
        return OpenAIChatModel(descriptor.model, provider=provider)


def is_bounded_group_call(request: ModelRequest) -> bool:
    return request.metadata.get("group_call") is True or request.metadata.get(
        "group_selector"
    ) is True
