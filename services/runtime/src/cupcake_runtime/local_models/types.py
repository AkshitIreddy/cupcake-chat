"""Local model product contracts and lifecycle state."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any


class RuntimeKind(StrEnum):
    CUPCAKE_LLAMA_CPP = "cupcake_llama_cpp"


class RuntimeState(StrEnum):
    ABSENT = "absent"
    STOPPED = "stopped"
    STARTING = "starting"
    READY = "ready"
    BUSY = "busy"
    STOPPING = "stopping"
    FAILED = "failed"
    UNREACHABLE = "unreachable"


class RuntimeBackend(StrEnum):
    """Acceleration backend shipped by an app-managed llama.cpp pack."""

    CPU = "cpu"
    CUDA_12 = "cuda-12"
    CUDA_13 = "cuda-13"
    VULKAN = "vulkan"
    SYCL = "sycl"
    ROCM = "rocm"


class DownloadState(StrEnum):
    QUEUED = "queued"
    RESOLVING = "resolving"
    DOWNLOADING = "downloading"
    PAUSED = "paused"
    VERIFYING = "verifying"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class RuntimeEndpoint:
    id: str
    kind: RuntimeKind
    base_url: str
    state: RuntimeState
    version: str | None = None
    models: tuple[str, ...] = ()
    managed: bool = False
    detail: str | None = None
    latency_ms: float | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict[str, Any])


@dataclass(frozen=True, slots=True)
class HardwareProfile:
    system_ram_gb: float
    available_ram_gb: float
    gpu_name: str | None = None
    vram_gb: float | None = None
    cpu_threads: int = 1
    acceleration: tuple[str, ...] = ()
    free_disk_gb: float | None = None
    gpu_driver_version: str | None = None
    os_name: str | None = None
    architecture: str | None = None
    cpu_name: str | None = None
    cpu_features: tuple[str, ...] = ()
    windows_version: str | None = None
    windows_build: str | None = None
    installed_acceleration_packs: tuple[str, ...] = ()
    # A point-in-time sample, distinct from the physical VRAM capacity above.
    # Fit decisions must prefer this value because another application may
    # already be using most of the GPU.
    available_vram_gb: float | None = None


@dataclass(frozen=True, slots=True)
class ModelArtifact:
    id: str
    display_name: str
    family: str
    parameter_billions: float
    quantization: str
    size_bytes: int
    sha256: str
    urls: tuple[str, ...]
    filename: str
    license: str
    license_url: str
    context_window: int
    architecture: str = "llama"
    min_runtime_version: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict[str, Any])
    source: str = "catalog"
    source_revision: str | None = None
    context_choices: tuple[int, ...] = ()
    capability_tags: tuple[str, ...] = ()
    task_tags: tuple[str, ...] = ()
    runtime_requirements: tuple[str, ...] = ()

    def target(self, model_directory: Path) -> Path:
        return model_directory / self.filename


@dataclass(frozen=True, slots=True)
class RuntimeCompanionArtifact:
    id: str
    size_bytes: int
    sha256: str
    urls: tuple[str, ...]
    filename: str
    files: Mapping[str, str]
    license: str
    license_url: str
    license_requires_acceptance: bool = False


@dataclass(frozen=True, slots=True)
class RuntimePackArtifact:
    """A signed, immutable llama.cpp Windows runtime archive.

    ``files`` is a mapping of archive-relative paths to SHA-256 digests.  It
    protects the executable and every DLL after extraction, rather than only
    checking the outer ZIP while installing it.
    """

    id: str
    version: str
    backend: RuntimeBackend
    platform: str
    architecture: str
    size_bytes: int
    sha256: str
    urls: tuple[str, ...]
    filename: str
    executable: str
    files: Mapping[str, str]
    source_revision: str
    license: str = "MIT"
    license_url: str = "https://github.com/ggml-org/llama.cpp/blob/master/LICENSE"
    companions: tuple[RuntimeCompanionArtifact, ...] = ()
    hardware_compatibility: Mapping[str, Any] = field(default_factory=dict[str, Any])
    prerequisites: tuple[str, ...] = ()
    bundled_by_default: bool = False

    @property
    def total_download_bytes(self) -> int:
        return self.size_bytes + sum(companion.size_bytes for companion in self.companions)


@dataclass(frozen=True, slots=True)
class InstalledRuntimePack:
    id: str
    version: str
    backend: RuntimeBackend
    directory: str
    executable: str
    source_revision: str
    installed_at: str
    active: bool
    integrity_verified: bool


@dataclass(frozen=True, slots=True)
class RuntimeCompatibility:
    runtime_id: str
    compatible: bool
    recommended: bool
    reasons: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class InstalledModel:
    id: str
    display_name: str
    filename: str
    path: str
    size_bytes: int
    sha256: str
    quantization: str
    context_window: int
    license: str
    installed_at: str
    integrity_verified: bool


@dataclass(frozen=True, slots=True)
class DownloadSnapshot:
    model_id: str
    state: DownloadState
    destination: str
    bytes_downloaded: int = 0
    bytes_total: int | None = None
    source_url: str | None = None
    error_code: str | None = None
    error_detail: str | None = None
    attempt: int = 0


class RecommendationClass(StrEnum):
    RECOMMENDED = "recommended"
    FITS_REDUCED_CONTEXT = "fits_reduced_context"
    # Compatibility aliases for earlier callers. Their serialized values use
    # the more useful product labels above.
    POSSIBLE = "fits_reduced_context"
    CPU_ONLY_SLOW = "cpu_only_slow"
    HYBRID = "hybrid"
    INCOMPATIBLE = "incompatible"
    UNSUITABLE = "incompatible"


@dataclass(frozen=True, slots=True)
class ModelRecommendation:
    model_id: str
    classification: RecommendationClass
    estimated_vram_gb: float
    estimated_ram_gb: float
    recommended_context: int
    reasons: tuple[str, ...]
    label: str = ""
    estimated_disk_gb: float = 0.0
    context_headroom_tokens: int = 0
    likely_speed_class: str = "unknown"
    acceleration: str = "unknown"


@dataclass(frozen=True, slots=True)
class PerformanceMeasurement:
    runtime_id: str
    model_id: str
    prompt_tokens: int
    generated_tokens: int
    prompt_tokens_per_second: float
    generated_tokens_per_second: float
    context_size: int
    measured_at: str
    total_seconds: float | None = None
    measurement_source: str = "runtime"
