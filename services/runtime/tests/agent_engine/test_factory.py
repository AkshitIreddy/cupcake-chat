from __future__ import annotations

import json
from typing import Any

import pytest
from httpx2 import AsyncClient, MockTransport, Request, Response
from openai import AsyncOpenAI
from pydantic_ai import Agent
from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from cupcake_runtime.agent_engine.factory import PydanticModelFactory
from cupcake_runtime.providers.base import ProviderConfig
from cupcake_runtime.providers.catalog import ModelCatalog, openai_compatible_descriptor
from cupcake_runtime.providers.types import (
    CanonicalMessage,
    ModelCapabilities,
    ModelDescriptor,
    ModelRequest,
)


class StubbedPydanticModelFactory(PydanticModelFactory):
    """Expose a public test seam while production builders remain protected."""

    @classmethod
    def patch_builder(
        cls,
        monkeypatch: pytest.MonkeyPatch,
        provider: str,
        builder: Any,
    ) -> None:
        monkeypatch.setitem(cls._builders, provider, builder)


@pytest.mark.parametrize("provider", ["openai", "anthropic", "google", "xai", "mistral", "cohere"])
def test_factory_dispatches_every_direct_cloud_provider_builder(
    provider: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    descriptor = ModelCatalog.builtins().list(provider=provider)[0]
    seen: dict[str, Any] = {}

    def builder(model_name: str, **kwargs: Any) -> object:
        seen.update(model_name=model_name, **kwargs)
        return object()

    StubbedPydanticModelFactory.patch_builder(
        monkeypatch,
        provider,
        builder,
    )
    request = ModelRequest(
        descriptor.id,
        (CanonicalMessage("user", "hello"),),
    )
    result = StubbedPydanticModelFactory().build(
        descriptor,
        ProviderConfig(api_key="secret", base_url="https://example.invalid/v1"),
        request,
    )
    assert result is not None
    assert seen["model_name"] == descriptor.model
    assert seen["api_key"] == "secret"
    if provider == "xai":
        assert seen["base_url"] == "https://example.invalid/v1"


def test_generic_openai_compatible_requires_an_explicit_endpoint() -> None:
    descriptor = ModelDescriptor(
        id="openai-compatible:local",
        provider="openai-compatible",
        model="local",
        display_name="Local endpoint",
        family="local",
        context_window=8_192,
        max_output_tokens=1_024,
        capabilities=ModelCapabilities(),
    )
    request = ModelRequest(descriptor.id, (CanonicalMessage("user", "hello"),))
    with pytest.raises(ValueError, match="explicit base URL"):
        PydanticModelFactory().build(descriptor, ProviderConfig(), request)


@pytest.mark.asyncio
async def test_group_selector_compatible_transport_makes_one_wire_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = 0

    async def capture(_request: Request) -> Response:
        nonlocal attempts
        attempts += 1
        return Response(503, json={"error": {"message": "temporary provider failure"}})

    descriptor = openai_compatible_descriptor(
        "groq",
        "openai/gpt-oss-20b",
        "Groq GPT OSS 20B",
        context_window=131_072,
        max_output_tokens=65_536,
    )
    request = ModelRequest(
        descriptor.id,
        (CanonicalMessage("user", "Choose one participant."),),
        metadata={"group_selector": True},
    )

    async with AsyncClient(transport=MockTransport(capture)) as http_client:
        client = AsyncOpenAI(
            api_key="recorded-test-key",
            base_url="https://api.groq.com/openai/v1",
            http_client=http_client,
            max_retries=0,
        )

        def no_retry_client(**kwargs: Any) -> AsyncOpenAI:
            assert kwargs["max_retries"] == 0
            return client

        monkeypatch.setattr("openai.AsyncOpenAI", no_retry_client)
        model = PydanticModelFactory().build(
            descriptor,
            ProviderConfig(
                api_key="recorded-test-key",
                base_url="https://api.groq.com/openai/v1",
            ),
            request,
        )

        with pytest.raises(ModelHTTPError, match="503"):
            await Agent(model).run("Choose one participant.")

    assert attempts == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("endpoint_id", "expected_field", "excluded_field"),
    (
        ("cloudflare", "max_tokens", "max_completion_tokens"),
        ("openrouter", "max_tokens", "max_completion_tokens"),
        ("cupcake-local", "max_completion_tokens", "max_tokens"),
    ),
)
async def test_compatible_endpoint_profiles_choose_the_verified_wire_token_field(
    endpoint_id: str,
    expected_field: str,
    excluded_field: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    async def capture(request: Request) -> Response:
        captured["body"] = json.loads(request.content)
        return Response(
            200,
            json={
                "id": "chatcmpl-recorded",
                "object": "chat.completion",
                "created": 1,
                "model": "recorded/model",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "bounded"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 4, "completion_tokens": 1, "total_tokens": 5},
            },
        )

    async with AsyncClient(transport=MockTransport(capture)) as http_client:
        provider = OpenAIProvider(
            openai_client=AsyncOpenAI(
                api_key="recorded-test-key",
                base_url="https://example.invalid/v1",
                http_client=http_client,
                max_retries=0,
            )
        )

        def recorded_provider(**_kwargs: Any) -> OpenAIProvider:
            return provider

        monkeypatch.setattr(
            "pydantic_ai.providers.openai.OpenAIProvider",
            recorded_provider,
        )
        descriptor = openai_compatible_descriptor(
            endpoint_id,
            "recorded/model",
            "Recorded model",
            context_window=8_192,
            max_output_tokens=1_024,
        )
        request = ModelRequest(descriptor.id, (CanonicalMessage("user", "hello"),))
        model = PydanticModelFactory().build(
            descriptor,
            ProviderConfig(api_key="recorded-test-key", base_url="https://example.invalid/v1"),
            request,
        )
        assert isinstance(model, OpenAIChatModel)
        await Agent(model).run("hello", model_settings={"max_tokens": 200})

    assert captured["body"][expected_field] == 200
    assert excluded_field not in captured["body"]


def test_factory_dispatches_dynamic_nvidia_nim_model_without_generic_routing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    descriptor = ModelDescriptor(
        id="nvidia-nim:meta/test-chat",
        provider="nvidia-nim",
        model="meta/test-chat",
        display_name="NVIDIA test chat",
        family="nvidia-nim:meta/test-chat",
        context_window=8_192,
        max_output_tokens=1_024,
        capabilities=ModelCapabilities(),
    )
    seen: dict[str, Any] = {}

    def builder(model_name: str, **kwargs: Any) -> object:
        seen.update(model_name=model_name, **kwargs)
        return object()

    StubbedPydanticModelFactory.patch_builder(monkeypatch, "nvidia-nim", builder)
    request = ModelRequest(descriptor.id, (CanonicalMessage("user", "hello"),))
    result = StubbedPydanticModelFactory().build(
        descriptor,
        ProviderConfig(api_key="nvapi-recorded"),
        request,
    )

    assert result is not None
    assert seen == {"model_name": "meta/test-chat", "api_key": "nvapi-recorded"}
