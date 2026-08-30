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
from .onboarding import (
    DiscoveredProviderModel,
    ModelDiscoveryState,
    OnboardingCancellation,
    ProviderOnboardingDiagnostic,
    ProviderOnboardingExecution,
    ProviderOnboardingResult,
    ProviderOnboardingService,
    ProviderTestState,
    validate_remote_openai_compatible_endpoint,
)
from .registry import ProviderRegistry
from .types import *  # noqa: F403

__all__ = [
    "BUILTIN_MODELS",
    "MOCK_DESCRIPTOR",
    "NVIDIA_NIM_BASE_URL",
    "NVIDIA_NIM_PROVIDER",
    "DiscoveredProviderModel",
    "MissingProviderCredential",
    "MissingProviderDependency",
    "MockProviderAdapter",
    "ModelCatalog",
    "ModelDiscoveryState",
    "NvidiaNimAdapter",
    "NvidiaNimCatalogDiscovery",
    "NvidiaNimCatalogResult",
    "OnboardingCancellation",
    "ProviderAdapter",
    "ProviderConfig",
    "ProviderError",
    "ProviderOnboardingDiagnostic",
    "ProviderOnboardingExecution",
    "ProviderOnboardingResult",
    "ProviderOnboardingService",
    "ProviderRegistry",
    "ProviderTestState",
    "UnknownModel",
    "openai_compatible_descriptor",
    "validate_remote_openai_compatible_endpoint",
]
