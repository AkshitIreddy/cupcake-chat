from __future__ import annotations

import asyncio
from dataclasses import asdict
from types import SimpleNamespace
from typing import Any

import pytest

from cupcake_runtime.providers.base import ProviderConfig, ProviderError
from cupcake_runtime.providers.nvidia_nim import NvidiaNimCatalogDiscovery
from cupcake_runtime.providers.onboarding import (
    ModelDiscoveryState,
    OnboardingCancellation,
    ProviderOnboardingService,
    ProviderTestState,
    named_compatible_base_url,
    named_compatible_model_allowed,
    normalize_cloudflare_model_search,
    validate_remote_openai_compatible_endpoint,
)

SECRET_CANARY = "sk-provider-onboarding-secret-canary-48291"


class FakeModels:
    def __init__(self, response: Any = None, error: Exception | None = None) -> None:
        self.response = response or SimpleNamespace(
            data=[
                {"id": "vendor/chat-small", "name": "Chat Small"},
                SimpleNamespace(id="vendor/chat-large", display_name="Chat Large"),
                {"id": "bad model id"},
            ]
        )
        self.error = error
        self.calls = 0

    async def list(self) -> Any:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.response


def fake_client(response: Any = None, error: Exception | None = None) -> Any:
    return SimpleNamespace(models=FakeModels(response, error))


@pytest.mark.parametrize(
    "provider",
    ("openai", "anthropic", "google", "gemini", "xai", "mistral", "cohere"),
)
def test_direct_provider_matrix_returns_bounded_normalized_models(provider: str) -> None:
    result = asyncio.run(
        ProviderOnboardingService().test_connection(
            provider,
            ProviderConfig(api_key=SECRET_CANARY),
            client=fake_client(),
        )
    )

    assert result.provider == ("google" if provider == "gemini" else provider)
    assert result.state is ProviderTestState.READY
    assert result.discovery is ModelDiscoveryState.SUPPORTED
    assert [model.id for model in result.models] == ["vendor/chat-large", "vendor/chat-small"]
    assert all(model.capabilities == () for model in result.models)
    assert SECRET_CANARY not in repr(result)


def test_direct_discovery_bounds_scanned_records_including_invalid_entries() -> None:
    result = asyncio.run(
        ProviderOnboardingService(max_models=1).test_connection(
            "openai",
            ProviderConfig(api_key=SECRET_CANARY),
            client=fake_client(
                SimpleNamespace(data=[{"id": "invalid model id"}, {"id": "vendor/chat"}])
            ),
        )
    )

    assert result.state is ProviderTestState.FAILED
    assert result.diagnostic is not None
    assert result.diagnostic.code == "oversized_model_catalog"


def test_direct_discovery_follows_sdk_pages_with_one_global_bound() -> None:
    class Page:
        def __init__(self, ids: list[str], next_page: Page | None = None) -> None:
            self.data = [{"id": model_id} for model_id in ids]
            self._next_page = next_page

        def has_next_page(self) -> bool:
            return self._next_page is not None

        async def get_next_page(self) -> Page:
            assert self._next_page is not None
            return self._next_page

    response = Page(["vendor/one"], Page(["vendor/two"]))
    result = asyncio.run(
        ProviderOnboardingService(max_models=2).test_connection(
            "anthropic",
            ProviderConfig(api_key=SECRET_CANARY),
            client=fake_client(response),
        )
    )
    assert result.state is ProviderTestState.READY
    assert [model.id for model in result.models] == ["vendor/one", "vendor/two"]


def test_gemini_aio_model_listing_shape_is_supported() -> None:
    client = SimpleNamespace(aio=SimpleNamespace(models=FakeModels()))
    result = asyncio.run(
        ProviderOnboardingService().test_connection(
            "google", ProviderConfig(api_key=SECRET_CANARY), client=client
        )
    )
    assert result.state is ProviderTestState.READY
    assert len(result.models) == 2


def test_mistral_async_model_listing_shape_is_supported() -> None:
    models = FakeModels()
    client = SimpleNamespace(models=SimpleNamespace(list_async=models.list))
    result = asyncio.run(
        ProviderOnboardingService().test_connection(
            "mistral", ProviderConfig(api_key=SECRET_CANARY), client=client
        )
    )
    assert result.state is ProviderTestState.READY
    assert models.calls == 1


def test_mistral_v2_sdk_client_is_loaded_from_client_namespace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    models = FakeModels()

    class FakeMistral:
        def __init__(self, **options: Any) -> None:
            assert options["api_key"] == SECRET_CANARY
            self.models = SimpleNamespace(list_async=models.list)

    monkeypatch.setattr("mistralai.client.Mistral", FakeMistral)
    result = asyncio.run(
        ProviderOnboardingService().test_connection(
            "mistral", ProviderConfig(api_key=SECRET_CANARY)
        )
    )

    assert result.state is ProviderTestState.READY
    assert models.calls == 1


def test_cloudflare_catalog_uses_invocable_name_instead_of_opaque_record_id() -> None:
    normalized = normalize_cloudflare_model_search(
        {
            "success": True,
            "result": [
                {
                    "id": "opaque-catalog-record",
                    "name": "@cf/meta/llama-3.1-8b-instruct-fp8",
                }
            ],
        }
    )

    assert normalized == {
        "data": [
            {
                "id": "@cf/meta/llama-3.1-8b-instruct-fp8",
                "name": "@cf/meta/llama-3.1-8b-instruct-fp8",
            }
        ]
    }


def test_nvidia_nim_reuses_bounded_capability_aware_discovery() -> None:
    client = fake_client(
        SimpleNamespace(
            data=[
                {
                    "id": "vendor/chat-model",
                    "capabilities": ["chat", "tools", "reasoning"],
                },
                {"id": "vendor/embed-model", "task": "embedding"},
                {"id": "vendor/unknown-model"},
            ]
        )
    )
    result = asyncio.run(
        ProviderOnboardingService().test_connection(
            "nvidia-nim",
            ProviderConfig(api_key=SECRET_CANARY),
            client=client,
        )
    )

    assert result.state is ProviderTestState.READY
    assert result.discovery is ModelDiscoveryState.SUPPORTED
    assert result.filtered_models == 1
    assert result.unknown_compatibility == 1
    assert [model.model for model in result.models] == [
        "vendor/chat-model",
        "vendor/unknown-model",
    ]
    assert result.models[0].compatibility_verified is True
    assert "tools" in result.models[0].capabilities
    assert result.models[1].compatibility_verified is False


def test_nvidia_nim_discovery_limits_are_preserved() -> None:
    service = ProviderOnboardingService(
        nvidia_nim_discovery=NvidiaNimCatalogDiscovery(max_models=1)
    )
    result = asyncio.run(
        service.test_connection(
            "nvidia-nim",
            ProviderConfig(api_key=SECRET_CANARY),
            client=fake_client(SimpleNamespace(data=[{"id": "one"}, {"id": "two"}])),
        )
    )
    assert result.state is ProviderTestState.FAILED
    assert result.diagnostic is not None
    assert result.diagnostic.code == "oversized_model_catalog"


def test_nvidia_nim_force_refresh_bypasses_only_the_bounded_metadata_cache() -> None:
    client = fake_client(
        SimpleNamespace(data=[{"id": "vendor/chat-model", "capabilities": ["chat"]}])
    )
    service = ProviderOnboardingService()
    config = ProviderConfig(api_key=SECRET_CANARY)

    first = asyncio.run(service.test_connection("nvidia-nim", config, client=client))
    second = asyncio.run(
        service.test_connection(
            "nvidia-nim",
            config,
            client=client,
            force_catalog_refresh=True,
        )
    )

    assert first.catalog_cached is False
    assert second.catalog_cached is False
    assert client.models.calls == 2


class StatusError(RuntimeError):
    def __init__(self, status_code: int) -> None:
        super().__init__(f"response contained Authorization: Bearer {SECRET_CANARY}")
        self.status_code = status_code


class RecordedConnectionError(RuntimeError):
    def __str__(self) -> str:
        return f"offline transport leaked {SECRET_CANARY}"


class RecordedTimeoutError(RuntimeError):
    def __str__(self) -> str:
        return f"timeout body leaked {SECRET_CANARY}"


@pytest.mark.parametrize(
    ("error", "code", "retryable"),
    (
        (StatusError(401), "authentication_failed", False),
        (StatusError(429), "rate_limit", True),
        (RecordedConnectionError(), "network_error", True),
        (RecordedTimeoutError(), "timeout", True),
    ),
)
def test_connection_diagnostics_are_stable_and_secret_free(
    error: Exception, code: str, retryable: bool, caplog: pytest.LogCaptureFixture
) -> None:
    result = asyncio.run(
        ProviderOnboardingService().test_connection(
            "openai",
            ProviderConfig(api_key=SECRET_CANARY),
            client=fake_client(error=error),
        )
    )

    assert result.state is ProviderTestState.FAILED
    assert result.discovery is ModelDiscoveryState.FAILED
    assert result.diagnostic is not None
    assert result.diagnostic.code == code
    assert result.diagnostic.retryable is retryable
    assert SECRET_CANARY not in repr(result)
    assert SECRET_CANARY not in caplog.text


class BlockingModels:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.stopped = asyncio.Event()

    async def list(self) -> Any:
        self.started.set()
        try:
            await asyncio.Event().wait()
        finally:
            self.stopped.set()


def test_explicit_cancellation_stops_discovery_and_returns_typed_state() -> None:
    async def scenario() -> None:
        models = BlockingModels()
        cancellation = OnboardingCancellation()
        task = asyncio.create_task(
            ProviderOnboardingService().test_connection(
                "cohere",
                ProviderConfig(api_key=SECRET_CANARY),
                client=SimpleNamespace(models=models),
                cancellation=cancellation,
            )
        )
        await asyncio.wait_for(models.started.wait(), timeout=1)
        cancellation.cancel()
        result = await asyncio.wait_for(task, timeout=1)

        assert result.state is ProviderTestState.CANCELLED
        assert result.diagnostic is not None
        assert result.diagnostic.code == "cancelled"
        assert models.stopped.is_set()
        assert SECRET_CANARY not in repr(result)

    asyncio.run(scenario())


def test_missing_discovery_surface_is_reported_without_claiming_verified_connection() -> None:
    result = asyncio.run(
        ProviderOnboardingService().test_connection(
            "cohere",
            ProviderConfig(api_key=SECRET_CANARY),
            client=SimpleNamespace(),
        )
    )
    assert result.state is ProviderTestState.DEGRADED
    assert result.discovery is ModelDiscoveryState.UNSUPPORTED
    assert result.diagnostic is not None
    assert result.diagnostic.code == "model_discovery_unsupported"


def test_missing_credential_fails_without_client_construction() -> None:
    result = asyncio.run(ProviderOnboardingService().test_connection("openai", ProviderConfig()))
    assert result.state is ProviderTestState.FAILED
    assert result.diagnostic is not None
    assert result.diagnostic.code == "missing_provider_credential"


def test_unsupported_provider_input_is_not_reflected_into_result() -> None:
    result = asyncio.run(
        ProviderOnboardingService().test_connection(
            SECRET_CANARY, ProviderConfig(api_key=SECRET_CANARY), client=SimpleNamespace()
        )
    )
    assert result.provider == "unknown"
    assert result.diagnostic is not None
    assert result.diagnostic.code == "unsupported_provider"
    assert SECRET_CANARY not in repr(result)


def test_reflected_secret_is_removed_from_successful_discovery_result() -> None:
    response = SimpleNamespace(
        data=[
            {"id": "vendor/safe", "name": "Safe model"},
            {"id": "vendor/reflected", "name": f"reflected {SECRET_CANARY}"},
        ]
    )
    result = asyncio.run(
        ProviderOnboardingService().test_connection(
            "openai",
            ProviderConfig(api_key=SECRET_CANARY),
            client=fake_client(response),
        )
    )
    assert [model.id for model in result.models] == ["vendor/safe"]
    assert SECRET_CANARY not in repr(asdict(result))


def test_generic_remote_openai_compatible_discovery() -> None:
    result = asyncio.run(
        ProviderOnboardingService().test_connection(
            "openai-compatible",
            ProviderConfig(
                api_key=SECRET_CANARY,
                base_url="https://Models.Example.test/v1/",
            ),
            client=fake_client(),
        )
    )
    assert result.state is ProviderTestState.READY
    assert result.provider == "openai-compatible"
    assert len(result.models) == 2


@pytest.mark.parametrize(
    ("provider", "account_id", "records", "expected"),
    (
        (
            "groq",
            None,
            [
                {"id": "openai/gpt-oss-20b", "name": "GPT OSS 20B"},
                {"id": "vendor/paid", "name": "Paid"},
            ],
            ["openai/gpt-oss-20b"],
        ),
        (
            "openrouter",
            None,
            [
                {
                    "id": "nvidia/nemotron-3.5-lightning:free",
                    "name": "Nemotron 3.5 Lightning (free)",
                },
                {"id": "vendor/model", "name": "Paid model"},
            ],
            ["nvidia/nemotron-3.5-lightning:free"],
        ),
        (
            "cloudflare",
            "a" * 32,
            [
                {
                    "id": "@cf/meta/llama-3.1-8b-instruct-fp8",
                    "name": "Llama 3.1 8B FP8",
                },
                {"id": "@cf/paid/model", "name": "Paid model"},
            ],
            ["@cf/meta/llama-3.1-8b-instruct-fp8"],
        ),
    ),
)
def test_named_compatible_presets_keep_only_explicit_free_routes(
    provider: str,
    account_id: str | None,
    records: list[dict[str, str]],
    expected: list[str],
) -> None:
    result = asyncio.run(
        ProviderOnboardingService().test_connection(
            provider,
            ProviderConfig(api_key=SECRET_CANARY, account_id=account_id),
            client=fake_client(SimpleNamespace(data=records)),
        )
    )
    assert result.state is ProviderTestState.READY
    assert result.provider == provider
    assert [model.id for model in result.models] == expected
    assert all(model.compatibility_verified for model in result.models)
    assert all(model.capabilities == ("streaming",) for model in result.models)


def test_named_compatible_endpoints_and_model_policy_are_fixed() -> None:
    assert named_compatible_base_url("groq") == "https://api.groq.com/openai/v1"
    assert named_compatible_base_url("openrouter") == "https://openrouter.ai/api/v1"
    assert named_compatible_base_url("cloudflare", "b" * 32).endswith(f"/{'b' * 32}/ai/v1")
    assert named_compatible_model_allowed("openrouter", "nvidia/nemotron-3.5-lightning:free")
    assert named_compatible_model_allowed("openrouter", "vendor/model:free")
    assert not named_compatible_model_allowed("openrouter", "vendor/model")


def test_named_compatible_endpoint_override_and_invalid_account_fail_closed() -> None:
    for provider, config in (
        ("groq", ProviderConfig(api_key=SECRET_CANARY, base_url="https://evil.example/v1")),
        ("cloudflare", ProviderConfig(api_key=SECRET_CANARY, account_id="not-an-account")),
    ):
        result = asyncio.run(
            ProviderOnboardingService().test_connection(provider, config, client=fake_client())
        )
        assert result.state is ProviderTestState.FAILED
        assert result.diagnostic is not None
        assert result.diagnostic.code in {"invalid_endpoint", "invalid_account_id"}
        assert SECRET_CANARY not in repr(result)


def test_generic_endpoint_normalizes_public_https_origin() -> None:
    assert (
        validate_remote_openai_compatible_endpoint("https://Models.Example.test:443/v1/")
        == "https://models.example.test:443/v1"
    )


@pytest.mark.parametrize(
    "endpoint",
    (
        "",
        "http://models.example.test/v1",
        "https://localhost/v1",
        "https://service.local/v1",
        "https://127.0.0.1/v1",
        "https://10.2.3.4/v1",
        "https://[::1]/v1",
        "https://user:password@models.example.test/v1",
        "https://models.example.test/v1?key=secret",
        "https://models.example.test/v1#fragment",
        "https://models.example.test\\v1",
    ),
)
def test_generic_endpoint_rejects_insecure_private_or_credential_bearing_urls(
    endpoint: str,
) -> None:
    with pytest.raises(ProviderError) as captured:
        validate_remote_openai_compatible_endpoint(endpoint)
    assert captured.value.code == "invalid_endpoint"
    assert SECRET_CANARY not in str(captured.value)


def test_generic_invalid_endpoint_returns_typed_secret_free_failure() -> None:
    result = asyncio.run(
        ProviderOnboardingService().test_connection(
            "openai-compatible",
            ProviderConfig(api_key=SECRET_CANARY, base_url="http://127.0.0.1:8000/v1"),
            client=fake_client(),
        )
    )
    assert result.state is ProviderTestState.FAILED
    assert result.diagnostic is not None
    assert result.diagnostic.code == "invalid_endpoint"
    assert SECRET_CANARY not in repr(result)
