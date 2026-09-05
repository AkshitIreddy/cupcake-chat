import json

import pytest

from cupcake_runtime.local_models.discovery import search_huggingface_gguf
from cupcake_runtime.local_models.recommendations import estimate_fit, estimate_model_memory
from cupcake_runtime.local_models.types import (
    HardwareProfile,
    ModelArtifact,
    RecommendationClass,
)


class _Response:
    def __init__(self, payload: object, *, link: str | None = None) -> None:
        self.payload = json.dumps(payload).encode()
        self.headers = {"Link": link} if link else {}

    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, _limit: int) -> bytes:
        return self.payload


def test_huggingface_discovery_is_bounded_and_read_only() -> None:
    captured: dict[str, object] = {}

    def open_request(request: object, *, timeout: int) -> _Response:
        captured["request"] = request
        captured["timeout"] = timeout
        return _Response(
            [
                {
                    "id": "acme/Model-7B-GGUF",
                    "downloads": 1234,
                    "likes": 88,
                    "tags": ["gguf", "text-generation", "license:apache-2.0"],
                    "lastModified": "2026-09-01T00:00:00Z",
                }
            ]
        )

    result = search_huggingface_gguf("  model   7b  ", limit=500, opener=open_request)

    assert result["query"] == "model 7b"
    assert result["count"] == 1
    assert result["models"][0] == {
        "id": "hf:acme/Model-7B-GGUF",
        "provider": "Hugging Face",
        "name": "Model-7B",
        "route": "Local",
        "tags": ["text-generation", "GGUF"],
        "context": "See model card",
        "cost": "Local",
        "status": "community",
        "description": (
            "Community GGUF published by acme. Review the model card, files, license, "
            "and compatibility before importing."
        ),
        "source": "Hugging Face Hub",
        "sourceUrl": "https://huggingface.co/acme/Model-7B-GGUF",
        "license": "apache-2.0",
        "parameters": "7B",
        "downloads": 1234,
        "likes": 88,
        "lastModified": "2026-09-01T00:00:00Z",
        "gated": False,
        "fit": "pending",
        "fitReason": "Choose a quantization on the model card to estimate device fit.",
    }
    assert captured["timeout"] == 12
    assert result["limit"] == 100
    assert result["hasMore"] is False
    assert result["nextCursor"] is None
    assert "limit=100" in captured["request"].full_url  # type: ignore[union-attr]


def test_huggingface_discovery_accepts_a_model_url() -> None:
    captured: dict[str, object] = {}

    def open_request(request: object, *, timeout: int) -> _Response:
        captured["request"] = request
        captured["timeout"] = timeout
        return _Response([])

    result = search_huggingface_gguf(
        "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-GGUF",
        opener=open_request,
    )

    assert result["query"] == "bartowski/Qwen2.5-Coder-7B-GGUF"
    assert "search=bartowski%2FQwen2.5-Coder-7B-GGUF" in captured["request"].full_url  # type: ignore[union-attr]


def test_huggingface_discovery_follows_opaque_hub_cursor_pages() -> None:
    captured: list[str] = []

    def first_page(request: object, *, timeout: int) -> _Response:
        captured.append(request.full_url)  # type: ignore[attr-defined]
        return _Response(
            [{"id": "acme/First-GGUF", "tags": ["gguf"]}],
            link=(
                "<https://huggingface.co/api/models?filter=gguf&limit=36&cursor=opaque_next_42>; "
                'rel="next"'
            ),
        )

    page = search_huggingface_gguf("qwen", limit=36, opener=first_page)
    assert page["hasMore"] is True
    assert page["nextCursor"] == "opaque_next_42"

    def second_page(request: object, *, timeout: int) -> _Response:
        captured.append(request.full_url)  # type: ignore[attr-defined]
        return _Response([])

    final_page = search_huggingface_gguf(
        "qwen", limit=36, cursor=page["nextCursor"], opener=second_page
    )
    assert "cursor=opaque_next_42" in captured[-1]
    assert final_page["hasMore"] is False


def test_huggingface_discovery_rejects_forged_cursor_values() -> None:
    with pytest.raises(ValueError, match="pagination cursor"):
        search_huggingface_gguf("qwen", cursor="https://attacker.invalid/next")


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
    assert result.label == "Recommended"
    assert result.likely_speed_class == "fast"
    assert result.acceleration == "gpu"
    assert result.estimated_disk_gb > 5


def test_cpu_only_fit_is_distinct_from_hybrid_and_disk_failure() -> None:
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
        context_choices=(2048, 4096, 8192),
    )
    cpu = HardwareProfile(32, 24, None, None, 16, (), 100)
    result = estimate_fit(model, cpu)
    assert result.classification == RecommendationClass.CPU_ONLY_SLOW
    assert result.label == "CPU-only / slow"
    assert result.recommended_context == 4096

    no_disk = HardwareProfile(32, 24, None, None, 16, (), 0.1)
    result = estimate_fit(model, no_disk)
    assert result.classification == RecommendationClass.INCOMPATIBLE
    assert "disk" in " ".join(result.reasons)


def test_fit_uses_current_free_vram_and_accounts_for_context_memory() -> None:
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
        architecture="qwen3",
        context_choices=(4096, 8192, 16384),
    )
    hardware = HardwareProfile(
        32,
        24,
        "NVIDIA GeForce RTX 4070",
        12,
        16,
        ("cuda",),
        100,
        available_vram_gb=4.0,
    )

    result = estimate_fit(model, hardware)
    short = estimate_model_memory(model, 4096)
    long = estimate_model_memory(model, 16384)

    assert result.classification == RecommendationClass.HYBRID
    assert "currently free VRAM" in " ".join(result.reasons)
    assert long.kv_cache_gb > short.kv_cache_gb * 3.9
    assert long.total_accelerator_gb > short.total_accelerator_gb


def test_memory_estimate_uses_curated_qwen3_gqa_shape() -> None:
    model = ModelArtifact(
        "qwen3-8b-q4-k-m",
        "Qwen3 8B",
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
        architecture="qwen3",
        context_choices=(4096, 8192),
    )

    estimate = estimate_model_memory(model, 8192)

    # Upstream config: 36 layers, 8 KV heads, head_dim 128. F16 K+V is
    # 147,456 bytes/token; the estimate deliberately adds 10% safety headroom.
    assert 1.23 < estimate.kv_cache_gb < 1.24
    assert estimate.source == "curated architecture metadata"
