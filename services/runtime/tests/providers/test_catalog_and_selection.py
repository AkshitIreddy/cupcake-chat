from decimal import Decimal

import pytest

from cupcake_runtime.models import ModelSelectionService
from cupcake_runtime.providers.catalog import ModelCatalog
from cupcake_runtime.providers.types import (
    ModelCapabilities,
    ModelDescriptor,
    ModelPricing,
    PrivacyRoute,
    ProviderContinuity,
    ReasoningEffort,
    TokenUsage,
)


def test_model_selection_is_required_and_never_auto_routes() -> None:
    catalog = ModelCatalog.builtins()
    with pytest.raises(ValueError, match="selection is required"):
        catalog.select(None)
    assert catalog.select("openai:gpt-5.6-sol").provider == "openai"


def test_continuity_is_retained_only_within_provider_family() -> None:
    catalog = ModelCatalog.builtins()
    service = ModelSelectionService(catalog)
    state = ProviderContinuity("openai", "gpt-5.6", {"response_id": "resp_1"})
    same = service.select("openai:gpt-5.6-sol", continuity=state)
    switched = service.select("anthropic:claude-sonnet-5", continuity=state)
    assert same.continuity is state
    assert switched.continuity is None


def test_unsupported_reasoning_is_rejected_instead_of_coerced() -> None:
    service = ModelSelectionService(ModelCatalog.builtins())
    with pytest.raises(ValueError, match="does not support"):
        service.select("mistral:mistral-medium-3-5", effort=ReasoningEffort.HIGH)


def test_cost_estimate_accounts_for_cached_tokens() -> None:
    pricing = ModelPricing(Decimal("2"), Decimal("10"), Decimal("0.5"))
    usage = TokenUsage(input_tokens=1_000_000, output_tokens=100_000, cached_input_tokens=500_000)
    assert pricing.estimate(usage) == Decimal("2.25")


def test_privacy_and_cost_crossing_are_explicit() -> None:
    catalog = ModelCatalog.builtins()
    local = ModelDescriptor(
        id="local:test",
        provider="local",
        model="test",
        display_name="Test",
        family="test",
        context_window=4096,
        max_output_tokens=1024,
        capabilities=ModelCapabilities(),
        privacy_route=PrivacyRoute.LOCAL,
    )
    catalog.register(local)
    decision = ModelSelectionService(catalog).select(
        "local:test", prior_model_id="openai:gpt-5.6-sol"
    )
    assert decision.privacy_confirmation_required
    assert decision.cost_confirmation_required
