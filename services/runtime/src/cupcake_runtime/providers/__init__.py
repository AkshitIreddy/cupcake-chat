"""CUPCAKEAGI provider-neutral model runtime."""

from .base import (
    MissingProviderCredential,
    MissingProviderDependency,
    ProviderAdapter,
    ProviderConfig,
    ProviderError,
)
from .catalog import BUILTIN_MODELS, ModelCatalog, UnknownModel, openai_compatible_descriptor
from .mock import MOCK_DESCRIPTOR, MockProviderAdapter
from .nvidia_nim import (
    NVIDIA_NIM_BASE_URL,
    NVIDIA_NIM_PROVIDER,
    NvidiaNimAdapter,
    NvidiaNimCatalogDiscovery,
    NvidiaNimCatalogResult,
)
from .registry import ProviderRegistry
from .types import *  # noqa: F403

__all__ = [
    "BUILTIN_MODELS",
    "MOCK_DESCRIPTOR",
    "NVIDIA_NIM_BASE_URL",
    "NVIDIA_NIM_PROVIDER",
    "MissingProviderCredential",
    "MissingProviderDependency",
    "MockProviderAdapter",
    "ModelCatalog",
    "NvidiaNimAdapter",
    "NvidiaNimCatalogDiscovery",
    "NvidiaNimCatalogResult",
    "ProviderAdapter",
    "ProviderConfig",
    "ProviderError",
    "ProviderRegistry",
    "UnknownModel",
    "openai_compatible_descriptor",
]
