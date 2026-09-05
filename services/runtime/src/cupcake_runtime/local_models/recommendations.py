"""Conservative hardware-fit recommendations for GGUF models."""

from __future__ import annotations

from dataclasses import dataclass

from .types import (
    HardwareProfile,
    ModelArtifact,
    ModelRecommendation,
    RecommendationClass,
    RuntimeBackend,
    RuntimeCompatibility,
    RuntimePackArtifact,
)

_GIB = 2**30

# F16 K+V bytes per token derived from the upstream model configurations:
# 2 caches * layers * KV heads * head dimension * 2 bytes. Keep this keyed by
# the signed catalog artifact ID: parameter count alone is especially wrong for
# GQA and MoE models (for example Qwen3 30B-A3B has only four KV heads).
_CURATED_KV_BYTES_PER_TOKEN = {
    "qwen3-0-6b-q8-0": 114_688,
    "qwen3-1-7b-q8-0": 114_688,
    "granite-3-3-2b-instruct-q4-k-m": 81_920,
    "qwen3-4b-q4-k-m": 147_456,
    "qwen3-8b-q4-k-m": 147_456,
    "qwen3-14b-q4-k-m": 163_840,
    "granite-3-3-8b-instruct-q4-k-m": 163_840,
    "ministral-3-3b-instruct-q4-k-m": 106_496,
    "ministral-3-8b-instruct-q4-k-m": 139_264,
    "phi-4-14b-q4-k-s": 204_800,
    "qwen3-30b-a3b-q4-k-m": 49_152,
}

# Default llama.cpp KV is F16. These floors cover the curated architecture
# families where parameter count alone materially underestimates GQA KV state,
# especially their smaller models. A signed catalog can override the estimate
# with a measured/model-config-derived ``kv_bytes_per_token`` value.
_KV_BYTES_PER_TOKEN_FLOOR = {
    "granite": 96 * 1024,
    "mistral3": 128 * 1024,
    "phi3": 192 * 1024,
    "qwen3": 64 * 1024,
    "qwen3moe": 96 * 1024,
}


@dataclass(frozen=True, slots=True)
class ModelMemoryEstimate:
    weight_gb: float
    kv_cache_gb: float
    runtime_overhead_gb: float
    total_accelerator_gb: float
    total_host_gb: float
    source: str


def estimate_model_memory(artifact: ModelArtifact, context_size: int) -> ModelMemoryEstimate:
    """Return a conservative pre-load estimate for one llama.cpp slot.

    This is a safety estimate, not a benchmark. The runtime's own ``--fit``
    decision remains authoritative after load because GGUF tensors, graph
    buffers, backend kernels, cache types, and driver allocations vary.
    """

    if not 1 <= context_size <= artifact.context_window:
        raise ValueError("context_size is outside the model limit")
    configured = artifact.metadata.get("kv_bytes_per_token")
    try:
        configured_bytes = float(configured) if configured is not None else 0.0
    except (TypeError, ValueError):
        configured_bytes = 0.0
    generic_bytes = artifact.parameter_billions * 1_000_000_000 / 8 / 8192
    architecture = artifact.architecture.casefold()
    if configured_bytes > 0:
        bytes_per_token = configured_bytes
        source = "catalog kv metadata"
    elif artifact.id in _CURATED_KV_BYTES_PER_TOKEN:
        bytes_per_token = float(_CURATED_KV_BYTES_PER_TOKEN[artifact.id])
        source = "curated architecture metadata"
    else:
        bytes_per_token = max(
            generic_bytes,
            float(_KV_BYTES_PER_TOKEN_FLOOR.get(architecture, 192 * 1024)),
        )
        source = (
            "conservative architecture estimate"
            if architecture in _KV_BYTES_PER_TOKEN_FLOOR
            else "conservative unknown-architecture estimate"
        )
    # Include modest allocator/graph headroom above the immutable GGUF bytes.
    weight_gb = artifact.size_bytes / _GIB * 1.03
    kv_cache_gb = bytes_per_token * context_size / _GIB * 1.10
    runtime_overhead_gb = max(0.75, min(2.0, weight_gb * 0.08))
    accelerator = weight_gb + kv_cache_gb + runtime_overhead_gb
    host = weight_gb * 1.08 + kv_cache_gb + max(1.5, runtime_overhead_gb)
    return ModelMemoryEstimate(
        round(weight_gb, 3),
        round(kv_cache_gb, 3),
        round(runtime_overhead_gb, 3),
        round(accelerator, 3),
        round(host, 3),
        source,
    )


def estimate_fit(artifact: ModelArtifact, hardware: HardwareProfile) -> ModelRecommendation:
    context_cap = min(artifact.context_window, 8192)
    context = _catalog_context(artifact, context_cap)
    memory = estimate_model_memory(artifact, context)
    vram_need = memory.total_accelerator_gb
    ram_need = max(4.0, memory.total_host_gb)
    reduced_context = _catalog_context(artifact, 4096)
    reduced_memory = estimate_model_memory(artifact, reduced_context)
    reasons: list[str] = []
    vram_capacity = hardware.vram_gb or 0
    vram = hardware.available_vram_gb if hardware.available_vram_gb is not None else vram_capacity

    if (
        hardware.free_disk_gb is not None
        and artifact.size_bytes * 1.15 > hardware.free_disk_gb * 2**30
    ):
        classification = RecommendationClass.INCOMPATIBLE
        reasons.append("insufficient free disk for download, verification, and atomic promotion")
    elif (
        11 <= vram_capacity <= 13
        and 7 <= artifact.parameter_billions <= 9
        and artifact.quantization.upper() == "Q4_K_M"
        and vram_need <= vram * 0.88
    ):
        classification = RecommendationClass.RECOMMENDED
        reasons.append("ideal 7-9B Q4_K_M fit for approximately 12 GB VRAM")
    elif vram and vram_need <= vram * 0.88 and ram_need <= hardware.available_ram_gb:
        classification = RecommendationClass.RECOMMENDED
        reasons.append("weights, context, and runtime headroom fit in dedicated VRAM")
    elif (
        vram
        and reduced_context < context
        and reduced_memory.total_accelerator_gb <= vram * 0.88
        and reduced_memory.total_host_gb <= hardware.available_ram_gb
    ):
        classification = RecommendationClass.FITS_REDUCED_CONTEXT
        context = reduced_context
        reasons.append("tight VRAM fit; use a shorter context and close GPU-heavy applications")
    elif not vram and reduced_memory.total_host_gb <= hardware.available_ram_gb:
        classification = RecommendationClass.CPU_ONLY_SLOW
        context = reduced_context
        reasons.append("fits system RAM on the safe CPU baseline, but generation will be slower")
    elif (
        reduced_memory.total_host_gb <= hardware.available_ram_gb
        and artifact.parameter_billions <= 34
    ):
        classification = RecommendationClass.HYBRID
        context = reduced_context
        reasons.append("requires partial CPU/RAM offload and will be slower")
    else:
        classification = RecommendationClass.INCOMPATIBLE
        context = _catalog_context(artifact, 2048)
        reasons.append("estimated memory demand exceeds safe local headroom")

    if (
        11 <= vram_capacity <= 13
        and 12 <= artifact.parameter_billions <= 14
        and classification == RecommendationClass.RECOMMENDED
    ):
        classification = RecommendationClass.FITS_REDUCED_CONTEXT
        context = reduced_context
        reasons.append("12-14B models on 12 GB VRAM need tighter context and headroom checks")
    if artifact.parameter_billions > 14 and 11 <= vram_capacity <= 13:
        classification = (
            RecommendationClass.HYBRID
            if reduced_memory.total_host_gb <= hardware.available_ram_gb
            else RecommendationClass.INCOMPATIBLE
        )
        reasons.append("larger than the recommended dedicated-VRAM class for 12 GB cards")

    # Report estimates for the context we actually recommend, not the larger
    # candidate that may have caused a reduced-context classification.
    memory = estimate_model_memory(artifact, context)
    vram_need = memory.total_accelerator_gb
    ram_need = max(4.0, memory.total_host_gb)

    labels = {
        RecommendationClass.RECOMMENDED: "Recommended",
        RecommendationClass.FITS_REDUCED_CONTEXT: "Fits with reduced context",
        RecommendationClass.CPU_ONLY_SLOW: "CPU-only / slow",
        RecommendationClass.HYBRID: "Hybrid",
        RecommendationClass.INCOMPATIBLE: "Incompatible",
    }
    if classification == RecommendationClass.RECOMMENDED:
        speed = "fast" if vram else "moderate"
    elif classification == RecommendationClass.FITS_REDUCED_CONTEXT:
        speed = "moderate"
    elif classification in {
        RecommendationClass.CPU_ONLY_SLOW,
        RecommendationClass.HYBRID,
    }:
        speed = "slow"
    else:
        speed = "unavailable"
    acceleration = (
        "gpu"
        if classification
        in {RecommendationClass.RECOMMENDED, RecommendationClass.FITS_REDUCED_CONTEXT}
        and vram
        else "hybrid"
        if classification == RecommendationClass.HYBRID
        else "cpu"
        if classification == RecommendationClass.CPU_ONLY_SLOW
        else "none"
    )
    if hardware.available_vram_gb is not None and vram_capacity:
        reasons.append(
            f"fit uses {vram:.1f} GB currently free VRAM of {vram_capacity:.1f} GB total"
        )
    reasons.append(
        f"estimated load: {vram_need:.1f} GB accelerator memory including "
        f"{memory.kv_cache_gb:.1f} GB KV cache, {ram_need:.1f} GB host-memory safety "
        f"budget, {artifact.size_bytes / 2**30:.1f} GB disk ({memory.source})"
    )

    return ModelRecommendation(
        artifact.id,
        classification,
        round(vram_need, 2),
        round(ram_need, 2),
        context,
        tuple(reasons),
        labels[classification],
        round(artifact.size_bytes / 2**30 * 1.15, 2),
        max(0, artifact.context_window - context),
        speed,
        acceleration,
    )


def rank_catalog(
    models: tuple[ModelArtifact, ...], hardware: HardwareProfile
) -> tuple[ModelRecommendation, ...]:
    order = {
        RecommendationClass.RECOMMENDED: 0,
        RecommendationClass.FITS_REDUCED_CONTEXT: 1,
        RecommendationClass.CPU_ONLY_SLOW: 2,
        RecommendationClass.HYBRID: 3,
        RecommendationClass.INCOMPATIBLE: 4,
    }
    return tuple(
        sorted(
            (estimate_fit(model, hardware) for model in models),
            key=lambda item: (order[item.classification], item.estimated_vram_gb),
        )
    )


def _catalog_context(artifact: ModelArtifact, limit: int) -> int:
    choices = tuple(choice for choice in artifact.context_choices if choice <= limit)
    if choices:
        return max(choices)
    return min(artifact.context_window, limit)


def rank_runtime_packs(
    runtimes: tuple[RuntimePackArtifact, ...], hardware: HardwareProfile
) -> tuple[RuntimeCompatibility, ...]:
    assessed = [_assess_runtime(runtime, hardware) for runtime in runtimes]
    priority = {
        RuntimeBackend.CUDA_13: 0,
        RuntimeBackend.CUDA_12: 1,
        RuntimeBackend.VULKAN: 2,
        RuntimeBackend.SYCL: 3,
        RuntimeBackend.ROCM: 4,
        RuntimeBackend.CPU: 5,
    }
    assessed.sort(
        key=lambda item: (
            not item.compatible,
            priority[
                next(runtime.backend for runtime in runtimes if runtime.id == item.runtime_id)
            ],
        )
    )
    recommended_id = next((item.runtime_id for item in assessed if item.compatible), None)
    return tuple(
        RuntimeCompatibility(
            item.runtime_id,
            item.compatible,
            item.runtime_id == recommended_id,
            item.reasons,
        )
        for item in assessed
    )


def _assess_runtime(
    runtime: RuntimePackArtifact, hardware: HardwareProfile
) -> RuntimeCompatibility:
    reasons: list[str] = []
    compatible = True
    acceleration = {item.casefold() for item in hardware.acceleration}
    if runtime.backend in {RuntimeBackend.CUDA_12, RuntimeBackend.CUDA_13}:
        if "cuda" not in acceleration or not (hardware.gpu_name or "").lower().startswith("nvidia"):
            compatible = False
            reasons.append("requires a supported NVIDIA GPU")
        minimum = str(runtime.hardware_compatibility.get("minimum_windows_driver") or "")
        if not hardware.gpu_driver_version:
            compatible = False
            reasons.append("NVIDIA driver version could not be verified")
        elif minimum and _version_tuple(hardware.gpu_driver_version) < _version_tuple(minimum):
            compatible = False
            reasons.append(
                f"requires NVIDIA Windows driver {minimum} or newer; "
                f"detected {hardware.gpu_driver_version}"
            )
        else:
            reasons.append("NVIDIA driver satisfies the pinned CUDA runtime requirement")
    elif runtime.backend == RuntimeBackend.VULKAN:
        if "vulkan" not in acceleration:
            compatible = False
            reasons.append("requires a working Vulkan-capable vendor graphics driver")
        else:
            reasons.append("Vulkan device discovery is available; verify with --list-devices")
    elif runtime.backend == RuntimeBackend.CPU:
        reasons.append("safe CPU baseline works without a GPU runtime")
    else:
        compatible = False
        reasons.append(f"{runtime.backend.value} compatibility is not proven on this machine")

    estimated_installed = int(
        runtime.hardware_compatibility.get(
            "estimated_installed_bytes", runtime.total_download_bytes * 2
        )
    )
    required_disk = runtime.total_download_bytes + estimated_installed
    if hardware.free_disk_gb is not None and required_disk > hardware.free_disk_gb * 2**30:
        compatible = False
        reasons.append("insufficient free disk for download plus atomic installation")
    return RuntimeCompatibility(runtime.id, compatible, False, tuple(reasons))


def _version_tuple(value: str) -> tuple[int, ...]:
    parts: list[int] = []
    for component in value.split("."):
        digits = "".join(character for character in component if character.isdigit())
        if not digits:
            break
        parts.append(int(digits))
    return tuple(parts)
