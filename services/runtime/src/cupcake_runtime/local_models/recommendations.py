"""Conservative hardware-fit recommendations for GGUF models."""

from __future__ import annotations

from .types import (
    HardwareProfile,
    ModelArtifact,
    ModelRecommendation,
    RecommendationClass,
    RuntimeBackend,
    RuntimeCompatibility,
    RuntimePackArtifact,
)

QUANT_BITS = {
    "Q2_K": 2.7,
    "Q3_K_S": 3.2,
    "Q3_K_M": 3.5,
    "Q4_K_S": 4.5,
    "Q4_K_M": 4.8,
    "Q5_K_S": 5.5,
    "Q5_K_M": 5.7,
    "Q6_K": 6.6,
    "Q8_0": 8.5,
}


def estimate_fit(artifact: ModelArtifact, hardware: HardwareProfile) -> ModelRecommendation:
    bits = QUANT_BITS.get(artifact.quantization.upper(), 5.0)
    weight_gb = artifact.parameter_billions * bits / 8 * 1.08
    # KV cache varies by architecture; this is a deliberately conservative UI
    # estimate, with actual measurements replacing it once the model loads.
    context = min(artifact.context_window, 8192)
    kv_gb = max(0.5, artifact.parameter_billions / 8 * context / 8192)
    vram_need = weight_gb + kv_gb + 1.0
    ram_need = max(4.0, weight_gb * 1.2 + 2.0)
    reasons: list[str] = []
    vram = hardware.vram_gb or 0

    if (
        11 <= vram <= 13
        and 7 <= artifact.parameter_billions <= 9
        and artifact.quantization.upper() == "Q4_K_M"
    ):
        classification = RecommendationClass.RECOMMENDED
        reasons.append("ideal 7-9B Q4_K_M fit for approximately 12 GB VRAM")
    elif vram and vram_need <= vram * 0.88 and ram_need <= hardware.available_ram_gb:
        classification = RecommendationClass.RECOMMENDED
        reasons.append("weights, context, and runtime headroom fit in dedicated VRAM")
    elif vram and vram_need <= vram * 1.08 and ram_need <= hardware.available_ram_gb:
        classification = RecommendationClass.POSSIBLE
        context = min(context, 4096)
        reasons.append("tight VRAM fit; use a shorter context and close GPU-heavy applications")
    elif ram_need <= hardware.available_ram_gb and (
        hardware.vram_gb is None or artifact.parameter_billions <= 34
    ):
        classification = RecommendationClass.HYBRID
        context = min(context, 4096)
        reasons.append("requires partial CPU/RAM offload and will be slower")
    else:
        classification = RecommendationClass.UNSUITABLE
        context = min(context, 2048)
        reasons.append("estimated memory demand exceeds safe local headroom")

    if (
        11 <= vram <= 13
        and 12 <= artifact.parameter_billions <= 14
        and classification == RecommendationClass.RECOMMENDED
    ):
        classification = RecommendationClass.POSSIBLE
        context = min(context, 4096)
        reasons.append("12-14B models on 12 GB VRAM need tighter context and headroom checks")
    if artifact.parameter_billions > 14 and 11 <= vram <= 13:
        classification = (
            RecommendationClass.HYBRID
            if ram_need <= hardware.available_ram_gb
            else RecommendationClass.UNSUITABLE
        )
        reasons.append("larger than the recommended dedicated-VRAM class for 12 GB cards")

    return ModelRecommendation(
        artifact.id,
        classification,
        round(vram_need, 2),
        round(ram_need, 2),
        context,
        tuple(reasons),
    )


def rank_catalog(
    models: tuple[ModelArtifact, ...], hardware: HardwareProfile
) -> tuple[ModelRecommendation, ...]:
    order = {
        RecommendationClass.RECOMMENDED: 0,
        RecommendationClass.POSSIBLE: 1,
        RecommendationClass.HYBRID: 2,
        RecommendationClass.UNSUITABLE: 3,
    }
    return tuple(
        sorted(
            (estimate_fit(model, hardware) for model in models),
            key=lambda item: (order[item.classification], item.estimated_vram_gb),
        )
    )


def rank_runtime_packs(
    runtimes: tuple[RuntimePackArtifact, ...], hardware: HardwareProfile
) -> tuple[RuntimeCompatibility, ...]:
    assessed = [_assess_runtime(runtime, hardware) for runtime in runtimes]
    priority = {
        RuntimeBackend.CUDA_12: 0,
        RuntimeBackend.CUDA_13: 1,
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
