"""xAI adapter using its OpenAI-compatible API."""

from .base import MissingProviderDependency
from .openai_compatible import OpenAICompatibleAdapter
from .types import ModelRequest, ReasoningEffort


class XAIAdapter(OpenAICompatibleAdapter):
    provider = "xai"

    def build_request(self, request: ModelRequest):
        payload = super().build_request(request)
        effort = self.effort(request)
        if effort != ReasoningEffort.NONE:
            payload["reasoning_effort"] = effort.value
        return payload


def build_pydantic_model(
    model_name: str,
    *,
    api_key: str | None = None,
    base_url: str = "https://api.x.ai/v1",
    disable_retries: bool = False,
):
    try:
        from openai import AsyncOpenAI
        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.openai import OpenAIProvider
    except ImportError as exc:
        raise MissingProviderDependency("xai", "pydantic-ai-slim[openai]") from exc
    provider = (
        OpenAIProvider(
            openai_client=AsyncOpenAI(
                api_key=api_key,
                base_url=base_url,
                max_retries=0,
            )
        )
        if disable_retries
        else OpenAIProvider(api_key=api_key, base_url=base_url)
    )
    return OpenAIChatModel(model_name, provider=provider)
