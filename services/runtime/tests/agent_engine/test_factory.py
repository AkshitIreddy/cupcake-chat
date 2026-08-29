from __future__ import annotations

from typing import Any

import pytest

from cupcake_runtime.agent_engine.factory import PydanticModelFactory
from cupcake_runtime.providers.base import ProviderConfig
from cupcake_runtime.providers.catalog import ModelCatalog
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
