from cupcake_runtime.local_models.recommendations import estimate_fit
from cupcake_runtime.local_models.types import (
    HardwareProfile,
    ModelArtifact,
    RecommendationClass,
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
