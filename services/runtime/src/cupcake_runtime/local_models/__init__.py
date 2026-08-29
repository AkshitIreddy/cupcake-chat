from .catalog import (
    CatalogSignatureError,
    SignedModelCatalog,
    SignedRuntimeCatalog,
    sha256_file,
    verify_artifact,
)
from .discovery import RuntimeDiscovery, validate_endpoint
from .downloads import CheckedDownload, DownloadManager, ModelDownload, RuntimePackDownload
from .hardware import detect_hardware
from .managed import CupcakeLocalManager, LicenseAcceptanceRequired
from .manager import (
    LlamaCppSupervisor,
    LlamaServerConfig,
    LMStudioManager,
    LocalModelManager,
    OllamaManager,
    OperationProgress,
)
from .model_store import InstalledModelStore, ModelInUseError
from .recommendations import estimate_fit, rank_catalog, rank_runtime_packs
from .runtime_packs import (
    RuntimePackError,
    RuntimePackIntegrityError,
    RuntimePackInUseError,
    RuntimePackStore,
)
from .types import *  # noqa: F403

__all__ = [
    "CatalogSignatureError",
    "CheckedDownload",
    "CupcakeLocalManager",
    "DownloadManager",
    "InstalledModelStore",
    "LMStudioManager",
    "LicenseAcceptanceRequired",
    "LlamaCppSupervisor",
    "LlamaServerConfig",
    "LocalModelManager",
    "ModelDownload",
    "ModelInUseError",
    "OllamaManager",
    "OperationProgress",
    "RuntimeDiscovery",
    "RuntimePackDownload",
    "RuntimePackError",
    "RuntimePackInUseError",
    "RuntimePackIntegrityError",
    "RuntimePackStore",
    "SignedModelCatalog",
    "SignedRuntimeCatalog",
    "detect_hardware",
    "estimate_fit",
    "rank_catalog",
    "rank_runtime_packs",
    "sha256_file",
    "validate_endpoint",
    "verify_artifact",
]
