"""Built-in model catalog and explicit-only selection policy."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal

from .types import (
    CostClass,
    ModelCapabilities,
    ModelDescriptor,
    ModelPricing,
    PrivacyRoute,
    ReasoningEffort,
    SpeedClass,
)

R = ReasoningEffort


def _cloud(
    provider: str,
    model: str,
    name: str,
    family: str,
    context: int,
    output: int,
    *,
    reasoning: tuple[ReasoningEffort, ...] = (),
    images: bool = True,
    citations: bool = False,
    speed: SpeedClass = SpeedClass.BALANCED,
    cost: CostClass = CostClass.MEDIUM,
    input_price: str | None = None,
    output_price: str | None = None,
    default_reasoning: ReasoningEffort | None = None,
) -> ModelDescriptor:
    return ModelDescriptor(
        id=f"{provider}:{model}",
        provider=provider,
        model=model,
        display_name=name,
        family=family,
        context_window=context,
        max_output_tokens=output,
        capabilities=ModelCapabilities(
            images=images, documents=True, citations=citations, reasoning=bool(reasoning)
        ),
        reasoning_efforts=reasoning,
        default_reasoning_effort=(
            default_reasoning
            if default_reasoning is not None
            else (R.MEDIUM if R.MEDIUM in reasoning else R.NONE)
        ),
        privacy_route=PrivacyRoute.CLOUD,
        speed_class=speed,
        cost_class=cost,
        pricing=ModelPricing(
            Decimal(input_price) if input_price else None,
            Decimal(output_price) if output_price else None,
            source="catalog-snapshot; verify in provider settings",
        ),
    )


BUILTIN_MODELS: tuple[ModelDescriptor, ...] = (
    _cloud(
        "openai",
        "gpt-5.6-sol",
        "GPT-5.6 Sol",
        "gpt-5.6",
        1_050_000,
        128_000,
        reasoning=(R.NONE, R.LOW, R.MEDIUM, R.HIGH, R.XHIGH, R.MAX),
        cost=CostClass.HIGH,
        input_price="4",
        output_price="20",
    ),
    _cloud(
        "anthropic",
        "claude-sonnet-5",
        "Claude Sonnet 5",
        "claude-5",
        1_000_000,
        128_000,
        reasoning=(R.NONE, R.LOW, R.MEDIUM, R.HIGH, R.XHIGH, R.MAX),
        input_price="2",
        output_price="10",
        default_reasoning=R.HIGH,
    ),
    _cloud(
        "google",
        "gemini-3.5-flash",
        "Gemini 3.5 Flash",
        "gemini-3.5",
        1_048_576,
        65_536,
        reasoning=(R.MINIMAL, R.LOW, R.MEDIUM, R.HIGH),
        citations=True,
    ),
    _cloud(
        "xai",
        "grok-4.3",
        "Grok 4.3",
        "grok-4.3",
        1_000_000,
        128_000,
        reasoning=(R.LOW, R.MEDIUM, R.HIGH),
        input_price="1.25",
        output_price="2.5",
    ),
    _cloud(
        "mistral",
        "mistral-medium-3-5",
        "Mistral Medium 3.5",
        "mistral-medium-3.5",
        128_000,
        32_000,
        input_price="1.5",
        output_price="7.5",
    ),
    _cloud(
        "cohere",
        "command-a-plus-05-2026",
        "Command A+",
        "command-a-plus",
        128_000,
        64_000,
        citations=True,
    ),
)


def openai_compatible_descriptor(
    endpoint_id: str,
    model: str,
    display_name: str,
    *,
    context_window: int,
    max_output_tokens: int | None = None,
    reasoning_efforts: tuple[ReasoningEffort, ...] = (),
    capabilities: ModelCapabilities | None = None,
) -> ModelDescriptor:
    """Create a selectable descriptor isolated to one custom endpoint.

    The endpoint id is included in both the product model id and model family,
    which makes opaque continuity ineligible on a different server even when
    both servers expose a model with the same upstream name.
    """

    normalized_endpoint = endpoint_id.strip().lower()
    if not normalized_endpoint or any(char in normalized_endpoint for char in ":/\\"):
        raise ValueError("endpoint_id must be a non-empty slug without ':', '/', or '\\'")
    if not model.strip():
        raise ValueError("model is required")
    if context_window <= 0:
        raise ValueError("context_window must be positive")
    resolved_capabilities = capabilities or ModelCapabilities(reasoning=bool(reasoning_efforts))
    return ModelDescriptor(
        id=f"openai-compatible:{normalized_endpoint}/{model}",
        provider="openai-compatible",
        model=model,
        display_name=display_name,
        family=f"openai-compatible:{normalized_endpoint}:{model}",
        context_window=context_window,
        max_output_tokens=max_output_tokens,
        capabilities=resolved_capabilities,
        reasoning_efforts=reasoning_efforts,
        default_reasoning_effort=(R.MEDIUM if R.MEDIUM in reasoning_efforts else R.NONE),
        privacy_route=PrivacyRoute.SELF_HOSTED,
        speed_class=SpeedClass.BALANCED,
        cost_class=CostClass.UNKNOWN,
        metadata={"endpoint_id": normalized_endpoint},
    )


class UnknownModel(KeyError):
    pass


@dataclass(slots=True)
class ModelCatalog:
    """Registry with no automatic routing or heuristic model choice."""

    _models: dict[str, ModelDescriptor]

    @classmethod
    def builtins(cls) -> ModelCatalog:
        return cls({model.id: model for model in BUILTIN_MODELS})

    def register(self, descriptor: ModelDescriptor, *, replace: bool = False) -> None:
        if descriptor.id in self._models and not replace:
            raise ValueError(f"model already registered: {descriptor.id}")
        self._models[descriptor.id] = descriptor

    def get(self, model_id: str) -> ModelDescriptor:
        try:
            return self._models[model_id]
        except KeyError as exc:
            raise UnknownModel(model_id) from exc

    def list(
        self, *, provider: str | None = None, include_deprecated: bool = False
    ) -> tuple[ModelDescriptor, ...]:
        values: Iterable[ModelDescriptor] = self._models.values()
        if provider is not None:
            values = (m for m in values if m.provider == provider)
        if not include_deprecated:
            values = (m for m in values if not m.deprecated)
        return tuple(sorted(values, key=lambda m: (m.provider, m.display_name)))

    def select(self, model_id: str | None) -> ModelDescriptor:
        if not model_id:
            raise ValueError("model selection is required; CUPCAKEAGI never auto-routes")
        return self.get(model_id)
