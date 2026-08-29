from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from cupcake_runtime.providers.base import ProviderConfig, ProviderError
from cupcake_runtime.providers.nvidia_nim import (
    MAX_MODEL_ID_LENGTH,
    NVIDIA_NIM_BASE_URL,
    NvidiaNimAdapter,
    NvidiaNimCatalogDiscovery,
)
from cupcake_runtime.providers.registry import ProviderRegistry
from cupcake_runtime.providers.types import CanonicalMessage, ModelRequest, ReasoningEffort


class FakeModels:
    def __init__(self, data: list[dict[str, Any]]) -> None:
        self.data = data
        self.calls = 0

    async def list(self) -> Any:
        self.calls += 1
        return SimpleNamespace(data=self.data)


def fake_client(data: list[dict[str, Any]]) -> Any:
    return SimpleNamespace(models=FakeModels(data))


def test_discovery_filters_non_chat_and_does_not_invent_unknown_capabilities() -> None:
    client = fake_client(
        [
            {
                "id": "meta/chat-model",
                "capabilities": ["chat", "tools", "reasoning", "structured-output"],
                "context_window": 131_072,
                "max_output_tokens": 8_192,
            },
            {"id": "nvidia/nv-embed", "task": "embedding"},
            {"id": "vendor/new-model"},
            {"id": "bad model with spaces", "capabilities": ["chat"]},
            {"id": "x" * (MAX_MODEL_ID_LENGTH + 1), "capabilities": ["chat"]},
        ]
    )
    discovery = NvidiaNimCatalogDiscovery()
    result = asyncio.run(
        discovery.discover(ProviderConfig(api_key="nvapi-recorded"), client=client)
    )

    assert [model.model for model in result.models] == ["meta/chat-model", "vendor/new-model"]
    assert result.filtered_non_chat == 1
    assert result.unknown_chat_compatibility == 1
    chat, unknown = result.models
    assert chat.capabilities.tools and chat.capabilities.reasoning
    assert chat.context_window == 131_072
    assert chat.metadata["chat_compatibility"] == "chat"
    assert unknown.metadata["chat_compatibility"] == "unknown"
    assert unknown.metadata["requires_compatibility_confirmation"] is True
    assert unknown.capabilities.tools is False
    assert unknown.capabilities.reasoning is False
    assert "unverified" in unknown.display_name


def test_discovery_cache_is_bounded_and_does_not_repeat_network_call() -> None:
    client = fake_client([{"id": "vendor/model", "capabilities": ["chat"]}])
    discovery = NvidiaNimCatalogDiscovery(ttl_seconds=60)
    config = ProviderConfig(api_key="nvapi-recorded")
    first = asyncio.run(discovery.discover(config, client=client))
    second = asyncio.run(discovery.discover(config, client=client))

    assert first.cached is False
    assert second.cached is True
    assert client.models.calls == 1


def test_oversized_or_malformed_catalog_fails_closed() -> None:
    discovery = NvidiaNimCatalogDiscovery(max_models=1)
    with pytest.raises(ProviderError, match="safety limit"):
        asyncio.run(
            discovery.discover(
                ProviderConfig(api_key="nvapi-recorded"),
                client=fake_client([{"id": "one"}, {"id": "two"}]),
            )
        )

    malformed = SimpleNamespace(models=SimpleNamespace(list=lambda: {"data": "not-a-list"}))
    with pytest.raises(ProviderError, match="invalid model catalog"):
        asyncio.run(
            NvidiaNimCatalogDiscovery().discover(
                ProviderConfig(api_key="nvapi-recorded"), client=malformed
            )
        )


def test_catalog_rate_limit_is_normalized_without_response_body() -> None:
    class CatalogRateLimit(RuntimeError):
        status_code = 429

        def __str__(self) -> str:
            return "body contains nvapi-synthetic-provider-canary-1234567890"

    async def raise_rate_limit() -> Any:
        raise CatalogRateLimit

    client = SimpleNamespace(models=SimpleNamespace(list=raise_rate_limit))
    with pytest.raises(ProviderError) as captured:
        asyncio.run(
            NvidiaNimCatalogDiscovery().discover(
                ProviderConfig(api_key="nvapi-recorded"), client=client
            )
        )

    assert captured.value.code == "rate_limit"
    assert captured.value.retryable is True
    assert "synthetic-provider-canary" not in str(captured.value)


def test_registry_registers_dynamic_models_and_forces_hosted_base_url() -> None:
    registry = ProviderRegistry()
    registry.configure(
        "nvidia-nim",
        ProviderConfig(api_key="nvapi-recorded", base_url="https://attacker.invalid/v1"),
    )
    result = asyncio.run(
        registry.refresh_nvidia_nim_models(
            client=fake_client([{"id": "meta/chat-model", "capabilities": ["chat"]}])
        )
    )
    descriptor = result.models[0]
    adapter = registry.adapter(descriptor.id, client=object())

    assert isinstance(adapter, NvidiaNimAdapter)
    assert adapter.config.base_url == NVIDIA_NIM_BASE_URL
    assert registry.catalog.select("nvidia-nim:meta/chat-model") is descriptor


def test_nim_reasoning_and_tool_payload_are_explicit_model_capabilities() -> None:
    registry = ProviderRegistry()
    registry.configure("nvidia-nim", ProviderConfig(api_key="nvapi-recorded"))
    result = asyncio.run(
        registry.refresh_nvidia_nim_models(
            client=fake_client(
                [
                    {
                        "id": "deepseek-ai/reasoning-chat",
                        "capabilities": ["chat", "tools", "reasoning"],
                    }
                ]
            )
        )
    )
    descriptor = result.models[0]
    adapter = registry.adapter(descriptor.id, client=object())
    request = ModelRequest(
        descriptor.id,
        (CanonicalMessage("user", "think carefully"),),
        reasoning_effort=ReasoningEffort.MEDIUM,
        tools=({"type": "function", "function": {"name": "lookup"}},),
    )
    payload = adapter.build_request(request)  # type: ignore[attr-defined]

    assert payload["model"] == "deepseek-ai/reasoning-chat"
    assert payload["reasoning_effort"] == "medium"
    assert payload["tools"][0]["function"]["name"] == "lookup"


def test_no_automatic_nim_model_is_present_before_catalog_discovery() -> None:
    registry = ProviderRegistry()
    assert registry.catalog.list(provider="nvidia-nim") == ()
    with pytest.raises(KeyError):
        registry.catalog.select("nvidia-nim:anything")
