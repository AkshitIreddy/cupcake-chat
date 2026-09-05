"""Provider connection testing and bounded model discovery.

This module deliberately owns no credential persistence. Callers lend one
``ProviderConfig`` for the duration of a test, receive only product-owned
diagnostics and normalized model metadata, and separately decide whether a
credential should be committed to the platform vault.

Provider SDK exceptions often include request headers or response bodies in
their string representation. No raw exception text, client object, request
configuration, or credential is copied into an onboarding result.
"""

from __future__ import annotations

import asyncio
import inspect
import ipaddress
import re
import time
from collections.abc import AsyncIterable, Awaitable, Callable, Iterable, Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass, field, replace
from enum import StrEnum
from typing import Any, cast
from urllib.parse import SplitResult, urlsplit, urlunsplit

from .base import (
    MissingProviderCredential,
    MissingProviderDependency,
    ProviderConfig,
    ProviderError,
    classify_provider_error,
)
from .nvidia_nim import (
    MAX_CATALOG_BYTES,
    MAX_DISCOVERED_MODELS,
    MAX_MODEL_ID_LENGTH,
    NVIDIA_NIM_PROVIDER,
    NvidiaNimCatalogDiscovery,
    NvidiaNimCatalogResult,
)
from .types import ModelCapabilities, ModelDescriptor

OPENAI_COMPATIBLE_PROVIDER = "openai-compatible"
GEMINI_PROVIDER = "google"
NAMED_COMPATIBLE_PROVIDERS = frozenset({"groq", "openrouter", "cloudflare"})
NAMED_COMPATIBLE_DEFAULT_MODELS: dict[str, str] = {
    "groq": "openai/gpt-oss-20b",
    "openrouter": "nvidia/nemotron-3.5-lightning:free",
    "cloudflare": "@cf/meta/llama-3.1-8b-instruct-fp8",
}
_GROQ_FREE_PLAN_MODELS = frozenset(
    {
        "openai/gpt-oss-20b",
        "openai/gpt-oss-120b",
        "qwen/qwen3.6-27b",
        "qwen/qwen3.8-27b",
    }
)
_CLOUDFLARE_FREE_DEFAULTS = frozenset({NAMED_COMPATIBLE_DEFAULT_MODELS["cloudflare"]})
_CLOUDFLARE_ACCOUNT_ID = re.compile(r"^[0-9a-fA-F]{32}$")
_NAMED_COMPATIBLE_FIXED_BASE_URLS = {
    "groq": "https://api.groq.com/openai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
}
SUPPORTED_ONBOARDING_PROVIDERS = frozenset(
    {
        "openai",
        "anthropic",
        GEMINI_PROVIDER,
        "gemini",  # Product-facing alias accepted during contract migration.
        "xai",
        "mistral",
        "cohere",
        NVIDIA_NIM_PROVIDER,
        OPENAI_COMPATIBLE_PROVIDER,
        *NAMED_COMPATIBLE_PROVIDERS,
    }
)

_SAFE_MODEL_ID = re.compile(r"^[A-Za-z0-9@][A-Za-z0-9._:+/@-]*$")
_LIST_METHODS: dict[str, tuple[str, ...]] = {
    "openai": ("models.list",),
    "anthropic": ("models.list",),
    GEMINI_PROVIDER: ("aio.models.list", "models.list"),
    "xai": ("models.list",),
    "mistral": ("models.list_async", "models.list"),
    "cohere": ("models.list",),
    OPENAI_COMPATIBLE_PROVIDER: ("models.list",),
    "groq": ("models.list",),
    "openrouter": ("models.list",),
    "cloudflare": ("models.list", "list_models"),
}


class ProviderTestState(StrEnum):
    READY = "ready"
    DEGRADED = "degraded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ModelDiscoveryState(StrEnum):
    SUPPORTED = "supported"
    UNSUPPORTED = "unsupported"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class ProviderOnboardingDiagnostic:
    code: str
    message: str
    retryable: bool


@dataclass(frozen=True, slots=True)
class DiscoveredProviderModel:
    """Non-secret model metadata safe to return to a desktop renderer."""

    id: str
    model: str
    display_name: str
    capabilities: tuple[str, ...] = ()
    compatibility_verified: bool = False


@dataclass(frozen=True, slots=True)
class ProviderOnboardingResult:
    provider: str
    state: ProviderTestState
    discovery: ModelDiscoveryState
    models: tuple[DiscoveredProviderModel, ...]
    tested_at_ms: int
    latency_ms: int
    diagnostic: ProviderOnboardingDiagnostic | None = None
    filtered_models: int = 0
    unknown_compatibility: int = 0
    catalog_cached: bool = False


@dataclass(frozen=True, slots=True)
class ProviderOnboardingExecution:
    """Public result plus internal, non-secret evidence needed to commit it.

    The catalog evidence is deliberately excluded from the renderer result.
    Keeping it alongside the test result lets the registry commit the exact
    bounded NVIDIA snapshot that was already tested instead of issuing a
    second discovery request.
    """

    result: ProviderOnboardingResult
    nvidia_nim_catalog: NvidiaNimCatalogResult | None = field(default=None, repr=False)


@dataclass(slots=True)
class OnboardingCancellation:
    """Explicit cancellation owned by one in-progress provider test."""

    _event: asyncio.Event = field(default_factory=asyncio.Event, init=False, repr=False)

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def cancel(self) -> None:
        self._event.set()

    async def wait(self) -> None:
        await self._event.wait()


class ModelDiscoveryUnsupported(ProviderError):
    def __init__(self, provider: str):
        super().__init__(
            f"{_provider_label(provider)} does not expose supported model discovery.",
            code="model_discovery_unsupported",
            retryable=False,
        )


class _OnboardingCancelled(Exception):
    pass


@dataclass(slots=True)
class ProviderOnboardingService:
    """Test one lent credential and return a bounded, secret-free result."""

    max_models: int = MAX_DISCOVERED_MODELS
    max_catalog_bytes: int = MAX_CATALOG_BYTES
    nvidia_nim_discovery: NvidiaNimCatalogDiscovery = field(
        default_factory=NvidiaNimCatalogDiscovery
    )

    async def test_connection(
        self,
        provider: str,
        config: ProviderConfig,
        *,
        client: Any = None,
        cancellation: OnboardingCancellation | None = None,
        force_catalog_refresh: bool = False,
    ) -> ProviderOnboardingResult:
        """Test authentication and discover models without persisting secrets.

        ``client`` is an injection seam for deterministic fixtures. Production
        callers normally omit it and use the packaged provider SDK.
        """

        execution = await self.test_connection_with_evidence(
            provider,
            config,
            client=client,
            cancellation=cancellation,
            force_catalog_refresh=force_catalog_refresh,
        )
        return execution.result

    async def test_connection_with_evidence(
        self,
        provider: str,
        config: ProviderConfig,
        *,
        client: Any = None,
        cancellation: OnboardingCancellation | None = None,
        force_catalog_refresh: bool = False,
    ) -> ProviderOnboardingExecution:
        """Run one test and retain only non-secret evidence required to commit it."""

        started = time.monotonic()
        tested_at_ms = int(time.time() * 1000)
        normalized_provider = _normalize_provider(provider)
        result_provider = (
            normalized_provider
            if normalized_provider in SUPPORTED_ONBOARDING_PROVIDERS
            else "unknown"
        )
        try:
            if normalized_provider not in SUPPORTED_ONBOARDING_PROVIDERS:
                raise ProviderError(
                    "This provider is not supported by CupcakeAI onboarding.",
                    code="unsupported_provider",
                )
            if not config.api_key:
                raise MissingProviderCredential(
                    normalized_provider, f"{_provider_label(normalized_provider)} API key"
                )
            if cancellation is not None and cancellation.cancelled:
                raise _OnboardingCancelled

            if normalized_provider == OPENAI_COMPATIBLE_PROVIDER:
                validate_remote_openai_compatible_endpoint(config.base_url or "")
            elif normalized_provider in NAMED_COMPATIBLE_PROVIDERS:
                validate_named_compatible_config(normalized_provider, config)

            if normalized_provider == NVIDIA_NIM_PROVIDER:
                catalog = await _await_or_cancel(
                    self.nvidia_nim_discovery.discover(
                        config,
                        client=client,
                        force=force_catalog_refresh,
                    ),
                    cancellation,
                )
                return ProviderOnboardingExecution(
                    result=self._nim_success(
                        normalized_provider,
                        catalog,
                        tested_at_ms,
                        started,
                        config.api_key,
                    ),
                    nvidia_nim_catalog=catalog,
                )

            resolved_client = client or create_onboarding_client(normalized_provider, config)
            try:
                models = await _await_or_cancel(
                    self._discover(normalized_provider, resolved_client), cancellation
                )
                if normalized_provider in NAMED_COMPATIBLE_PROVIDERS:
                    models = _named_compatible_models(normalized_provider, models)
            except ModelDiscoveryUnsupported as error:
                return ProviderOnboardingExecution(
                    ProviderOnboardingResult(
                        provider=normalized_provider,
                        state=ProviderTestState.DEGRADED,
                        discovery=ModelDiscoveryState.UNSUPPORTED,
                        models=(),
                        tested_at_ms=tested_at_ms,
                        latency_ms=_elapsed_ms(started),
                        diagnostic=ProviderOnboardingDiagnostic(
                            error.code, str(error), error.retryable
                        ),
                    ),
                )
            return ProviderOnboardingExecution(
                ProviderOnboardingResult(
                    provider=normalized_provider,
                    state=ProviderTestState.READY,
                    discovery=ModelDiscoveryState.SUPPORTED,
                    models=_without_secret(models, config.api_key),
                    tested_at_ms=tested_at_ms,
                    latency_ms=_elapsed_ms(started),
                )
            )
        except _OnboardingCancelled:
            return ProviderOnboardingExecution(
                ProviderOnboardingResult(
                    provider=result_provider,
                    state=ProviderTestState.CANCELLED,
                    discovery=ModelDiscoveryState.FAILED,
                    models=(),
                    tested_at_ms=tested_at_ms,
                    latency_ms=_elapsed_ms(started),
                    diagnostic=ProviderOnboardingDiagnostic(
                        "cancelled", "The provider connection test was cancelled.", False
                    ),
                ),
            )
        except Exception as error:
            classified = classify_provider_error(error)
            return ProviderOnboardingExecution(
                ProviderOnboardingResult(
                    provider=result_provider,
                    state=ProviderTestState.FAILED,
                    discovery=ModelDiscoveryState.FAILED,
                    models=(),
                    tested_at_ms=tested_at_ms,
                    latency_ms=_elapsed_ms(started),
                    diagnostic=ProviderOnboardingDiagnostic(
                        classified.code, classified.message, classified.retryable
                    ),
                ),
            )

    async def _discover(self, provider: str, client: Any) -> tuple[DiscoveredProviderModel, ...]:
        list_models = _resolve_callable(client, _LIST_METHODS.get(provider, ()))
        if list_models is None:
            raise ModelDiscoveryUnsupported(provider)
        response = list_models()
        if inspect.isawaitable(response):
            response = await response
        return await _bounded_models(
            response,
            max_models=self.max_models,
            max_catalog_bytes=self.max_catalog_bytes,
        )

    def _nim_success(
        self,
        provider: str,
        catalog: NvidiaNimCatalogResult,
        tested_at_ms: int,
        started: float,
        credential: str,
    ) -> ProviderOnboardingResult:
        return ProviderOnboardingResult(
            provider=provider,
            state=ProviderTestState.READY,
            discovery=ModelDiscoveryState.SUPPORTED,
            models=_without_secret(
                tuple(_nim_model(model) for model in catalog.models), credential
            ),
            tested_at_ms=tested_at_ms,
            latency_ms=_elapsed_ms(started),
            filtered_models=catalog.filtered_non_chat,
            unknown_compatibility=catalog.unknown_chat_compatibility,
            catalog_cached=catalog.cached,
        )


def validate_remote_openai_compatible_endpoint(value: str) -> str:
    """Validate and normalize one credential-free public HTTPS base URL.

    Literal private addresses are rejected without DNS resolution. The trusted
    Rust boundary must repeat this check and apply its own DNS/rebinding policy
    immediately before a request.
    """

    if not value or len(value) > 4096 or any(char.isspace() or ord(char) < 32 for char in value):
        raise ProviderError(
            "OpenAI-compatible endpoint must be a valid public HTTPS URL.",
            code="invalid_endpoint",
        )
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise ProviderError(
            "OpenAI-compatible endpoint must be a valid public HTTPS URL.",
            code="invalid_endpoint",
        ) from error
    host = (parsed.hostname or "").rstrip(".").casefold()
    if (
        parsed.scheme.casefold() != "https"
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or "\\" in value
    ):
        raise ProviderError(
            "OpenAI-compatible endpoint must be credential-free public HTTPS.",
            code="invalid_endpoint",
        )
    if host == "localhost" or host.endswith((".localhost", ".local")):
        raise ProviderError(
            "OpenAI-compatible endpoint cannot use a local address.",
            code="invalid_endpoint",
        )
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ProviderError(
            "OpenAI-compatible endpoint cannot use a private or local address.",
            code="invalid_endpoint",
        )
    try:
        ascii_host = host.encode("idna").decode("ascii")
    except UnicodeError as error:
        raise ProviderError(
            "OpenAI-compatible endpoint hostname is invalid.",
            code="invalid_endpoint",
        ) from error
    normalized_host = f"[{ascii_host}]" if ":" in ascii_host else ascii_host
    netloc = normalized_host if port is None else f"{normalized_host}:{port}"
    path = parsed.path.rstrip("/") or "/"
    return urlunsplit(SplitResult("https", netloc, path, "", ""))


def named_compatible_base_url(provider: str, account_id: str | None = None) -> str:
    """Return the immutable first-party endpoint for one named compatible preset."""

    normalized = provider.strip().casefold()
    fixed = _NAMED_COMPATIBLE_FIXED_BASE_URLS.get(normalized)
    if fixed is not None:
        return fixed
    if normalized != "cloudflare":
        raise ProviderError("Unknown compatible provider preset.", code="unsupported_provider")
    value = (account_id or "").strip()
    if _CLOUDFLARE_ACCOUNT_ID.fullmatch(value) is None:
        raise ProviderError(
            "Cloudflare Account ID must be the 32-character identifier from Workers AI.",
            code="invalid_account_id",
        )
    return f"https://api.cloudflare.com/client/v4/accounts/{value}/ai/v1"


def validate_named_compatible_config(provider: str, config: ProviderConfig) -> str:
    expected = named_compatible_base_url(provider, config.account_id)
    if config.base_url is not None:
        supplied = validate_remote_openai_compatible_endpoint(config.base_url)
        if supplied.rstrip("/") != expected:
            raise ProviderError(
                f"{_provider_label(provider)} uses a fixed first-party endpoint.",
                code="invalid_endpoint",
            )
    return expected


def named_compatible_model_allowed(provider: str, model_id: str) -> bool:
    """Restrict convenience presets to explicit zero-cost/free-allocation routes."""

    normalized = provider.strip().casefold()
    model = model_id.strip()
    if normalized == "groq":
        return model in _GROQ_FREE_PLAN_MODELS
    if normalized == "openrouter":
        return model == "openrouter/free" or model.endswith(":free")
    if normalized == "cloudflare":
        return model in _CLOUDFLARE_FREE_DEFAULTS
    return False


def _named_compatible_models(
    provider: str, models: tuple[DiscoveredProviderModel, ...]
) -> tuple[DiscoveredProviderModel, ...]:
    safe = tuple(model for model in models if named_compatible_model_allowed(provider, model.model))
    if not safe:
        raise ProviderError(
            f"{_provider_label(provider)} did not return a supported free model.",
            code="free_model_unavailable",
            retryable=True,
        )
    return tuple(
        replace(
            model,
            capabilities=("streaming",),
            compatibility_verified=True,
        )
        for model in safe
    )


async def _await_or_cancel(
    operation: Awaitable[Any], cancellation: OnboardingCancellation | None
) -> Any:
    if cancellation is None:
        return await operation
    operation_task = asyncio.ensure_future(operation)
    if cancellation.cancelled:
        operation_task.cancel()
        with suppress(asyncio.CancelledError):
            await operation_task
        raise _OnboardingCancelled
    cancellation_task = asyncio.create_task(cancellation.wait())
    try:
        done, _ = await asyncio.wait(
            {operation_task, cancellation_task}, return_when=asyncio.FIRST_COMPLETED
        )
        if cancellation_task in done:
            operation_task.cancel()
            with suppress(asyncio.CancelledError):
                await operation_task
            raise _OnboardingCancelled
        cancellation_task.cancel()
        with suppress(asyncio.CancelledError):
            await cancellation_task
        return await operation_task
    finally:
        if not operation_task.done():
            operation_task.cancel()
            with suppress(asyncio.CancelledError):
                await operation_task
        if not cancellation_task.done():
            cancellation_task.cancel()
            with suppress(asyncio.CancelledError):
                await cancellation_task


async def _bounded_models(
    response: Any, *, max_models: int, max_catalog_bytes: int
) -> tuple[DiscoveredProviderModel, ...]:
    discovered: dict[str, DiscoveredProviderModel] = {}
    total_bytes = 0
    scanned_records = 0

    def accept(record: Any) -> None:
        nonlocal scanned_records, total_bytes
        scanned_records += 1
        if scanned_records > max_models:
            raise ProviderError(
                "The provider returned more models than the safety limit.",
                code="oversized_model_catalog",
            )
        model = _normalize_model(record)
        if model is None or model.id in discovered:
            return
        total_bytes += len(model.id.encode("utf-8")) + len(model.display_name.encode("utf-8"))
        if total_bytes > max_catalog_bytes:
            raise ProviderError(
                "The provider returned a model catalog larger than the safety limit.",
                code="oversized_model_catalog",
            )
        discovered[model.id] = model

    page = response
    seen_pages: set[int] = set()
    while True:
        page_identity = id(page)
        if page_identity in seen_pages:
            raise ProviderError(
                "The provider returned a cyclic model catalog.",
                code="invalid_model_catalog",
            )
        seen_pages.add(page_identity)
        records = _response_records(page)
        if isinstance(records, AsyncIterable):
            async for item in records:
                accept(item)
        else:
            for item in records:
                accept(item)
        next_page = await _next_model_page(page)
        if next_page is None:
            break
        page = next_page
    return tuple(sorted(discovered.values(), key=lambda item: item.display_name.casefold()))


async def _next_model_page(page: Any) -> Any | None:
    """Follow SDK page objects without assuming one provider's cursor schema."""

    get_next = getattr(page, "get_next_page", None)
    if not callable(get_next):
        return None
    has_next = getattr(page, "has_next_page", None)
    if callable(has_next):
        has_next = has_next()
        if inspect.isawaitable(has_next):
            has_next = await has_next
    if has_next is False:
        return None
    next_page = get_next()
    if inspect.isawaitable(next_page):
        next_page = await next_page
    return next_page


def _response_records(response: Any) -> Iterable[Any] | AsyncIterable[Any]:
    direct_collection = _as_model_collection(response)
    if isinstance(direct_collection, AsyncIterable):
        return direct_collection
    if isinstance(response, Mapping):
        response_map = cast(Mapping[str, Any], response)
        for key in ("data", "models", "items", "result"):
            collection = _as_model_collection(response_map.get(key))
            if collection is not None:
                return collection
    response_object = cast(Any, response)
    for name in ("data", "models", "items", "result"):
        collection = _as_model_collection(getattr(response_object, name, None))
        if collection is not None:
            return collection
    if direct_collection is not None:
        return direct_collection
    raise ProviderError(
        "The provider returned an invalid model catalog.",
        code="invalid_model_catalog",
    )


def _as_model_collection(value: Any) -> Iterable[Any] | AsyncIterable[Any] | None:
    if hasattr(value, "__aiter__"):
        return cast(AsyncIterable[Any], value)
    if isinstance(value, Iterable) and not isinstance(value, (str, bytes, bytearray, Mapping)):
        return cast(Iterable[Any], value)
    return None


def _normalize_model(record: Any) -> DiscoveredProviderModel | None:
    model_id: str | None
    display_name: str | None
    if isinstance(record, str):
        model_id = record
        display_name = record
    elif isinstance(record, Mapping):
        record_map = cast(Mapping[str, Any], record)
        model_id = _first_string(record_map, "id", "model", "name")
        display_name = _first_string(record_map, "display_name", "displayName", "name") or model_id
    else:
        model_id = _first_attribute(record, "id", "model", "name")
        display_name = _first_attribute(record, "display_name", "displayName", "name") or model_id
    if not model_id:
        return None
    model_id = model_id.strip()
    if (
        not model_id
        or len(model_id) > MAX_MODEL_ID_LENGTH
        or _SAFE_MODEL_ID.fullmatch(model_id) is None
    ):
        return None
    safe_display = (display_name or model_id).strip()[:256] or model_id
    return DiscoveredProviderModel(model_id, model_id, safe_display)


def _first_string(value: Mapping[Any, Any], *names: str) -> str | None:
    for name in names:
        candidate = value.get(name)
        if isinstance(candidate, str):
            return candidate
    return None


def _first_attribute(value: Any, *names: str) -> str | None:
    for name in names:
        candidate = getattr(value, name, None)
        if isinstance(candidate, str):
            return candidate
    return None


def _nim_model(descriptor: ModelDescriptor) -> DiscoveredProviderModel:
    compatibility = descriptor.metadata.get("chat_compatibility")
    return DiscoveredProviderModel(
        id=descriptor.id,
        model=descriptor.model,
        display_name=descriptor.display_name,
        capabilities=_capabilities(descriptor.capabilities),
        compatibility_verified=compatibility == "chat",
    )


def _capabilities(value: ModelCapabilities) -> tuple[str, ...]:
    names = (
        ("streaming", value.streaming),
        ("tools", value.tools),
        ("images", value.images),
        ("documents", value.documents),
        ("citations", value.citations),
        ("reasoning", value.reasoning),
        ("structured-output", value.structured_output),
    )
    return tuple(name for name, enabled in names if enabled)


def _without_secret(
    models: tuple[DiscoveredProviderModel, ...], credential: str
) -> tuple[DiscoveredProviderModel, ...]:
    """Fail closed if a provider reflects credential bytes into catalog metadata."""

    if not credential:
        return models
    return tuple(
        model
        for model in models
        if credential not in model.id
        and credential not in model.model
        and credential not in model.display_name
    )


def _resolve_callable(client: Any, paths: Sequence[str]) -> Callable[[], Any] | None:
    for path in paths:
        value = client
        for segment in path.split("."):
            value = getattr(value, segment, None)
            if value is None:
                break
        if callable(value):
            return cast(Callable[[], Any], value)
    return None


@dataclass(frozen=True, slots=True)
class _CloudflareModelsClient:
    api_key: str
    account_id: str
    timeout_seconds: float

    async def list_models(self) -> Mapping[str, Any]:
        try:
            import httpx
        except ImportError as error:
            raise MissingProviderDependency("cloudflare", "httpx") from error
        url = f"https://api.cloudflare.com/client/v4/accounts/{self.account_id}/ai/models/search"
        async with httpx.AsyncClient(
            timeout=self.timeout_seconds,
            follow_redirects=False,
        ) as client:
            response = await client.get(
                url,
                headers={"Authorization": f"Bearer {self.api_key}"},
                params={
                    "search": NAMED_COMPATIBLE_DEFAULT_MODELS["cloudflare"].rsplit("/", 1)[-1],
                    "hide_experimental": "true",
                    "include_deprecated": "false",
                    # Cloudflare documents 100 as the maximum page size.
                    "per_page": "100",
                },
            )
            response.raise_for_status()
            payload = response.json()
        if not isinstance(payload, Mapping):
            raise ProviderError(
                "Cloudflare returned an invalid Workers AI model catalog.",
                code="invalid_model_catalog",
            )
        payload_map = cast(Mapping[str, Any], payload)
        if payload_map.get("success") is not True:
            raise ProviderError(
                "Cloudflare returned an invalid Workers AI model catalog.",
                code="invalid_model_catalog",
            )
        return normalize_cloudflare_model_search(payload_map)


def normalize_cloudflare_model_search(payload: Mapping[str, Any]) -> Mapping[str, Any]:
    """Expose invocable Workers AI names instead of opaque catalog record IDs."""

    records = payload.get("result")
    if not isinstance(records, list):
        raise ProviderError(
            "Cloudflare returned an invalid Workers AI model catalog.",
            code="invalid_model_catalog",
        )
    normalized: list[dict[str, str]] = []
    for record in cast(list[Any], records):
        if not isinstance(record, Mapping):
            continue
        record_map = cast(Mapping[str, Any], record)
        name = record_map.get("name")
        if isinstance(name, str) and name.startswith("@cf/"):
            normalized.append({"id": name, "name": name})
    return {"data": normalized}


def create_onboarding_client(provider: str, config: ProviderConfig) -> Any:
    if provider == "cloudflare":
        account_id = (config.account_id or "").strip()
        named_compatible_base_url(provider, account_id)
        return _CloudflareModelsClient(
            api_key=config.api_key or "",
            account_id=account_id,
            timeout_seconds=config.timeout_seconds,
        )
    if provider in {
        "openai",
        "xai",
        OPENAI_COMPATIBLE_PROVIDER,
        "groq",
        "openrouter",
    }:
        try:
            from openai import AsyncOpenAI
        except ImportError as error:
            raise MissingProviderDependency(provider, "openai") from error
        base_url = config.base_url
        if provider == "xai":
            base_url = base_url or "https://api.x.ai/v1"
        elif provider == OPENAI_COMPATIBLE_PROVIDER:
            base_url = validate_remote_openai_compatible_endpoint(config.base_url or "")
        elif provider in NAMED_COMPATIBLE_PROVIDERS:
            base_url = validate_named_compatible_config(provider, config)
        options: dict[str, Any] = {
            "api_key": config.api_key,
            "timeout": config.timeout_seconds,
            "default_headers": dict(config.headers or {}),
        }
        if base_url:
            options["base_url"] = base_url
        if provider == "openai" and config.organization:
            options["organization"] = config.organization
        return AsyncOpenAI(**options)
    if provider == "anthropic":
        try:
            from anthropic import AsyncAnthropic
        except ImportError as error:
            raise MissingProviderDependency(provider, "anthropic") from error
        return AsyncAnthropic(
            api_key=config.api_key,
            base_url=config.base_url,
            timeout=config.timeout_seconds,
        )
    if provider == GEMINI_PROVIDER:
        try:
            from google import genai
        except ImportError as error:
            raise MissingProviderDependency(provider, "google-genai") from error
        return genai.Client(
            api_key=config.api_key,
            http_options={"base_url": config.base_url} if config.base_url else None,
        )
    if provider == "mistral":
        try:
            from mistralai.client import Mistral
        except ImportError as error:
            raise MissingProviderDependency(provider, "mistralai") from error
        return Mistral(api_key=config.api_key, server_url=config.base_url)
    if provider == "cohere":
        try:
            from cohere import AsyncClientV2
        except ImportError as error:
            raise MissingProviderDependency(provider, "cohere") from error
        return AsyncClientV2(
            api_key=config.api_key,
            base_url=config.base_url,
            timeout=config.timeout_seconds,
        )
    raise ProviderError(
        "This provider is not supported by CupcakeAI onboarding.",
        code="unsupported_provider",
    )


def _normalize_provider(provider: str) -> str:
    normalized = provider.strip().casefold()
    return GEMINI_PROVIDER if normalized == "gemini" else normalized


def _provider_label(provider: str) -> str:
    return {
        "openai": "OpenAI",
        "anthropic": "Anthropic",
        GEMINI_PROVIDER: "Google Gemini",
        "xai": "xAI",
        "mistral": "Mistral",
        "cohere": "Cohere",
        NVIDIA_NIM_PROVIDER: "NVIDIA NIM",
        OPENAI_COMPATIBLE_PROVIDER: "OpenAI-compatible endpoint",
        "groq": "Groq",
        "openrouter": "OpenRouter",
        "cloudflare": "Cloudflare Workers AI",
    }.get(provider, "Provider")


def _elapsed_ms(started: float) -> int:
    return max(0, int((time.monotonic() - started) * 1000))
