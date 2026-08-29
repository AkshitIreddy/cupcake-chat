import asyncio
from collections.abc import Mapping
from typing import Any

import pytest

from cupcake_runtime.local_models.discovery import RuntimeDiscovery, validate_endpoint
from cupcake_runtime.local_models.recommendations import estimate_fit
from cupcake_runtime.local_models.types import (
    HardwareProfile,
    ModelArtifact,
    RecommendationClass,
    RuntimeKind,
    RuntimeState,
)


class FakeHttp:
    async def request(
        self, method: str, url: str, payload: Mapping[str, Any] | None = None
    ) -> object:
        del method, payload
        if url.endswith("/api/version"):
            return {"version": "1.0"}
        if url.endswith("/api/tags"):
            return {"models": [{"name": "qwen:7b"}]}
        raise OSError("not running")


def test_ollama_discovery_reports_version_and_models() -> None:
    endpoint = asyncio.run(
        RuntimeDiscovery(FakeHttp()).probe(RuntimeKind.OLLAMA, "http://127.0.0.1:11434")
    )
    assert endpoint.state == RuntimeState.READY
    assert endpoint.models == ("qwen:7b",)


def test_non_loopback_requires_explicit_remote_opt_in() -> None:
    with pytest.raises(ValueError, match="loopback"):
        validate_endpoint("http://model-server.internal:8000", allow_remote=False)
    assert validate_endpoint("https://model-server.internal:8000", allow_remote=True).startswith(
        "https://"
    )


def test_12gb_vram_recommends_7_to_9b_q4_k_m() -> None:
    model = ModelArtifact(
        "qwen:8b-q4",
        "Qwen 8B",
        "qwen",
        8,
        "Q4_K_M",
        5_000_000_000,
        "0" * 64,
        ("https://example.invalid/qwen.gguf",),
        "qwen.gguf",
        "Apache-2.0",
        "https://example.invalid/license",
        32768,
    )
    hardware = HardwareProfile(32, 24, "RTX 4070", 12, 16, ("cuda",), 100)
    result = estimate_fit(model, hardware)
    assert result.classification == RecommendationClass.RECOMMENDED
    assert result.recommended_context == 8192
