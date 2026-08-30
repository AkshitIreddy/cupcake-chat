from __future__ import annotations

from typing import Any

import pytest

from cupcake_runtime.application import RuntimeService
from cupcake_runtime.providers.base import ProviderConfig
from cupcake_runtime.providers.onboarding import (
    ModelDiscoveryState,
    ProviderOnboardingDiagnostic,
    ProviderOnboardingExecution,
    ProviderOnboardingResult,
    ProviderTestState,
)

SECRET_CANARY = "sk-application-onboarding-secret-canary-58302"


class FixedOnboardingService:
    def __init__(self, execution: ProviderOnboardingExecution) -> None:
        self.execution = execution
        self.seen: list[tuple[str, ProviderConfig]] = []

    async def test_connection_with_evidence(
        self,
        provider: str,
        config: ProviderConfig,
        *,
        force_catalog_refresh: bool = False,
    ) -> ProviderOnboardingExecution:
        del force_catalog_refresh
        self.seen.append((provider, config))
        return self.execution


def onboarding_result(
    state: ProviderTestState,
    *,
    provider: str = "openai",
    diagnostic: ProviderOnboardingDiagnostic | None = None,
) -> ProviderOnboardingResult:
    return ProviderOnboardingResult(
        provider=provider,
        state=state,
        discovery=(
            ModelDiscoveryState.SUPPORTED
            if state is ProviderTestState.READY
            else ModelDiscoveryState.FAILED
        ),
        models=(),
        tested_at_ms=123,
        latency_ms=4,
        diagnostic=diagnostic,
    )


def test_validate_only_returns_typed_result_without_committing_config(tmp_path: Any) -> None:
    runtime = RuntimeService(tmp_path, master_key=b"k" * 32, require_sqlcipher=False)
    fixed = FixedOnboardingService(
        ProviderOnboardingExecution(onboarding_result(ProviderTestState.READY))
    )
    runtime.provider_onboarding = fixed  # type: ignore[assignment]
    try:
        result, _ = runtime.handle(
            "providers.configure",
            {
                "provider": "openai",
                "credentialLease": SECRET_CANARY,
                "validateOnly": True,
            },
        )

        assert result["state"] == "ready"
        assert result["discovery"] == "supported"
        assert runtime.providers.adapter(
            "openai:gpt-5.6-sol", client=object()
        ).config.api_key is None
        assert fixed.seen[0][1].api_key == SECRET_CANARY
        assert SECRET_CANARY not in repr(result)
    finally:
        runtime.close()


def test_successful_connect_commits_only_after_test(tmp_path: Any) -> None:
    runtime = RuntimeService(tmp_path, master_key=b"k" * 32, require_sqlcipher=False)
    fixed = FixedOnboardingService(
        ProviderOnboardingExecution(onboarding_result(ProviderTestState.READY))
    )
    runtime.provider_onboarding = fixed  # type: ignore[assignment]
    try:
        result, _ = runtime.handle(
            "providers.configure",
            {
                "provider": "openai",
                "credentialLease": SECRET_CANARY,
                "validateOnly": False,
            },
        )

        assert result["state"] == "ready"
        assert (
            runtime.providers.adapter("openai:gpt-5.6-sol", client=object()).config.api_key
            == SECRET_CANARY
        )
        assert SECRET_CANARY not in repr(result)
    finally:
        runtime.close()


def test_trusted_hydration_restores_an_already_validated_key_without_discovery(
    tmp_path: Any,
) -> None:
    runtime = RuntimeService(tmp_path, master_key=b"k" * 32, require_sqlcipher=False)
    fixed = FixedOnboardingService(
        ProviderOnboardingExecution(onboarding_result(ProviderTestState.READY))
    )
    runtime.provider_onboarding = fixed  # type: ignore[assignment]
    try:
        result, _ = runtime.handle(
            "providers.configure",
            {
                "provider": "openai",
                "credentialLease": SECRET_CANARY,
                "trustedHydration": True,
            },
        )

        assert result["state"] == "ready"
        assert result["hydrated"] is True
        assert fixed.seen == []
        assert (
            runtime.providers.adapter("openai:gpt-5.6-sol", client=object()).config.api_key
            == SECRET_CANARY
        )
        assert SECRET_CANARY not in repr(result)
    finally:
        runtime.close()


def test_openai_compatible_connect_registers_the_tested_endpoint_model(tmp_path: Any) -> None:
    runtime = RuntimeService(tmp_path, master_key=b"k" * 32, require_sqlcipher=False)
    fixed = FixedOnboardingService(
        ProviderOnboardingExecution(
            onboarding_result(ProviderTestState.READY, provider="openai-compatible")
        )
    )
    runtime.provider_onboarding = fixed  # type: ignore[assignment]
    try:
        result, _ = runtime.handle(
            "providers.configure",
            {
                "provider": "openai-compatible",
                "credentialLease": SECRET_CANARY,
                "baseUrl": "https://inference.example.test/v1",
                "endpointId": "example-endpoint",
                "modelId": "example-model",
                "displayName": "Example model",
                "validateOnly": False,
            },
        )

        descriptor = runtime.providers.catalog.get(
            "openai-compatible:example-endpoint/example-model"
        )
        assert result["state"] == "ready"
        assert descriptor.display_name == "Example model"
        assert (
            runtime.providers.adapter(descriptor.id, client=object()).config.api_key
            == SECRET_CANARY
        )
        assert SECRET_CANARY not in repr(result)
    finally:
        runtime.close()


@pytest.mark.parametrize("state", (ProviderTestState.FAILED, ProviderTestState.CANCELLED))
def test_failed_or_cancelled_connect_does_not_mutate_config_or_catalog(
    tmp_path: Any, state: ProviderTestState
) -> None:
    runtime = RuntimeService(tmp_path, master_key=b"k" * 32, require_sqlcipher=False)
    prior = ProviderConfig(api_key="prior-valid-key")
    runtime.providers.configure("openai", prior)
    catalog_before = runtime.providers.catalog.list(include_deprecated=True)
    fixed = FixedOnboardingService(
        ProviderOnboardingExecution(
            onboarding_result(
                state,
                diagnostic=ProviderOnboardingDiagnostic(
                    "cancelled" if state is ProviderTestState.CANCELLED else "network_error",
                    "The provider test did not complete.",
                    state is ProviderTestState.FAILED,
                ),
            )
        )
    )
    runtime.provider_onboarding = fixed  # type: ignore[assignment]
    try:
        result, _ = runtime.handle(
            "providers.configure",
            {
                "provider": "openai",
                "credentialLease": SECRET_CANARY,
                "validateOnly": False,
            },
        )

        assert result["state"] == state.value
        assert runtime.providers.adapter("openai:gpt-5.6-sol", client=object()).config is prior
        assert runtime.providers.catalog.list(include_deprecated=True) == catalog_before
        assert SECRET_CANARY not in repr(result)
    finally:
        runtime.close()


def test_provider_disconnect_handler_clears_registry_configuration(tmp_path: Any) -> None:
    runtime = RuntimeService(tmp_path, master_key=b"k" * 32, require_sqlcipher=False)
    runtime.providers.configure("google", ProviderConfig(api_key=SECRET_CANARY))
    try:
        result, _ = runtime.handle("providers.disconnect", {"provider": "gemini"})

        assert result == {
            "provider": "google",
            "configured": False,
            "disconnected": True,
        }
        assert runtime.providers.adapter(
            "google:gemini-3.5-flash", client=object()
        ).config.api_key is None
        assert SECRET_CANARY not in repr(result)
    finally:
        runtime.close()
