"""Adapter construction from explicit model and credential selections."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import suppress
from dataclasses import dataclass, field
from dataclasses import replace as dataclass_replace
from typing import Any

from .anthropic import AnthropicAdapter
from .base import ProviderAdapter, ProviderConfig
from .catalog import ModelCatalog, openai_compatible_descriptor
from .cohere import CohereAdapter
from .gemini import GeminiAdapter
from .mistral import MistralAdapter
from .mock import MOCK_DESCRIPTOR, MockProviderAdapter
from .nvidia_nim import (
    NVIDIA_NIM_BASE_URL,
    NVIDIA_NIM_PROVIDER,
    NvidiaNimAdapter,
    NvidiaNimCatalogDiscovery,
    NvidiaNimCatalogResult,
)
from .openai import OpenAIResponsesAdapter
from .openai_compatible import GenericOpenAICompatibleAdapter
from .types import ModelCapabilities, ModelDescriptor, ModelRequest, ReasoningEffort
from .xai import XAIAdapter

AdapterFactory = Callable[[ModelDescriptor, ProviderConfig], ProviderAdapter]


DEFAULT_FACTORIES: dict[str, type[ProviderAdapter]] = {
    "openai": OpenAIResponsesAdapter,
    "anthropic": AnthropicAdapter,
    "google": GeminiAdapter,
    "xai": XAIAdapter,
    "mistral": MistralAdapter,
    "cohere": CohereAdapter,
    NVIDIA_NIM_PROVIDER: NvidiaNimAdapter,
    "openai-compatible": GenericOpenAICompatibleAdapter,
}


@dataclass(slots=True)
class ProviderRegistry:
    catalog: ModelCatalog = field(default_factory=ModelCatalog.builtins)
    _configs: dict[str, ProviderConfig] = field(default_factory=dict[str, ProviderConfig])
    _model_configs: dict[str, ProviderConfig] = field(default_factory=dict[str, ProviderConfig])
    _factories: dict[str, type[ProviderAdapter]] = field(
        default_factory=lambda: dict(DEFAULT_FACTORIES)
    )
    _nvidia_nim_catalog: NvidiaNimCatalogDiscovery = field(
        default_factory=NvidiaNimCatalogDiscovery
    )

    def __post_init__(self) -> None:
        with suppress(ValueError):
            self.catalog.register(MOCK_DESCRIPTOR)

    def configure(self, provider: str, config: ProviderConfig) -> None:
        if provider == NVIDIA_NIM_PROVIDER:
            config = dataclass_replace(config, base_url=NVIDIA_NIM_BASE_URL)
            if self._configs.get(provider) != config:
                self._nvidia_nim_catalog.invalidate()
        self._configs[provider] = config

    @property
    def nvidia_nim_discovery(self) -> NvidiaNimCatalogDiscovery:
        """Share the bounded discovery cache with provider onboarding."""

        return self._nvidia_nim_catalog

    def configure_tested(
        self,
        provider: str,
        config: ProviderConfig,
        *,
        nvidia_nim_catalog: NvidiaNimCatalogResult | None = None,
    ) -> None:
        """Commit a configuration only after onboarding accepted it.

        NVIDIA's already-tested bounded catalog is committed directly. This
        avoids both a time-of-check/time-of-use discrepancy and a duplicate
        remote discovery request.
        """

        if provider != NVIDIA_NIM_PROVIDER:
            self.configure(provider, config)
            return
        if nvidia_nim_catalog is None:
            raise ValueError("tested NVIDIA NIM catalog evidence is required")
        self._configs[provider] = dataclass_replace(config, base_url=NVIDIA_NIM_BASE_URL)
        self._reconcile_nvidia_nim_catalog(nvidia_nim_catalog)

    def disconnect(self, provider: str) -> bool:
        """Drop one credential config and its dynamic model state."""

        normalized_provider = "google" if provider == "gemini" else provider
        removed = self._configs.pop(normalized_provider, None) is not None
        if normalized_provider == NVIDIA_NIM_PROVIDER:
            self._nvidia_nim_catalog.invalidate()
            for descriptor in self.catalog.list(
                provider=NVIDIA_NIM_PROVIDER, include_deprecated=True
            ):
                removed = self.catalog.unregister(descriptor.id) or removed
                removed = self._model_configs.pop(descriptor.id, None) is not None or removed
        elif normalized_provider == "openai-compatible":
            for descriptor in self.catalog.list(
                provider="openai-compatible", include_deprecated=True
            ):
                # Runtime-owned local routes are not remote provider configs.
                if isinstance(descriptor.metadata.get("runtime_kind"), str):
                    continue
                removed = self.catalog.unregister(descriptor.id) or removed
                removed = self._model_configs.pop(descriptor.id, None) is not None or removed
        else:
            for descriptor in self.catalog.list(
                provider=normalized_provider, include_deprecated=True
            ):
                removed = self._model_configs.pop(descriptor.id, None) is not None or removed
        return removed

    def disconnect_openai_compatible_endpoint(self, endpoint_id: str) -> bool:
        """Drop one named compatible endpoint without disturbing sibling routes."""

        prefix = f"openai-compatible:{endpoint_id}/"
        removed = False
        for descriptor in self.catalog.list(provider="openai-compatible", include_deprecated=True):
            if not descriptor.id.startswith(prefix):
                continue
            if isinstance(descriptor.metadata.get("runtime_kind"), str):
                continue
            removed = self.catalog.unregister(descriptor.id) or removed
            removed = self._model_configs.pop(descriptor.id, None) is not None or removed
        return removed

    async def refresh_nvidia_nim_models(
        self, *, client: Any = None, force: bool = False
    ) -> NvidiaNimCatalogResult:
        """Refresh NVIDIA's hosted catalog and register safe text candidates.

        Non-chat models are filtered.  Catalog entries without an explicit
        capability declaration remain visible but carry an unverified marker;
        they are never silently treated as tool-, reasoning-, or image-capable.
        """

        config = self._configs.get(NVIDIA_NIM_PROVIDER, ProviderConfig())
        result = await self._nvidia_nim_catalog.discover(
            config,
            client=client,
            force=force,
        )
        self._reconcile_nvidia_nim_catalog(result)
        return result

    def _reconcile_nvidia_nim_catalog(self, result: NvidiaNimCatalogResult) -> None:
        discovered_ids = {model.id for model in result.models}
        for existing in self.catalog.list(provider=NVIDIA_NIM_PROVIDER, include_deprecated=True):
            if existing.id not in discovered_ids:
                self.catalog.register(dataclass_replace(existing, deprecated=True), replace=True)
        for descriptor in result.models:
            self.catalog.register(descriptor, replace=True)

    def configure_model(self, model_id: str, config: ProviderConfig) -> None:
        """Configure one model without leaking settings to sibling endpoints."""

        self.catalog.get(model_id)
        self._model_configs[model_id] = config

    def compatible_runtime_route(self, selected_model_id: str) -> dict[str, str] | None:
        """Return a broker-only route for an exact runtime-managed model.

        Generic compatible endpoints deliberately do not qualify.  A route is
        eligible only when the runtime itself registered the exact model with a
        recognized local-runtime marker and a matching privacy boundary.  The
        broker independently validates the returned origin before bypassing the
        cloud credential vault.
        """

        try:
            descriptor = self.catalog.get(selected_model_id)
        except KeyError:
            return None
        if descriptor.provider != "openai-compatible":
            return None
        config = self._model_configs.get(descriptor.id)
        if config is None or not config.base_url:
            return None
        runtime_kind = descriptor.metadata.get("runtime_kind")
        if not isinstance(runtime_kind, str):
            return None
        expected_privacy = {"cupcake_llama_cpp": "local"}.get(runtime_kind)
        if expected_privacy is None or descriptor.privacy_route.value != expected_privacy:
            return None
        return {
            "modelId": descriptor.id,
            "baseUrl": config.base_url,
            "runtimeKind": runtime_kind,
            "privacyRoute": descriptor.privacy_route.value,
        }

    def register_openai_compatible_endpoint(
        self,
        endpoint_id: str,
        *,
        model: str,
        display_name: str,
        base_url: str,
        api_key: str | None = None,
        context_window: int = 32_768,
        max_output_tokens: int | None = None,
        reasoning_efforts: tuple[ReasoningEffort, ...] = (),
        capabilities: ModelCapabilities | None = None,
        headers: dict[str, str] | None = None,
        metadata: Mapping[str, Any] | None = None,
        replace: bool = False,
    ) -> ModelDescriptor:
        if not base_url.startswith(("http://", "https://")):
            raise ValueError("base_url must be an absolute HTTP(S) URL")
        descriptor = openai_compatible_descriptor(
            endpoint_id,
            model,
            display_name,
            context_window=context_window,
            max_output_tokens=max_output_tokens,
            reasoning_efforts=reasoning_efforts,
            capabilities=capabilities,
        )
        if metadata:
            descriptor = dataclass_replace(
                descriptor,
                metadata={**descriptor.metadata, **dict(metadata)},
            )
        self.catalog.register(descriptor, replace=replace)
        self._model_configs[descriptor.id] = ProviderConfig(
            api_key=api_key,
            base_url=base_url.rstrip("/"),
            headers=headers,
        )
        return descriptor

    def register_provider(self, provider: str, factory: type[ProviderAdapter]) -> None:
        self._factories[provider] = factory

    def adapter(self, selected_model_id: str, *, client: Any = None) -> ProviderAdapter:
        descriptor = self.catalog.select(selected_model_id)
        if descriptor.provider == "mock":
            return MockProviderAdapter(descriptor)
        try:
            factory = self._factories[descriptor.provider]
        except KeyError as exc:
            raise KeyError(f"no adapter registered for {descriptor.provider!r}") from exc
        config = self._model_configs.get(
            descriptor.id, self._configs.get(descriptor.provider, ProviderConfig())
        )
        return factory(descriptor, config, client=client)

    def privacy_crossing(self, current_model_id: str, next_model_id: str) -> bool:
        current = self.catalog.get(current_model_id)
        next_model = self.catalog.get(next_model_id)
        return current.privacy_route != next_model.privacy_route

    def prepare_request(self, request: ModelRequest) -> tuple[ProviderAdapter, ModelRequest]:
        """Resolve only the user-selected model; never apply fallback/routing."""
        adapter = self.adapter(request.model_id)
        adapter.validate_request(request)
        sanitized = dataclass_replace(request, continuity=adapter.usable_continuity(request))
        return adapter, sanitized
