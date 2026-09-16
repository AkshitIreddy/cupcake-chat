from __future__ import annotations

from typing import Any

import pytest

from cupcake_runtime.agent_engine import CupcakeAgentEngine
from cupcake_runtime.application import RuntimeCommandError, RuntimeService
from cupcake_runtime.domain.models import Setting
from cupcake_runtime.providers.base import ProviderConfig
from cupcake_runtime.providers.onboarding import (
    DiscoveredProviderModel,
    ModelDiscoveryState,
    ProviderOnboardingDiagnostic,
    ProviderOnboardingExecution,
    ProviderOnboardingResult,
    ProviderTestState,
)
from cupcake_runtime.providers.types import (
    CanonicalMessage,
    ModelCapabilities,
    ModelDescriptor,
    ModelRequest,
    PrivacyRoute,
    ReasoningEffort,
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
        assert (
            runtime.providers.adapter("openai:gpt-6-astra", client=object()).config.api_key is None
        )
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
            runtime.providers.adapter("openai:gpt-6-astra", client=object()).config.api_key
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
            runtime.providers.adapter("openai:gpt-6-astra", client=object()).config.api_key
            == SECRET_CANARY
        )
        assert SECRET_CANARY not in repr(result)
    finally:
        runtime.close()


def test_trusted_nim_hydration_rebuilds_verified_selected_model_without_discovery(
    tmp_path: Any,
) -> None:
    runtime = RuntimeService(tmp_path, master_key=b"k" * 32, require_sqlcipher=False)
    fixed = FixedOnboardingService(
        ProviderOnboardingExecution(onboarding_result(ProviderTestState.READY))
    )
    runtime.provider_onboarding = fixed  # type: ignore[assignment]
    model = "nvidia/nemotron-3-super-120b-a12b"
    try:
        result, _ = runtime.handle(
            "providers.configure",
            {
                "provider": "nvidia-nim",
                "credentialLease": SECRET_CANARY,
                "trustedHydration": True,
                "modelId": model,
            },
        )
        descriptor_id = f"nvidia-nim:{model}"
        assert result["models"][0]["id"] == descriptor_id
        assert runtime.providers.catalog.get(descriptor_id).context_window == 1_000_000
        assert (
            runtime.providers.adapter(descriptor_id, client=object()).config.api_key
            == SECRET_CANARY
        )
        assert fixed.seen == []
    finally:
        runtime.close()


def test_trusted_nim_hydration_preserves_exact_account_discovered_model(
    tmp_path: Any,
) -> None:
    runtime = RuntimeService(tmp_path, master_key=b"k" * 32, require_sqlcipher=False)
    model = "vendor/account-discovered-chat"
    descriptor = ModelDescriptor(
        id=f"nvidia-nim:{model}",
        provider="nvidia-nim",
        model=model,
        display_name=model,
        family=f"nvidia-nim:{model}",
        context_window=8_192,
        max_output_tokens=1_024,
        capabilities=ModelCapabilities(),
        privacy_route=PrivacyRoute.CLOUD,
        metadata={
            "chat_compatibility": "unknown",
            "verification_state": "account_discoverable",
            "requires_compatibility_confirmation": True,
        },
    )
    runtime.providers.catalog.register(descriptor)
    try:
        result, _ = runtime.handle(
            "providers.configure",
            {
                "provider": "nvidia-nim",
                "credentialLease": SECRET_CANARY,
                "trustedHydration": True,
                "modelId": model,
            },
        )

        assert result["models"][0]["id"] == descriptor.id
        assert result["models"][0]["metadata"]["verification_state"] == "account_discoverable"
        assert runtime.providers.catalog.get(descriptor.id) is descriptor
        assert runtime.providers.adapter(descriptor.id, client=object()).config.api_key == (
            SECRET_CANARY
        )
    finally:
        runtime.close()


def test_trusted_nim_hydration_restores_bounded_cached_account_catalog(tmp_path: Any) -> None:
    runtime = RuntimeService(tmp_path, master_key=b"k" * 32, require_sqlcipher=False)
    try:
        result, _ = runtime.handle(
            "providers.configure",
            {
                "provider": "nvidia-nim",
                "credentialLease": SECRET_CANARY,
                "trustedHydration": True,
                "catalogModels": [
                    "nvidia/nemotron-3.5-lightning",
                    "vendor/account-discovered-chat",
                    "nvidia/nemotron-3-nano-30b-a3b",
                ],
            },
        )

        assert result["hydrated"] is True
        assert {model["model"] for model in result["models"]} == {
            "nvidia/nemotron-3.5-lightning",
            "vendor/account-discovered-chat",
        }
        assert "nvidia-nim:nvidia/nemotron-3-nano-30b-a3b" not in {
            model.id for model in runtime.providers.catalog.list()
        }
        unknown = runtime.providers.catalog.get("nvidia-nim:vendor/account-discovered-chat")
        assert unknown.metadata["verification_state"] == "account_discoverable"
        assert unknown.metadata["requires_compatibility_confirmation"] is True
    finally:
        runtime.close()


def test_trusted_named_hydration_rejects_non_free_route(tmp_path: Any) -> None:
    runtime = RuntimeService(tmp_path, master_key=b"k" * 32, require_sqlcipher=False)
    try:
        with pytest.raises(RuntimeCommandError) as denied:
            runtime.handle(
                "providers.configure",
                {
                    "provider": "openai-compatible",
                    "credentialLease": SECRET_CANARY,
                    "trustedHydration": True,
                    "endpointId": "openrouter",
                    "modelId": "nvidia/nemotron-3.5-lightning",
                    "displayName": "Paid route",
                    "baseUrl": "https://openrouter.ai/api/v1",
                },
            )

        assert denied.value.code == "PAID_MODEL_DENIED"
        assert "openai-compatible:openrouter/nvidia/nemotron-3.5-lightning" not in {
            descriptor.id for descriptor in runtime.providers.catalog.list()
        }
    finally:
        runtime.close()


def test_trusted_groq_gpt_oss_hydration_restores_reasoning_contract(tmp_path: Any) -> None:
    runtime = RuntimeService(tmp_path, master_key=b"k" * 32, require_sqlcipher=False)
    try:
        result, _ = runtime.handle(
            "providers.configure",
            {
                "provider": "openai-compatible",
                "credentialLease": SECRET_CANARY,
                "trustedHydration": True,
                "endpointId": "groq",
                "modelId": "openai/gpt-oss-20b",
                "displayName": "Groq · GPT OSS 20B",
                "baseUrl": "https://api.groq.com/openai/v1",
            },
        )

        descriptor = runtime.providers.catalog.get("openai-compatible:groq/openai/gpt-oss-20b")
        assert result["hydrated"] is True
        assert descriptor.capabilities.reasoning is True
        assert descriptor.reasoning_efforts == (
            ReasoningEffort.LOW,
            ReasoningEffort.MEDIUM,
            ReasoningEffort.HIGH,
        )
        assert descriptor.default_reasoning_effort is ReasoningEffort.LOW
        assert descriptor.context_window == 131_072
        assert descriptor.max_output_tokens == 65_536
    finally:
        runtime.close()


@pytest.mark.parametrize(
    ("model_id", "context_window", "max_output_tokens", "tools", "reasoning"),
    (
        ("allam-2-7b", 4_096, 2_048, False, False),
        ("groq/compound", 131_072, 8_192, False, False),
        ("groq/compound-mini", 131_072, 8_192, False, False),
        ("qwen/qwen3.8-27b", 131_042, 16_384, True, True),
    ),
)
def test_trusted_groq_hydration_restores_route_specific_contract(
    tmp_path: Any,
    model_id: str,
    context_window: int,
    max_output_tokens: int,
    tools: bool,
    reasoning: bool,
) -> None:
    runtime = RuntimeService(tmp_path, master_key=b"k" * 32, require_sqlcipher=False)
    try:
        runtime.handle(
            "providers.configure",
            {
                "provider": "openai-compatible",
                "credentialLease": SECRET_CANARY,
                "trustedHydration": True,
                "endpointId": "groq",
                "modelId": model_id,
                "displayName": f"Groq · {model_id}",
                "baseUrl": "https://api.groq.com/openai/v1",
            },
        )

        descriptor = runtime.providers.catalog.get(f"openai-compatible:groq/{model_id}")
        assert descriptor.context_window == context_window
        assert descriptor.max_output_tokens == max_output_tokens
        assert descriptor.capabilities.tools is tools
        assert descriptor.capabilities.reasoning is reasoning
    finally:
        runtime.close()


def test_allam_default_agent_request_reserves_input_context(tmp_path: Any) -> None:
    runtime = RuntimeService(tmp_path, master_key=b"k" * 32, require_sqlcipher=False)
    try:
        runtime.handle(
            "providers.configure",
            {
                "provider": "openai-compatible",
                "credentialLease": SECRET_CANARY,
                "trustedHydration": True,
                "endpointId": "groq",
                "modelId": "allam-2-7b",
                "displayName": "Groq · ALLaM 2 7B",
                "baseUrl": "https://api.groq.com/openai/v1",
            },
        )
        model_id = "openai-compatible:groq/allam-2-7b"

        plan = CupcakeAgentEngine(runtime.providers).prepare(
            ModelRequest(model_id, (CanonicalMessage("user", "Explain this in Arabic."),))
        )

        assert plan.max_output_tokens == 2_048
        assert plan.estimated_context_tokens < 2_048
        # Simulate a previously enabled tool. Unsupported model routes must omit
        # caller-provided schemas before looking up or validating those tools.
        runtime.repository.set_setting(Setting(key="tools.enabled", value=["missing.tool"]))
        created, _ = runtime.handle("conversations.create", {"title": "ALLaM tools"})
        prepared = runtime._prepare_chat(
            created["conversation"]["id"],
            created["branch"]["id"],
            run_id="run-allam-tools",
            model_id=model_id,
            fallback_model_id=None,
            params={},
        )
        assert prepared.request.tools == ()
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


@pytest.mark.parametrize(
    ("provider", "model_id", "account_id", "expected_url"),
    (
        ("groq", "openai/gpt-oss-20b", None, "https://api.groq.com/openai/v1"),
        (
            "openrouter",
            "nvidia/nemotron-3.5-lightning:free",
            None,
            "https://openrouter.ai/api/v1",
        ),
        (
            "cloudflare",
            "@cf/meta/llama-3.1-8b-instruct-fp8",
            "a" * 32,
            f"https://api.cloudflare.com/client/v4/accounts/{'a' * 32}/ai/v1",
        ),
    ),
)
def test_named_compatible_connect_registers_isolated_free_route(
    tmp_path: Any,
    provider: str,
    model_id: str,
    account_id: str | None,
    expected_url: str,
) -> None:
    runtime = RuntimeService(tmp_path, master_key=b"k" * 32, require_sqlcipher=False)
    result = ProviderOnboardingResult(
        provider=provider,
        state=ProviderTestState.READY,
        discovery=ModelDiscoveryState.SUPPORTED,
        models=(
            DiscoveredProviderModel(
                id=model_id,
                model=model_id,
                display_name="Free model",
                capabilities=("streaming",),
                compatibility_verified=True,
            ),
        ),
        tested_at_ms=123,
        latency_ms=4,
    )
    fixed = FixedOnboardingService(ProviderOnboardingExecution(result))
    runtime.provider_onboarding = fixed  # type: ignore[assignment]
    try:
        runtime.handle(
            "providers.configure",
            {
                "provider": provider,
                "credentialLease": SECRET_CANARY,
                "accountId": account_id,
                "modelId": model_id,
                "validateOnly": False,
            },
        )
        descriptor_id = f"openai-compatible:{provider}/{model_id}"
        descriptor = runtime.providers.catalog.get(descriptor_id)
        adapter = runtime.providers.adapter(descriptor_id, client=object())
        assert descriptor.metadata["provider_preset"] == provider
        assert descriptor.metadata["cost_policy"] == (
            "account-discovered" if provider == "groq" else "free-tier-eligible"
        )
        assert descriptor.privacy_route.value == "cloud"
        assert adapter.config.base_url == expected_url
        assert adapter.config.api_key == SECRET_CANARY
        assert fixed.seen[0][1].account_id == account_id
        if provider == "groq":
            assert descriptor.capabilities.reasoning is True
            assert descriptor.reasoning_efforts == (
                ReasoningEffort.LOW,
                ReasoningEffort.MEDIUM,
                ReasoningEffort.HIGH,
            )
            assert descriptor.default_reasoning_effort is ReasoningEffort.LOW
    finally:
        runtime.close()


def test_named_compatible_refresh_replaces_retired_selected_route(tmp_path: Any) -> None:
    runtime = RuntimeService(tmp_path, master_key=b"k" * 32, require_sqlcipher=False)
    try:
        runtime.handle(
            "providers.configure",
            {
                "provider": "openai-compatible",
                "credentialLease": SECRET_CANARY,
                "trustedHydration": True,
                "endpointId": "groq",
                "modelId": "qwen/qwen3.6-27b",
                "displayName": "Groq · retired Qwen",
                "baseUrl": "https://api.groq.com/openai/v1",
            },
        )
        result = ProviderOnboardingResult(
            provider="groq",
            state=ProviderTestState.READY,
            discovery=ModelDiscoveryState.SUPPORTED,
            models=(
                DiscoveredProviderModel(
                    id="openai/gpt-oss-20b",
                    model="openai/gpt-oss-20b",
                    display_name="GPT OSS 20B",
                    capabilities=("streaming",),
                    compatibility_verified=True,
                ),
                DiscoveredProviderModel(
                    id="groq/compound",
                    model="groq/compound",
                    display_name="Compound",
                    capabilities=("streaming",),
                    compatibility_verified=True,
                ),
            ),
            tested_at_ms=123,
            latency_ms=4,
        )
        runtime.provider_onboarding = FixedOnboardingService(  # type: ignore[assignment]
            ProviderOnboardingExecution(result)
        )

        runtime.handle(
            "providers.configure",
            {
                "provider": "groq",
                "credentialLease": SECRET_CANARY,
                "modelId": "qwen/qwen3.6-27b",
                "allowSelectedReplacement": True,
            },
        )

        ids = {model.id for model in runtime.providers.catalog.list()}
        assert "openai-compatible:groq/qwen/qwen3.6-27b" not in ids
        assert "openai-compatible:groq/openai/gpt-oss-20b" in ids
        assert "openai-compatible:groq/groq/compound" in ids
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
        assert runtime.providers.adapter("openai:gpt-6-astra", client=object()).config is prior
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
        assert (
            runtime.providers.adapter("google:gemini-3.8-flash", client=object()).config.api_key
            is None
        )
        assert SECRET_CANARY not in repr(result)
    finally:
        runtime.close()
