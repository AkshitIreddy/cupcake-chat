"""Explicit model selection and continuity policy."""

from __future__ import annotations

from dataclasses import dataclass

from cupcake_runtime.providers.catalog import ModelCatalog
from cupcake_runtime.providers.types import ModelDescriptor, ProviderContinuity, ReasoningEffort


@dataclass(frozen=True, slots=True)
class SelectionDecision:
    descriptor: ModelDescriptor
    reasoning_effort: ReasoningEffort
    continuity: ProviderContinuity | None
    privacy_confirmation_required: bool
    cost_confirmation_required: bool


class ModelSelectionService:
    """Product policy for manual selection; deliberately has no route() API."""

    def __init__(self, catalog: ModelCatalog):
        self.catalog = catalog

    def select(
        self,
        model_id: str,
        *,
        effort: ReasoningEffort | None = None,
        prior_model_id: str | None = None,
        continuity: ProviderContinuity | None = None,
    ) -> SelectionDecision:
        descriptor = self.catalog.select(model_id)
        chosen = effort or descriptor.default_reasoning_effort
        if chosen != ReasoningEffort.NONE and chosen not in descriptor.reasoning_efforts:
            raise ValueError(f"{descriptor.id} does not support reasoning effort {chosen.value}")
        usable = continuity if continuity and continuity.applies_to(descriptor) else None
        privacy_crossing = False
        cost_crossing = False
        if prior_model_id:
            prior = self.catalog.get(prior_model_id)
            privacy_crossing = prior.privacy_route != descriptor.privacy_route
            cost_crossing = prior.cost_class != descriptor.cost_class
        return SelectionDecision(descriptor, chosen, usable, privacy_crossing, cost_crossing)
