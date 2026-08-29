"""Deterministic provider used by CI, first-run, and offline demos."""

from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator

from .base import EventBuilder, ProviderAdapter, ProviderConfig
from .types import (
    ModelCapabilities,
    ModelDescriptor,
    ModelRequest,
    NormalizedStreamEvent,
    PrivacyRoute,
    StreamEventType,
    TokenUsage,
)

MOCK_DESCRIPTOR = ModelDescriptor(
    id="mock:cupcake-deterministic",
    provider="mock",
    model="cupcake-deterministic",
    display_name="Cupcake Deterministic",
    family="mock-v1",
    context_window=32_768,
    max_output_tokens=4_096,
    capabilities=ModelCapabilities(images=False, citations=True, reasoning=False),
    privacy_route=PrivacyRoute.LOCAL,
)


class MockProviderAdapter(ProviderAdapter):
    provider = "mock"

    def __init__(
        self, descriptor: ModelDescriptor = MOCK_DESCRIPTOR, config: ProviderConfig | None = None
    ):
        super().__init__(descriptor, config or ProviderConfig())

    async def stream(self, request: ModelRequest) -> AsyncIterator[NormalizedStreamEvent]:
        self.validate_request(request)
        events = EventBuilder(self.descriptor, str(request.metadata.get("run_id") or "mock-run"))
        yield events.make(
            StreamEventType.START, metadata={"provider": "mock", "model": self.descriptor.model}
        )
        prompt = next((m.content for m in reversed(request.messages) if m.role == "user"), "")
        response = str(request.metadata.get("mock_response") or f"Cupcake received: {prompt}")
        chunk_size = int(request.metadata.get("mock_chunk_size") or 12)
        for offset in range(0, len(response), chunk_size):
            yield events.make(
                StreamEventType.TEXT_DELTA, text=response[offset : offset + chunk_size]
            )
        usage = TokenUsage(
            input_tokens=max(1, len(" ".join(m.content for m in request.messages).split())),
            output_tokens=max(1, len(response.split())),
        )
        yield events.make(StreamEventType.USAGE, usage=usage, cost=self.cost(usage))
        digest = hashlib.sha256(response.encode()).hexdigest()[:16]
        yield events.make(
            StreamEventType.FINISH,
            finish_reason="stop",
            metadata={"response_digest": digest},
        )
