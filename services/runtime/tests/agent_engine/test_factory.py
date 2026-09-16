from __future__ import annotations

import json
from typing import Any, cast

import httpx
import pytest
from anthropic import AsyncAnthropic
from cohere import AsyncClientV2
from google.genai.types import HttpRetryOptions
from httpx2 import AsyncClient, MockTransport, Request, Response
from openai import AsyncOpenAI
from pydantic_ai import Agent
from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.cohere import CohereModel
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.providers.openai import OpenAIProvider

from cupcake_runtime.agent_engine.factory import PydanticModelFactory
from cupcake_runtime.providers import (
    anthropic,
    cohere,
    gemini,
    mistral,
    nvidia_nim,
    openai,
    xai,
)
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
    assert seen["disable_retries"] is False
    if provider == "xai":
        assert seen["base_url"] == "https://example.invalid/v1"


@pytest.mark.parametrize(
    "provider",
    ["openai", "anthropic", "google", "xai", "mistral", "cohere", "nvidia-nim"],
)
def test_factory_disables_native_sdk_retries_only_for_group_calls(
    provider: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    descriptor = (
        ModelDescriptor(
            id="nvidia-nim:meta/test-chat",
            provider="nvidia-nim",
            model="meta/test-chat",
            display_name="NVIDIA test chat",
            family="nvidia-nim:meta/test-chat",
            context_window=8_192,
            max_output_tokens=1_024,
            capabilities=ModelCapabilities(),
        )
        if provider == "nvidia-nim"
        else ModelCatalog.builtins().list(provider=provider)[0]
    )
    seen: dict[str, Any] = {}

    def builder(model_name: str, **kwargs: Any) -> object:
        seen.update(model_name=model_name, **kwargs)
        return object()

    StubbedPydanticModelFactory.patch_builder(monkeypatch, provider, builder)
    PydanticModelFactory().build(
        descriptor,
        ProviderConfig(api_key="secret"),
        ModelRequest(
            descriptor.id,
            (CanonicalMessage("user", "hello"),),
            metadata={"group_call": True},
        ),
    )

    assert seen["disable_retries"] is True


@pytest.mark.parametrize(
    ("builder", "kwargs"),
    (
        (openai.build_pydantic_model, {"base_url": "https://example.invalid/v1"}),
        (xai.build_pydantic_model, {"base_url": "https://example.invalid/v1"}),
        (nvidia_nim.build_pydantic_model, {}),
    ),
    ids=("openai", "xai", "nvidia-nim"),
)
def test_group_openai_sdk_family_clients_pin_zero_retries(
    builder: Any, kwargs: dict[str, str]
) -> None:
    model = builder(
        "recorded/model",
        api_key="recorded-test-key",
        disable_retries=True,
        **kwargs,
    )
    client = model.provider.client
    assert client.max_retries == 0


def test_group_google_mistral_and_cohere_clients_pin_one_attempt() -> None:
    google_model = gemini.build_pydantic_model(
        "gemini-recorded",
        api_key="recorded-test-key",
        base_url="https://example.invalid",
        disable_retries=True,
    )
    google_client = cast(Any, google_model).provider.client
    assert google_client._api_client._http_options.retry_options.attempts == 1

    mistral_model = mistral.build_pydantic_model(
        "mistral-recorded",
        api_key="recorded-test-key",
        base_url="https://example.invalid",
        disable_retries=True,
    )
    mistral_client = cast(Any, mistral_model).provider.client
    assert mistral_client.sdk_configuration.retry_config is None

    cohere_model = cohere.build_pydantic_model(
        "command-recorded",
        api_key="recorded-test-key",
        base_url="https://example.invalid",
        disable_retries=True,
    )
    cohere_client = cast(Any, cohere_model).provider.client
    assert cohere_client._client_wrapper._max_retries == 0


def test_google_chat_uses_bounded_transient_retries() -> None:
    model = gemini.build_pydantic_model(
        "gemini-recorded",
        api_key="recorded-test-key",
        base_url="https://example.invalid",
    )
    client = cast(Any, model).provider.client
    retry_options = client._api_client._http_options.retry_options

    assert retry_options.attempts == 3
    assert retry_options.initial_delay == 0.25
    assert retry_options.max_delay == 2.0
    assert retry_options.http_status_codes == [408, 429, 500, 502, 503, 504]


@pytest.mark.asyncio
async def test_google_chat_retries_a_transient_failure_before_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = 0

    async def capture(_request: Request) -> Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return Response(
                503,
                json={"error": {"code": 503, "message": "temporary", "status": "UNAVAILABLE"}},
            )
        return Response(
            200,
            json={
                "candidates": [
                    {
                        "content": {"role": "model", "parts": [{"text": "Recovered."}]},
                        "finishReason": "STOP",
                    }
                ],
                "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1},
                "modelVersion": "gemini-recorded",
            },
        )

    async with AsyncClient(transport=MockTransport(capture)) as http_client:

        def captured_provider(**kwargs: Any) -> GoogleProvider:
            configured = kwargs["retry_options"]
            assert configured.attempts == 3
            assert 503 in configured.http_status_codes
            kwargs["http_client"] = http_client
            kwargs["retry_options"] = HttpRetryOptions(
                attempts=configured.attempts,
                initial_delay=0.001,
                max_delay=0.001,
                jitter=0.001,
                http_status_codes=configured.http_status_codes,
            )
            return GoogleProvider(**kwargs)

        monkeypatch.setattr("pydantic_ai.providers.google.GoogleProvider", captured_provider)
        model = gemini.build_pydantic_model(
            "gemini-recorded",
            api_key="recorded-test-key",
            base_url="https://example.invalid",
        )
        result = await Agent(model).run("Answer once.")

    assert result.output == "Recovered."
    assert attempts == 2


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
@pytest.mark.parametrize(
    "metadata",
    ({"group_selector": True}, {"group_call": True}),
    ids=("selector", "responder"),
)
async def test_group_compatible_transport_makes_one_wire_attempt(
    metadata: dict[str, bool],
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
        metadata=metadata,
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
async def test_group_anthropic_transport_makes_one_wire_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = 0

    async def capture(_request: Request) -> Response:
        nonlocal attempts
        attempts += 1
        return Response(
            503,
            json={"type": "error", "error": {"type": "api_error", "message": "temporary"}},
        )

    async with AsyncClient(transport=MockTransport(capture)) as http_client:
        client = AsyncAnthropic(
            api_key="recorded-test-key",
            base_url="https://example.invalid",
            http_client=http_client,
            max_retries=0,
        )

        def no_retry_client(**kwargs: Any) -> AsyncAnthropic:
            assert kwargs["max_retries"] == 0
            return client

        monkeypatch.setattr("anthropic.AsyncAnthropic", no_retry_client)
        model = anthropic.build_pydantic_model(
            "claude-recorded",
            api_key="recorded-test-key",
            base_url="https://example.invalid",
            disable_retries=True,
        )
        assert isinstance(model, AnthropicModel)
        with pytest.raises(ModelHTTPError, match="503"):
            await Agent(model).run("Answer once.")

    assert attempts == 1


@pytest.mark.asyncio
async def test_group_google_transport_makes_one_wire_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = 0

    async def capture(_request: Request) -> Response:
        nonlocal attempts
        attempts += 1
        return Response(
            503,
            json={"error": {"code": 503, "message": "temporary", "status": "UNAVAILABLE"}},
        )

    async with AsyncClient(transport=MockTransport(capture)) as http_client:
        provider = GoogleProvider(
            api_key="recorded-test-key",
            base_url="https://example.invalid",
            http_client=http_client,
            retry_options=HttpRetryOptions(attempts=1),
        )

        def no_retry_provider(**kwargs: Any) -> GoogleProvider:
            assert kwargs["retry_options"].attempts == 1
            return provider

        monkeypatch.setattr("pydantic_ai.providers.google.GoogleProvider", no_retry_provider)
        model = gemini.build_pydantic_model(
            "gemini-recorded",
            api_key="recorded-test-key",
            base_url="https://example.invalid",
            disable_retries=True,
        )
        assert isinstance(model, GoogleModel)
        with pytest.raises(ModelHTTPError, match="503"):
            await Agent(model).run("Answer once.")

    assert attempts == 1


@pytest.mark.asyncio
async def test_group_cohere_transport_makes_one_wire_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = 0

    async def capture(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(503, json={"message": "temporary"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(capture)) as http_client:
        client = AsyncClientV2(
            api_key="recorded-test-key",
            base_url="https://example.invalid",
            httpx_client=http_client,
            max_retries=0,
        )

        def no_retry_client(**kwargs: Any) -> AsyncClientV2:
            assert kwargs["max_retries"] == 0
            return client

        monkeypatch.setattr("cohere.AsyncClientV2", no_retry_client)
        model = cohere.build_pydantic_model(
            "command-recorded",
            api_key="recorded-test-key",
            base_url="https://example.invalid",
            disable_retries=True,
        )
        assert isinstance(model, CohereModel)
        with pytest.raises(ModelHTTPError, match="503"):
            await Agent(model).run("Answer once.")

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
    assert seen == {
        "model_name": "meta/test-chat",
        "api_key": "nvapi-recorded",
        "disable_retries": False,
    }
