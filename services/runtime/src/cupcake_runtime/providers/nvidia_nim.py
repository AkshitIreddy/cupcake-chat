"""NVIDIA-hosted NIM text models through the OpenAI-compatible API.

The hosted API catalog covers more than chat models.  Discovery therefore
keeps upstream capability claims separate from conservative product
capabilities and visibly marks models whose chat compatibility is unknown.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import re
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from enum import StrEnum
from typing import Any, cast

from .base import (
    MissingProviderCredential,
    MissingProviderDependency,
    ProviderConfig,
    ProviderError,
    classify_provider_error,
    coerce_mapping,
)
from .openai_compatible import OpenAICompatibleAdapter
from .types import (
    CostClass,
    ModelCapabilities,
    ModelDescriptor,
    ModelPricing,
    ModelRequest,
    PrivacyRoute,
    ReasoningEffort,
    SpeedClass,
)

NVIDIA_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1"
NVIDIA_NIM_PROVIDER = "nvidia-nim"
MAX_DISCOVERED_MODELS = 512
MAX_MODEL_ID_LENGTH = 220
MAX_CATALOG_BYTES = 2 * 1024 * 1024
DEFAULT_CATALOG_TTL_SECONDS = 15 * 60
UNKNOWN_CONTEXT_WINDOW_FALLBACK = 8_192
UNKNOWN_MAX_OUTPUT_TOKENS_FALLBACK = 1_024

_SAFE_MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:+/@-]*$")
_CHAT_MARKERS = frozenset(
    {
        "chat",
        "chat-completion",
        "chat-completions",
        "completion",
        "completions",
        "conversation",
        "instruction-following",
        "llm",
        "text-generation",
    }
)
_NON_CHAT_MARKERS = frozenset(
    {
        "audio",
        "classification",
        "detector",
        "diffusion",
        "embed",
        "embedding",
        "embeddings",
        "guard",
        "image",
        "multimodal",
        "object-detection",
        "reward",
        "rerank",
        "reranking",
        "retrieval",
        "safety",
        "speech",
        "text-to-image",
        "translate",
        "video",
        "vision",
        "vlm",
    }
)

# NVIDIA's hosted ``/v1/models`` payload currently exposes only OpenAI-style
# identity fields, so it cannot prove endpoint compatibility by itself. These
# exact IDs have official NVIDIA model-card/playground pages for chat
# completions. Keeping the evidence URL beside the ID makes the claim auditable
# and prevents broad identifier heuristics from turning embeddings or guards
# into chat models.
_VERIFIED_HOSTED_CHAT_MODELS: dict[str, str] = {
    model_id: f"https://build.nvidia.com/{model_id}/modelcard"
    for model_id in (
        "deepseek-ai/deepseek-v4-flash-0731",
        "deepseek-ai/deepseek-v4-pro-0813",
        "google/diffusiongemma-26b-a4b-it",
        "google/gemma-4-31b-it",
        "meta/muse-glimmer-30b",
        "minimaxai/minimax-m3",
        "mistralai/mistral-large-2-instruct",
        "mistralai/mistral-nemotron",
        "moonshotai/kimi-k2.6",
        "moonshotai/kimi-k3",
        "nvidia/llama-3.1-nemotron-70b-instruct",
        "nvidia/llama-3.1-nemotron-ultra-253b-v1",
        "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
        "nvidia/nemotron-3-super-120b-a12b",
        "nvidia/nemotron-3-ultra-550b-a55b",
        "nvidia/nemotron-3.5-lightning-30b-a3b",
        "nvidia/nemotron-nano-3-30b-a3b",
        "openai/gpt-oss-120b",
        "openai/gpt-oss-20b",
        "poolside/laguna-xs-2.1",
    )
}


class ChatCompatibility(StrEnum):
    CHAT = "chat"
    NON_CHAT = "non_chat"
    UNKNOWN = "unknown"


def _credential_fingerprint(config: ProviderConfig) -> bytes:
    """Key the metadata cache without retaining credentials or headers."""

    digest = hashlib.blake2b(digest_size=16)
    digest.update((config.api_key or "").encode("utf-8"))
    digest.update(b"\0")
    digest.update((config.organization or "").encode("utf-8"))
    for key, value in sorted((config.headers or {}).items()):
        digest.update(b"\0")
        digest.update(key.encode("utf-8"))
        digest.update(b"\0")
        digest.update(value.encode("utf-8"))
    return digest.digest()


@dataclass(frozen=True, slots=True)
class NvidiaNimCatalogResult:
    models: tuple[ModelDescriptor, ...]
    filtered_non_chat: int
    unknown_chat_compatibility: int
    fetched_at_ms: int
    cached: bool = False


@dataclass(slots=True)
class NvidiaNimCatalogDiscovery:
    """Fetch and bound one NVIDIA ``/models`` response.

    The API key and raw response never enter the cache.  Only normalized,
    product-owned descriptors are retained for a short period.
    """

    ttl_seconds: float = DEFAULT_CATALOG_TTL_SECONDS
    max_models: int = MAX_DISCOVERED_MODELS
    max_catalog_bytes: int = MAX_CATALOG_BYTES
    _cached: NvidiaNimCatalogResult | None = field(default=None, init=False, repr=False)
    _cached_at: float = field(default=0.0, init=False, repr=False)
    _cached_credential_fingerprint: bytes | None = field(default=None, init=False, repr=False)

    def invalidate(self) -> None:
        """Forget normalized metadata after a credential change.

        Catalog data itself is never secret, but a newly connected account can
        have a different accessible model set. Reconfiguration therefore
        starts a new bounded discovery cycle while ordinary chat requests keep
        using the short-lived cache.
        """

        self._cached = None
        self._cached_at = 0.0
        self._cached_credential_fingerprint = None

    async def discover(
        self,
        config: ProviderConfig,
        *,
        client: Any = None,
        force: bool = False,
    ) -> NvidiaNimCatalogResult:
        if not config.api_key:
            raise MissingProviderCredential(NVIDIA_NIM_PROVIDER, "NVIDIA NIM API key")
        now = time.monotonic()
        credential_fingerprint = _credential_fingerprint(config)
        if (
            not force
            and self._cached is not None
            and self._cached_credential_fingerprint == credential_fingerprint
            and now - self._cached_at < self.ttl_seconds
        ):
            return replace(self._cached, cached=True)

        resolved_client = client or self._create_client(config)
        try:
            response = resolved_client.models.list()
            if inspect.isawaitable(response):
                response = await response
        except Exception as exc:
            classified = classify_provider_error(exc)
            raise ProviderError(
                classified.message,
                code=classified.code,
                retryable=classified.retryable,
            ) from exc
        result = self._parse_response(response)
        self._cached = result
        self._cached_at = now
        self._cached_credential_fingerprint = credential_fingerprint
        return result

    @staticmethod
    def _create_client(config: ProviderConfig) -> Any:
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:
            raise MissingProviderDependency(NVIDIA_NIM_PROVIDER, "openai") from exc
        return AsyncOpenAI(
            api_key=config.api_key,
            base_url=NVIDIA_NIM_BASE_URL,
            timeout=config.timeout_seconds,
            default_headers=dict(config.headers or {}),
        )

    def _parse_response(self, response: Any) -> NvidiaNimCatalogResult:
        response_map = coerce_mapping(response)
        raw_models = response_map.get("data", getattr(response, "data", None))
        if not isinstance(raw_models, Sequence) or isinstance(raw_models, (str, bytes, bytearray)):
            raise ProviderError(
                "NVIDIA NIM returned an invalid model catalog.",
                code="invalid_model_catalog",
            )
        model_records = cast(Sequence[Any], raw_models)
        if len(model_records) > self.max_models:
            raise ProviderError(
                "NVIDIA NIM returned more models than the safety limit.",
                code="oversized_model_catalog",
            )

        descriptors: list[ModelDescriptor] = []
        filtered = 0
        unknown = 0
        seen: set[str] = set()
        total_bytes = 0
        for raw in model_records:
            record = coerce_mapping(raw)
            try:
                encoded = json.dumps(record, default=str, separators=(",", ":")).encode("utf-8")
            except (TypeError, ValueError) as exc:
                raise ProviderError(
                    "NVIDIA NIM returned an invalid model catalog entry.",
                    code="invalid_model_catalog",
                ) from exc
            total_bytes += len(encoded)
            if total_bytes > self.max_catalog_bytes:
                raise ProviderError(
                    "NVIDIA NIM returned a model catalog larger than the safety limit.",
                    code="oversized_model_catalog",
                )

            model_id = record.get("id")
            if not isinstance(model_id, str):
                continue
            model_id = model_id.strip()
            if (
                not model_id
                or len(model_id) > MAX_MODEL_ID_LENGTH
                or not _SAFE_MODEL_ID.fullmatch(model_id)
                or model_id in seen
            ):
                continue
            seen.add(model_id)
            compatibility, evidence, declared = _classify_chat_compatibility(record, model_id)
            if compatibility is ChatCompatibility.NON_CHAT:
                filtered += 1
                continue
            if compatibility is ChatCompatibility.UNKNOWN:
                unknown += 1
            descriptors.append(
                _descriptor_from_record(model_id, record, compatibility, evidence, declared)
            )

        result = NvidiaNimCatalogResult(
            models=tuple(sorted(descriptors, key=lambda item: item.display_name.casefold())),
            filtered_non_chat=filtered,
            unknown_chat_compatibility=unknown,
            fetched_at_ms=int(time.time() * 1000),
        )
        return result


class NvidiaNimAdapter(OpenAICompatibleAdapter):
    provider = NVIDIA_NIM_PROVIDER

    def __init__(
        self,
        descriptor: ModelDescriptor,
        config: ProviderConfig,
        *,
        client: Any = None,
    ) -> None:
        # A first-class hosted provider must not inherit a renderer-supplied
        # endpoint.  Self-hosted NIM belongs in the generic compatible flow.
        super().__init__(
            descriptor,
            replace(config, base_url=NVIDIA_NIM_BASE_URL),
            client=client,
        )

    def build_request(self, request: ModelRequest) -> dict[str, Any]:
        payload = super().build_request(request)
        # Nemotron 3 Nano emits its private reasoning trace in `content` by
        # default. CUPCAKEAGI never surfaces hidden chain-of-thought, so use
        # NVIDIA's documented non-thinking chat-template mode unless a future
        # explicit, provider-safe reasoning control is introduced.
        payload["chat_template_kwargs"] = {"enable_thinking": False}
        effort = self.effort(request)
        if effort is not ReasoningEffort.NONE:
            payload["reasoning_effort"] = effort.value
        return payload


def build_pydantic_model(model_name: str, *, api_key: str | None = None) -> Any:
    try:
        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.openai import OpenAIProvider
        from pydantic_ai.settings import ModelSettings
    except ImportError as exc:
        raise MissingProviderDependency(NVIDIA_NIM_PROVIDER, "pydantic-ai-slim[openai]") from exc
    return OpenAIChatModel(
        model_name,
        provider=OpenAIProvider(api_key=api_key, base_url=NVIDIA_NIM_BASE_URL),
        settings=ModelSettings(
            extra_body={"chat_template_kwargs": {"enable_thinking": False}},
        ),
    )


def _classify_chat_compatibility(
    record: Mapping[str, Any], model_id: str
) -> tuple[ChatCompatibility, str, frozenset[str]]:
    markers = _declared_markers(record)
    if markers & _CHAT_MARKERS:
        return ChatCompatibility.CHAT, "provider-declared task/capability", markers
    if markers & _NON_CHAT_MARKERS:
        return ChatCompatibility.NON_CHAT, "provider-declared non-chat task/capability", markers
    if model_id in _VERIFIED_HOSTED_CHAT_MODELS:
        return ChatCompatibility.CHAT, "official NVIDIA hosted chat model card", markers

    # Identifiers are only used to exclude unmistakable non-text surfaces.  An
    # identifier is never enough to claim that a model supports chat.
    identifier_tokens = frozenset(re.split(r"[/:_.+-]+", model_id.casefold()))
    if identifier_tokens & _NON_CHAT_MARKERS:
        return ChatCompatibility.NON_CHAT, "identifier indicates a non-chat surface", markers
    return ChatCompatibility.UNKNOWN, "NVIDIA catalog did not declare chat compatibility", markers


def _declared_markers(record: Mapping[str, Any]) -> frozenset[str]:
    values: list[str] = []
    for key in ("task", "type", "model_type", "pipeline_tag", "category"):
        value = record.get(key)
        if isinstance(value, str):
            values.append(value)
    capabilities = record.get("capabilities")
    if isinstance(capabilities, Mapping):
        capability_map = cast(Mapping[Any, Any], capabilities)
        values.extend(str(key) for key, enabled in capability_map.items() if enabled is True)
    elif isinstance(capabilities, Sequence) and not isinstance(
        capabilities, (str, bytes, bytearray)
    ):
        capability_list = cast(Sequence[Any], capabilities)
        values.extend(item for item in capability_list if isinstance(item, str))
    tokens: set[str] = set()
    for value in values:
        normalized = value.casefold().strip().replace("_", "-")
        if normalized:
            tokens.add(normalized)
            tokens.update(part for part in re.split(r"[/:, ]+", normalized) if part)
    return frozenset(tokens)


def _descriptor_from_record(
    model_id: str,
    record: Mapping[str, Any],
    compatibility: ChatCompatibility,
    evidence: str,
    declared: frozenset[str],
) -> ModelDescriptor:
    context = _bounded_positive_integer(
        record.get("context_window") or record.get("context_length") or record.get("max_model_len")
    )
    output = _bounded_positive_integer(
        record.get("max_output_tokens") or record.get("max_tokens"), maximum=10_000_000
    )
    reasoning = "reasoning" in declared or "reasoning-effort" in declared
    tools = bool(declared & {"tools", "tool-calling", "function-calling"})
    structured = bool(declared & {"structured-output", "json-schema", "json-mode"})
    verified_chat = compatibility is ChatCompatibility.CHAT
    display = model_id if verified_chat else f"{model_id} · compatibility unverified"
    publisher_id = model_id.split("/", 1)[0]
    verification_url = _VERIFIED_HOSTED_CHAT_MODELS.get(model_id)
    reasoning_efforts = (
        (ReasoningEffort.NONE, ReasoningEffort.LOW, ReasoningEffort.MEDIUM, ReasoningEffort.HIGH)
        if reasoning
        else ()
    )
    return ModelDescriptor(
        id=f"{NVIDIA_NIM_PROVIDER}:{model_id}",
        provider=NVIDIA_NIM_PROVIDER,
        model=model_id,
        display_name=display,
        family=f"{NVIDIA_NIM_PROVIDER}:{model_id}",
        # The catalog often omits limits for hosted models. Unknown does not
        # mean zero: after explicit compatibility confirmation, use a small
        # safe envelope for planning while retaining the unknown disclosure in
        # metadata/UI. A context sentinel of one makes every real chat fail
        # before the provider is reached.
        context_window=context or UNKNOWN_CONTEXT_WINDOW_FALLBACK,
        max_output_tokens=output or UNKNOWN_MAX_OUTPUT_TOKENS_FALLBACK,
        capabilities=ModelCapabilities(
            streaming=verified_chat,
            tools=tools,
            images=False,
            documents=False,
            citations=False,
            reasoning=reasoning,
            structured_output=structured,
        ),
        reasoning_efforts=reasoning_efforts,
        default_reasoning_effort=ReasoningEffort.NONE,
        privacy_route=PrivacyRoute.CLOUD,
        speed_class=SpeedClass.BALANCED,
        cost_class=CostClass.UNKNOWN,
        pricing=ModelPricing(source="NVIDIA API Catalog; model terms and pricing vary"),
        metadata={
            "catalog": "NVIDIA API Catalog",
            "catalog_url": "https://build.nvidia.com/",
            "api_base": NVIDIA_NIM_BASE_URL,
            "chat_compatibility": compatibility.value,
            "compatibility_evidence": evidence,
            "compatibility_source_url": verification_url,
            "compatibility_verified_at": "2026-09-03" if verification_url else None,
            "verification_state": "docs_verified_chat" if verification_url else "unverified",
            "publisher_id": publisher_id,
            "requires_compatibility_confirmation": not verified_chat,
            "context_window_known": context is not None,
            "max_output_tokens_known": output is not None,
            "conservative_context_window": (
                None if context is not None else UNKNOWN_CONTEXT_WINDOW_FALLBACK
            ),
            "conservative_max_output_tokens": (
                None if output is not None else UNKNOWN_MAX_OUTPUT_TOKENS_FALLBACK
            ),
            "pricing_provenance": "NVIDIA API Catalog and the selected model terms",
            "privacy_route_label": "NVIDIA-hosted API Catalog",
        },
    )


def _bounded_positive_integer(value: Any, *, maximum: int = 100_000_000) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        result = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if 0 < result <= maximum else None
