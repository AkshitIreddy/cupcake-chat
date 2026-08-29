import pytest

from cupcake_runtime.providers.anthropic import AnthropicAdapter
from cupcake_runtime.providers.base import ProviderConfig
from cupcake_runtime.providers.catalog import ModelCatalog
from cupcake_runtime.providers.cohere import CohereAdapter
from cupcake_runtime.providers.gemini import GeminiAdapter
from cupcake_runtime.providers.mistral import MistralAdapter
from cupcake_runtime.providers.openai import OpenAIResponsesAdapter
from cupcake_runtime.providers.registry import ProviderRegistry
from cupcake_runtime.providers.types import (
    CanonicalMessage,
    ModelRequest,
    ProviderContinuity,
    ReasoningEffort,
)
from cupcake_runtime.providers.xai import XAIAdapter


def test_openai_responses_payload_uses_valid_same_family_continuity() -> None:
    descriptor = ModelCatalog.builtins().get("openai:gpt-5.6-sol")
    adapter = OpenAIResponsesAdapter(descriptor, ProviderConfig(api_key="test"), client=object())
    request = ModelRequest(
        descriptor.id,
        (CanonicalMessage("user", "hello"),),
        reasoning_effort=ReasoningEffort.HIGH,
        continuity=ProviderContinuity("openai", "gpt-5.6", {"response_id": "resp_1"}),
    )
    payload = adapter.build_request(request)
    assert payload["previous_response_id"] == "resp_1"
    assert payload["reasoning"]["effort"] == "high"


def test_openai_none_effort_omits_reasoning_request() -> None:
    descriptor = ModelCatalog.builtins().get("openai:gpt-5.6-sol")
    adapter = OpenAIResponsesAdapter(descriptor, ProviderConfig(api_key="test"), client=object())
    request = ModelRequest(
        descriptor.id,
        (CanonicalMessage("user", "hello"),),
        reasoning_effort=ReasoningEffort.NONE,
    )
    assert "reasoning" not in adapter.build_request(request)


def test_anthropic_payload_separates_system_and_maps_adaptive_effort() -> None:
    descriptor = ModelCatalog.builtins().get("anthropic:claude-sonnet-5")
    adapter = AnthropicAdapter(descriptor, ProviderConfig(api_key="test"), client=object())
    request = ModelRequest(
        descriptor.id,
        (CanonicalMessage("system", "safe"), CanonicalMessage("user", "hello")),
        reasoning_effort=ReasoningEffort.LOW,
    )
    payload = adapter.build_request(request)
    assert payload["system"] == "safe"
    assert payload["messages"] == [{"role": "user", "content": "hello"}]
    assert payload["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert payload["output_config"] == {"effort": "low"}


def test_anthropic_supported_none_effort_disables_adaptive_thinking() -> None:
    descriptor = ModelCatalog.builtins().get("anthropic:claude-sonnet-5")
    adapter = AnthropicAdapter(descriptor, ProviderConfig(api_key="test"), client=object())
    request = ModelRequest(
        descriptor.id,
        (CanonicalMessage("user", "hello"),),
        reasoning_effort=ReasoningEffort.NONE,
    )
    assert adapter.build_request(request)["thinking"] == {"type": "disabled"}


def test_gemini_3_maps_portable_effort_to_thinking_level() -> None:
    descriptor = ModelCatalog.builtins().get("google:gemini-3.5-flash")
    adapter = GeminiAdapter(descriptor, ProviderConfig(api_key="test"), client=object())
    request = ModelRequest(
        descriptor.id,
        (CanonicalMessage("user", "hello"),),
        reasoning_effort=ReasoningEffort.HIGH,
        temperature=0.1,
    )
    payload = adapter.build_request(request)
    assert payload["config"]["thinking_config"]["thinking_level"] == "high"
    assert "temperature" not in payload["config"]


def test_xai_maps_reasoning_effort_without_routing() -> None:
    descriptor = ModelCatalog.builtins().get("xai:grok-4.3")
    adapter = XAIAdapter(descriptor, ProviderConfig(api_key="test"), client=object())
    request = ModelRequest(
        descriptor.id,
        (CanonicalMessage("user", "hello"),),
        reasoning_effort=ReasoningEffort.LOW,
    )
    assert adapter.build_request(request)["reasoning_effort"] == "low"


def test_cohere_non_reasoning_catalog_entry_disables_private_thinking() -> None:
    descriptor = ModelCatalog.builtins().get("cohere:command-a-plus-05-2026")
    adapter = CohereAdapter(descriptor, ProviderConfig(api_key="test"), client=object())
    request = ModelRequest(descriptor.id, (CanonicalMessage("user", "hello"),))
    assert adapter.build_request(request)["thinking"] == {"type": "disabled"}


@pytest.mark.parametrize(
    ("model_id", "adapter_type"),
    (
        ("mistral:mistral-medium-3-5", MistralAdapter),
        ("cohere:command-a-plus-05-2026", CohereAdapter),
    ),
)
def test_non_reasoning_models_reject_unsupported_effort(
    model_id: str, adapter_type: type[MistralAdapter] | type[CohereAdapter]
) -> None:
    descriptor = ModelCatalog.builtins().get(model_id)
    adapter = adapter_type(descriptor, ProviderConfig(api_key="test"), client=object())
    request = ModelRequest(
        descriptor.id,
        (CanonicalMessage("user", "hello"),),
        reasoning_effort=ReasoningEffort.HIGH,
    )
    with pytest.raises(ValueError, match="unsupported reasoning effort"):
        adapter.validate_request(request)


def test_generic_endpoint_maps_only_advertised_reasoning_effort() -> None:
    registry = ProviderRegistry()
    descriptor = registry.register_openai_compatible_endpoint(
        "lab",
        model="cupcake-chat",
        display_name="Cupcake Chat",
        base_url="https://lab.example.test/v1",
        reasoning_efforts=(ReasoningEffort.NONE, ReasoningEffort.MEDIUM),
    )
    adapter = registry.adapter(descriptor.id, client=object())
    request = ModelRequest(
        descriptor.id,
        (CanonicalMessage("user", "hello"),),
        reasoning_effort=ReasoningEffort.MEDIUM,
    )
    assert adapter.build_request(request)["reasoning_effort"] == "medium"  # type: ignore[attr-defined]
