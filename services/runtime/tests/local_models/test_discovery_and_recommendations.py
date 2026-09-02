import json

from cupcake_runtime.local_models.discovery import search_huggingface_gguf
from cupcake_runtime.local_models.recommendations import estimate_fit
from cupcake_runtime.local_models.types import (
    HardwareProfile,
    ModelArtifact,
    RecommendationClass,
)


class _Response:
    def __init__(self, payload: object) -> None:
        self.payload = json.dumps(payload).encode()

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
    assert "limit=40" in captured["request"].full_url  # type: ignore[union-attr]


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
