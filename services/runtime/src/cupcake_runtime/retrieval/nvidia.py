from __future__ import annotations

import asyncio
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from hashlib import sha256
from typing import Any, Never, Protocol
from urllib.parse import urlsplit

from .models import (
    CloudEmbeddingDisclosure,
    DestinationKind,
    EmbeddingInputType,
    EmbeddingModelDescriptor,
)

NVIDIA_PROVIDER_ID = "nvidia-nim"
NVIDIA_CREDENTIAL_ACCOUNT = "provider.nvidia-nim.api-key"
NVIDIA_EMBEDDINGS_ENDPOINT = "https://integrate.api.nvidia.com/v1/embeddings"
NVIDIA_RERANK_INTERFACE_VERSION = "cupcake.rerank.v1"


class NvidiaRetrievalCapability(StrEnum):
    EMBEDDING = "embedding"
    RERANK = "rerank"


class NvidiaTruncate(StrEnum):
    NONE = "NONE"
    START = "START"
    END = "END"


@dataclass(frozen=True, slots=True)
class NvidiaCatalogProvenance:
    """Evidence from a dynamically refreshed catalog, never a free-tier promise."""

    source_url: str
    fetched_at: datetime
    catalog_version: str

    def __post_init__(self) -> None:
        parts = urlsplit(self.source_url)
        if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
            raise ValueError("NVIDIA catalog provenance must use an HTTPS source")
        if not self.catalog_version.strip():
            raise ValueError("NVIDIA catalog provenance requires a version")
        if self.fetched_at.tzinfo is None:
            raise ValueError("NVIDIA catalog fetched_at must be timezone-aware")


@dataclass(frozen=True, slots=True)
class NvidiaEmbeddingModelSpec:
    model_id: str
    model_version: str
    dimensions: int
    batch_limit: int
    provenance: NvidiaCatalogProvenance
    truncate: NvidiaTruncate = NvidiaTruncate.NONE

    def __post_init__(self) -> None:
        if not self.model_id.strip() or not self.model_version.strip():
            raise ValueError("NVIDIA embedding model id and version are required")
        if not 1 <= self.dimensions <= 65_536:
            raise ValueError("NVIDIA embedding dimensions must be between 1 and 65536")
        if not 1 <= self.batch_limit <= 512:
            raise ValueError("NVIDIA embedding batch_limit must be between 1 and 512")

    @property
    def descriptor(self) -> EmbeddingModelDescriptor:
        return EmbeddingModelDescriptor(
            provider_id=NVIDIA_PROVIDER_ID,
            model_id=self.model_id,
            model_version=self.model_version,
            dimensions=self.dimensions,
            destination=DestinationKind.CLOUD,
            disclosure=(
                "Sends project-filtered query or passage text to NVIDIA NIM's hosted "
                "retrieval API for embedding."
            ),
        )


@dataclass(frozen=True, slots=True)
class NvidiaRerankModelSpec:
    model_id: str
    model_version: str
    endpoint_url: str
    batch_limit: int
    provenance: NvidiaCatalogProvenance
    truncate: NvidiaTruncate = NvidiaTruncate.END
    interface_version: str = NVIDIA_RERANK_INTERFACE_VERSION

    def __post_init__(self) -> None:
        if not self.model_id.strip() or not self.model_version.strip():
            raise ValueError("NVIDIA rerank model id and version are required")
        if not 1 <= self.batch_limit <= 512:
            raise ValueError("NVIDIA rerank batch_limit must be between 1 and 512")
        if self.truncate not in {NvidiaTruncate.NONE, NvidiaTruncate.END}:
            raise ValueError("NVIDIA reranking supports only NONE or END truncation")
        if self.interface_version != NVIDIA_RERANK_INTERFACE_VERSION:
            raise ValueError("unsupported CUPCAKEAGI rerank interface version")
        _validate_rerank_endpoint(self.endpoint_url)

    @property
    def fingerprint(self) -> str:
        value = (
            f"{NVIDIA_PROVIDER_ID}\0{self.model_id}\0{self.model_version}\0"
            f"{self.endpoint_url}\0{self.interface_version}"
        )
        return sha256(value.encode()).hexdigest()


@dataclass(frozen=True, slots=True)
class CloudRerankDisclosure:
    project_id: str
    provider_id: str
    model_id: str
    acknowledged: bool
    acknowledged_at: datetime


@dataclass(frozen=True, slots=True)
class NvidiaRerankCandidate:
    document_id: str
    project_id: str
    source_kind: str
    text: str


@dataclass(frozen=True, slots=True)
class NvidiaRerankScore:
    document_id: str
    rank: int
    logit: float


@dataclass(frozen=True, slots=True)
class NvidiaRerankResult:
    interface_version: str
    provider_id: str
    model_id: str
    model_version: str
    model_fingerprint: str
    catalog_source: str
    scores: tuple[NvidiaRerankScore, ...]


class NvidiaRetrievalError(RuntimeError):
    def __init__(self, message: str, *, code: str, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class NvidiaRetrievalTransport(Protocol):
    """Broker-capable HTTP boundary; implementations attach the vault credential.

    Python passes only the stable vault account identifier. A broker transport can
    execute the request without returning credential bytes to Python. A temporary
    in-process adapter may resolve the account per request, but must never persist it.
    """

    async def post_json(
        self,
        url: str,
        payload: Mapping[str, Any],
        *,
        credential_account: str,
        cancellation: asyncio.Event | None,
    ) -> Mapping[str, Any]: ...


class NvidiaHostedEmbeddingProvider:
    def __init__(
        self,
        spec: NvidiaEmbeddingModelSpec,
        transport: NvidiaRetrievalTransport,
    ) -> None:
        self.spec = spec
        self._transport = transport

    @property
    def descriptor(self) -> EmbeddingModelDescriptor:
        return self.spec.descriptor

    async def embed(
        self,
        texts: Sequence[str],
        *,
        input_type: EmbeddingInputType = EmbeddingInputType.PASSAGE,
        project_id: str | None = None,
        disclosure: CloudEmbeddingDisclosure | None = None,
        cancellation: asyncio.Event | None = None,
    ) -> Sequence[Sequence[float]]:
        self._authorize(project_id, disclosure)
        if any(not text.strip() for text in texts):
            raise ValueError("NVIDIA embedding inputs must not be blank")
        vectors: list[tuple[float, ...]] = []
        for start in range(0, len(texts), self.spec.batch_limit):
            _check_cancelled(cancellation)
            batch = texts[start : start + self.spec.batch_limit]
            payload: dict[str, Any] = {
                "model": self.spec.model_id,
                "input": list(batch),
                "input_type": input_type.value,
                "encoding_format": "float",
                "truncate": self.spec.truncate.value,
            }
            response = await _safe_post(
                self._transport,
                NVIDIA_EMBEDDINGS_ENDPOINT,
                payload,
                cancellation=cancellation,
            )
            _check_cancelled(cancellation)
            vectors.extend(_parse_embeddings(response, len(batch), self.spec.dimensions))
        return tuple(vectors)

    def _authorize(
        self,
        project_id: str | None,
        disclosure: CloudEmbeddingDisclosure | None,
    ) -> None:
        if (
            not project_id
            or disclosure is None
            or not disclosure.acknowledged
            or disclosure.project_id != project_id
            or disclosure.provider_id != NVIDIA_PROVIDER_ID
            or disclosure.model_id != self.spec.model_id
        ):
            raise NvidiaRetrievalError(
                "NVIDIA embeddings require an explicit matching project/provider/model disclosure.",
                code="cloud_disclosure_required",
                retryable=False,
            )


class NvidiaHostedReranker:
    def __init__(self, spec: NvidiaRerankModelSpec, transport: NvidiaRetrievalTransport) -> None:
        self.spec = spec
        self._transport = transport

    async def arerank(
        self,
        query: str,
        candidates: Sequence[NvidiaRerankCandidate],
        *,
        project_id: str,
        disclosure: CloudRerankDisclosure | None,
        cancellation: asyncio.Event | None = None,
    ) -> NvidiaRerankResult:
        if not project_id.strip():
            raise ValueError("project_id is required before NVIDIA reranking")
        if not query.strip():
            raise ValueError("rerank query must not be blank")
        if any(candidate.project_id != project_id for candidate in candidates):
            raise NvidiaRetrievalError(
                "Cross-project candidates were rejected before NVIDIA reranking.",
                code="privacy_boundary",
                retryable=False,
            )
        if len({candidate.document_id for candidate in candidates}) != len(candidates):
            raise ValueError("rerank candidate document ids must be unique")
        if any(not candidate.text.strip() for candidate in candidates):
            raise ValueError("rerank candidate text must not be blank")
        self._authorize(project_id, disclosure)
        logits: dict[str, float] = {}
        for start in range(0, len(candidates), self.spec.batch_limit):
            _check_cancelled(cancellation)
            batch = candidates[start : start + self.spec.batch_limit]
            payload: dict[str, Any] = {
                "model": self.spec.model_id,
                "query": {"text": query},
                "passages": [{"text": candidate.text} for candidate in batch],
                "truncate": self.spec.truncate.value,
            }
            response = await _safe_post(
                self._transport,
                self.spec.endpoint_url,
                payload,
                cancellation=cancellation,
            )
            _check_cancelled(cancellation)
            for local_index, logit in _parse_rankings(response, len(batch)):
                logits[batch[local_index].document_id] = logit
        ordered = sorted(logits.items(), key=lambda item: (-item[1], item[0]))
        return NvidiaRerankResult(
            interface_version=self.spec.interface_version,
            provider_id=NVIDIA_PROVIDER_ID,
            model_id=self.spec.model_id,
            model_version=self.spec.model_version,
            model_fingerprint=self.spec.fingerprint,
            catalog_source=self.spec.provenance.source_url,
            scores=tuple(
                NvidiaRerankScore(document_id, rank, logit)
                for rank, (document_id, logit) in enumerate(ordered)
            ),
        )

    def _authorize(self, project_id: str, disclosure: CloudRerankDisclosure | None) -> None:
        if (
            disclosure is None
            or not disclosure.acknowledged
            or disclosure.project_id != project_id
            or disclosure.provider_id != NVIDIA_PROVIDER_ID
            or disclosure.model_id != self.spec.model_id
        ):
            raise NvidiaRetrievalError(
                "NVIDIA reranking requires an explicit matching project/provider/model disclosure.",
                code="cloud_disclosure_required",
                retryable=False,
            )


async def _safe_post(
    transport: NvidiaRetrievalTransport,
    url: str,
    payload: Mapping[str, Any],
    *,
    cancellation: asyncio.Event | None,
) -> Mapping[str, Any]:
    try:
        return await transport.post_json(
            url,
            payload,
            credential_account=NVIDIA_CREDENTIAL_ACCOUNT,
            cancellation=cancellation,
        )
    except asyncio.CancelledError:
        raise
    except NvidiaRetrievalError:
        raise
    except Exception as exc:
        status = getattr(exc, "status_code", None)
        if status in {401, 403}:
            raise NvidiaRetrievalError(
                "NVIDIA rejected the configured credential.",
                code="authentication_failed",
                retryable=False,
            ) from None
        if status == 429:
            raise NvidiaRetrievalError(
                "NVIDIA retrieval rate limit was exceeded.",
                code="rate_limit",
                retryable=True,
            ) from None
        if isinstance(status, int) and status >= 500:
            raise NvidiaRetrievalError(
                "NVIDIA retrieval is temporarily unavailable.",
                code="provider_unavailable",
                retryable=True,
            ) from None
        raise NvidiaRetrievalError(
            f"NVIDIA retrieval failed ({type(exc).__name__}).",
            code="provider_error",
            retryable=False,
        ) from None


def _parse_embeddings(
    response: Mapping[str, Any], expected: int, dimensions: int
) -> tuple[tuple[float, ...], ...]:
    data = response.get("data")
    if not isinstance(data, Sequence) or isinstance(data, (str, bytes)):
        raise NvidiaRetrievalError(
            "NVIDIA returned a malformed embedding response.",
            code="malformed_provider_response",
            retryable=False,
        )
    by_index: dict[int, tuple[float, ...]] = {}
    for item in data:
        if not isinstance(item, Mapping):
            _malformed_embedding()
        index = item.get("index")
        raw = item.get("embedding")
        if (
            not isinstance(index, int)
            or isinstance(index, bool)
            or not isinstance(raw, Sequence)
            or isinstance(raw, (str, bytes))
        ):
            _malformed_embedding()
        try:
            vector = tuple(float(value) for value in raw)
        except (TypeError, ValueError):
            _malformed_embedding()
        if len(vector) != dimensions or not all(math.isfinite(value) for value in vector):
            _malformed_embedding()
        if index in by_index:
            _malformed_embedding()
        by_index[index] = vector
    if set(by_index) != set(range(expected)):
        _malformed_embedding()
    return tuple(by_index[index] for index in range(expected))


def _malformed_embedding() -> Never:
    raise NvidiaRetrievalError(
        "NVIDIA returned a malformed embedding response.",
        code="malformed_provider_response",
        retryable=False,
    )


def _parse_rankings(response: Mapping[str, Any], expected: int) -> tuple[tuple[int, float], ...]:
    rankings = response.get("rankings")
    if not isinstance(rankings, Sequence) or isinstance(rankings, (str, bytes)):
        return _malformed_rankings()
    parsed: dict[int, float] = {}
    for item in rankings:
        if not isinstance(item, Mapping):
            return _malformed_rankings()
        index = item.get("index")
        logit = item.get("logit")
        if (
            not isinstance(index, int)
            or isinstance(logit, bool)
            or not isinstance(logit, (int, float))
        ):
            return _malformed_rankings()
        score = float(logit)
        if index in parsed or not math.isfinite(score):
            return _malformed_rankings()
        parsed[index] = score
    if set(parsed) != set(range(expected)):
        return _malformed_rankings()
    return tuple(parsed.items())


def _malformed_rankings() -> tuple[tuple[int, float], ...]:
    raise NvidiaRetrievalError(
        "NVIDIA returned a malformed reranking response.",
        code="malformed_provider_response",
        retryable=False,
    )


def _check_cancelled(cancellation: asyncio.Event | None) -> None:
    if cancellation is not None and cancellation.is_set():
        raise asyncio.CancelledError


def _validate_rerank_endpoint(value: str) -> None:
    parts = urlsplit(value)
    if (
        parts.scheme != "https"
        or parts.username
        or parts.password
        or parts.port not in {None, 443}
        or parts.query
        or parts.fragment
    ):
        raise ValueError("NVIDIA rerank endpoint must be a fixed HTTPS URL")
    hostname = (parts.hostname or "").casefold()
    integrate = hostname == "integrate.api.nvidia.com" and parts.path == "/v1/ranking"
    retrieval = (
        hostname == "ai.api.nvidia.com"
        and parts.path.startswith("/v1/retrieval/")
        and parts.path.endswith("/reranking")
    )
    if not (integrate or retrieval):
        raise ValueError("NVIDIA rerank endpoint is outside the allowed hosted retrieval routes")


def current_catalog_provenance(source_url: str, catalog_version: str) -> NvidiaCatalogProvenance:
    """Convenience for catalog adapters; availability must still come from live discovery."""
    return NvidiaCatalogProvenance(source_url, datetime.now(UTC), catalog_version)


def embedding_disclosure(
    *, project_id: str, model_id: str, acknowledged: bool
) -> CloudEmbeddingDisclosure:
    return CloudEmbeddingDisclosure(
        project_id=project_id,
        provider_id=NVIDIA_PROVIDER_ID,
        model_id=model_id,
        acknowledged=acknowledged,
    )
