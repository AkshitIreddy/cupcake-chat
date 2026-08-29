from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

import pytest

from cupcake_runtime.retrieval import (
    NVIDIA_CREDENTIAL_ACCOUNT,
    NVIDIA_EMBEDDINGS_ENDPOINT,
    NVIDIA_PROVIDER_ID,
    NVIDIA_RERANK_INTERFACE_VERSION,
    CloudRerankDisclosure,
    EmbeddingInputType,
    NvidiaCatalogProvenance,
    NvidiaEmbeddingModelSpec,
    NvidiaHostedEmbeddingProvider,
    NvidiaHostedReranker,
    NvidiaRerankCandidate,
    NvidiaRerankModelSpec,
    NvidiaRetrievalError,
    NvidiaTruncate,
    embedding_disclosure,
)


class RecordedTransport:
    def __init__(
        self,
        fixtures: Sequence[Mapping[str, Any] | Exception],
        *,
        cancel_after: int | None = None,
    ) -> None:
        self.fixtures = list(fixtures)
        self.requests: list[tuple[str, Mapping[str, Any], str]] = []
        self.cancel_after = cancel_after

    async def post_json(
        self,
        url: str,
        payload: Mapping[str, Any],
        *,
        credential_account: str,
        cancellation: asyncio.Event | None,
    ) -> Mapping[str, Any]:
        self.requests.append((url, payload, credential_account))
        if self.cancel_after == len(self.requests) and cancellation is not None:
            cancellation.set()
        fixture = self.fixtures.pop(0)
        if isinstance(fixture, Exception):
            raise fixture
        return fixture


class RecordedHttpError(Exception):
    def __init__(self, status_code: int, secret_body: str) -> None:
        super().__init__(secret_body)
        self.status_code = status_code


def _provenance() -> NvidiaCatalogProvenance:
    return NvidiaCatalogProvenance(
        source_url="https://integrate.api.nvidia.com/v1/models",
        fetched_at=datetime(2026, 8, 28, tzinfo=UTC),
        catalog_version="recorded-2026-08-28T00:00:00Z",
    )


def _embedding_spec(*, batch_limit: int = 2) -> NvidiaEmbeddingModelSpec:
    return NvidiaEmbeddingModelSpec(
        model_id="nvidia/recorded-embed-model",
        model_version="catalog-version-7",
        dimensions=3,
        batch_limit=batch_limit,
        provenance=_provenance(),
        truncate=NvidiaTruncate.NONE,
    )


def _rerank_spec(*, batch_limit: int = 2) -> NvidiaRerankModelSpec:
    return NvidiaRerankModelSpec(
        model_id="nvidia/recorded-rerank-model",
        model_version="catalog-version-9",
        endpoint_url="https://ai.api.nvidia.com/v1/retrieval/nvidia/reranking",
        batch_limit=batch_limit,
        provenance=_provenance(),
    )


def _embedding_fixture(*vectors: tuple[float, float, float]) -> Mapping[str, Any]:
    return {
        "object": "list",
        "data": [
            {"object": "embedding", "index": index, "embedding": list(vector)}
            for index, vector in enumerate(vectors)
        ],
        "model": "nvidia/recorded-embed-model",
        "usage": {"prompt_tokens": 4, "total_tokens": 4},
    }


def _embedding_approval(model_id: str = "nvidia/recorded-embed-model"):
    return embedding_disclosure(project_id="project-alpha", model_id=model_id, acknowledged=True)


def _rerank_approval(model_id: str = "nvidia/recorded-rerank-model"):
    return CloudRerankDisclosure(
        project_id="project-alpha",
        provider_id=NVIDIA_PROVIDER_ID,
        model_id=model_id,
        acknowledged=True,
        acknowledged_at=datetime.now(UTC),
    )


@pytest.mark.asyncio
async def test_nvidia_embeddings_use_correct_input_types_batches_and_vault_account() -> None:
    transport = RecordedTransport(
        (
            _embedding_fixture((1.0, 0.0, 0.0), (0.0, 1.0, 0.0)),
            _embedding_fixture((0.0, 0.0, 1.0)),
            _embedding_fixture((0.5, 0.5, 0.0)),
        )
    )
    provider = NvidiaHostedEmbeddingProvider(_embedding_spec(), transport)
    disclosure = _embedding_approval()

    passages = await provider.embed(
        ("passage one", "passage two", "passage three"),
        input_type=EmbeddingInputType.PASSAGE,
        project_id="project-alpha",
        disclosure=disclosure,
    )
    query = await provider.embed(
        ("question",),
        input_type=EmbeddingInputType.QUERY,
        project_id="project-alpha",
        disclosure=disclosure,
    )

    assert len(passages) == 3
    assert query == ((0.5, 0.5, 0.0),)
    assert [request[0] for request in transport.requests] == [
        NVIDIA_EMBEDDINGS_ENDPOINT,
        NVIDIA_EMBEDDINGS_ENDPOINT,
        NVIDIA_EMBEDDINGS_ENDPOINT,
    ]
    assert [request[1]["input_type"] for request in transport.requests] == [
        "passage",
        "passage",
        "query",
    ]
    assert [len(request[1]["input"]) for request in transport.requests] == [2, 1, 1]
    assert all(request[2] == NVIDIA_CREDENTIAL_ACCOUNT for request in transport.requests)
    assert all("api_key" not in request[1] for request in transport.requests)


@pytest.mark.asyncio
async def test_nvidia_embedding_disclosure_is_checked_before_outbound_request() -> None:
    transport = RecordedTransport((_embedding_fixture((1.0, 0.0, 0.0)),))
    provider = NvidiaHostedEmbeddingProvider(_embedding_spec(), transport)

    with pytest.raises(NvidiaRetrievalError) as captured:
        await provider.embed(
            ("private passage",),
            project_id="project-alpha",
            disclosure=None,
        )

    assert captured.value.code == "cloud_disclosure_required"
    assert transport.requests == []


@pytest.mark.asyncio
async def test_nvidia_embedding_cancellation_stops_between_batches() -> None:
    cancellation = asyncio.Event()
    transport = RecordedTransport(
        (
            _embedding_fixture((1.0, 0.0, 0.0), (0.0, 1.0, 0.0)),
            _embedding_fixture((0.0, 0.0, 1.0)),
        ),
        cancel_after=1,
    )
    provider = NvidiaHostedEmbeddingProvider(_embedding_spec(), transport)

    with pytest.raises(asyncio.CancelledError):
        await provider.embed(
            ("one", "two", "three"),
            project_id="project-alpha",
            disclosure=_embedding_approval(),
            cancellation=cancellation,
        )

    assert len(transport.requests) == 1


@pytest.mark.asyncio
async def test_nvidia_errors_are_classified_without_raw_response_body() -> None:
    transport = RecordedTransport((RecordedHttpError(429, "nvapi-secret-in-body"),))
    provider = NvidiaHostedEmbeddingProvider(_embedding_spec(), transport)

    with pytest.raises(NvidiaRetrievalError) as captured:
        await provider.embed(
            ("passage",),
            project_id="project-alpha",
            disclosure=_embedding_approval(),
        )

    assert captured.value.code == "rate_limit"
    assert captured.value.retryable
    assert "nvapi-secret-in-body" not in str(captured.value)


@pytest.mark.asyncio
async def test_nvidia_rerank_batches_and_records_versioned_provenance() -> None:
    transport = RecordedTransport(
        (
            {"rankings": [{"index": 1, "logit": 3.0}, {"index": 0, "logit": 1.0}]},
            {"rankings": [{"index": 0, "logit": 2.0}]},
        )
    )
    reranker = NvidiaHostedReranker(_rerank_spec(), transport)
    candidates = (
        NvidiaRerankCandidate("a", "project-alpha", "file", "first passage"),
        NvidiaRerankCandidate("b", "project-alpha", "file", "second passage"),
        NvidiaRerankCandidate("c", "project-alpha", "file", "third passage"),
    )

    result = await reranker.arerank(
        "question",
        candidates,
        project_id="project-alpha",
        disclosure=_rerank_approval(),
    )

    assert result.interface_version == NVIDIA_RERANK_INTERFACE_VERSION
    assert result.provider_id == NVIDIA_PROVIDER_ID
    assert result.model_id == "nvidia/recorded-rerank-model"
    assert result.model_version == "catalog-version-9"
    assert result.catalog_source == _provenance().source_url
    assert [score.document_id for score in result.scores] == ["b", "c", "a"]
    assert [score.rank for score in result.scores] == [0, 1, 2]
    assert [len(request[1]["passages"]) for request in transport.requests] == [2, 1]
    assert all(request[2] == NVIDIA_CREDENTIAL_ACCOUNT for request in transport.requests)


@pytest.mark.asyncio
async def test_nvidia_rerank_rejects_cross_project_before_outbound() -> None:
    transport = RecordedTransport(({"rankings": [{"index": 0, "logit": 1.0}]},))
    reranker = NvidiaHostedReranker(_rerank_spec(), transport)
    candidates = (NvidiaRerankCandidate("foreign", "project-beta", "file", "private"),)

    with pytest.raises(NvidiaRetrievalError) as captured:
        await reranker.arerank(
            "question",
            candidates,
            project_id="project-alpha",
            disclosure=_rerank_approval(),
        )

    assert captured.value.code == "privacy_boundary"
    assert transport.requests == []


@pytest.mark.asyncio
async def test_nvidia_rerank_requires_exact_disclosure_before_outbound() -> None:
    transport = RecordedTransport(({"rankings": [{"index": 0, "logit": 1.0}]},))
    reranker = NvidiaHostedReranker(_rerank_spec(), transport)
    candidate = NvidiaRerankCandidate("a", "project-alpha", "file", "passage")

    with pytest.raises(NvidiaRetrievalError) as captured:
        await reranker.arerank(
            "question",
            (candidate,),
            project_id="project-alpha",
            disclosure=None,
        )

    assert captured.value.code == "cloud_disclosure_required"
    assert transport.requests == []


@pytest.mark.asyncio
async def test_nvidia_rerank_cancellation_and_malformed_fixture() -> None:
    cancellation = asyncio.Event()
    transport = RecordedTransport(
        (
            {"rankings": [{"index": 0, "logit": 1.0}, {"index": 1, "logit": 0.0}]},
            {"rankings": [{"index": 0, "logit": 2.0}]},
        ),
        cancel_after=1,
    )
    reranker = NvidiaHostedReranker(_rerank_spec(), transport)
    candidate = NvidiaRerankCandidate("a", "project-alpha", "file", "passage")
    candidates = (
        candidate,
        NvidiaRerankCandidate("b", "project-alpha", "file", "second"),
        NvidiaRerankCandidate("c", "project-alpha", "file", "third"),
    )
    with pytest.raises(asyncio.CancelledError):
        await reranker.arerank(
            "question",
            candidates,
            project_id="project-alpha",
            disclosure=_rerank_approval(),
            cancellation=cancellation,
        )
    assert len(transport.requests) == 1

    malformed = RecordedTransport(({"rankings": [{"index": 4, "logit": 1.0}]},))
    reranker = NvidiaHostedReranker(_rerank_spec(), malformed)
    with pytest.raises(NvidiaRetrievalError) as captured:
        await reranker.arerank(
            "question",
            (candidate,),
            project_id="project-alpha",
            disclosure=_rerank_approval(),
        )
    assert captured.value.code == "malformed_provider_response"


def test_nvidia_rerank_endpoint_is_restricted_to_hosted_retrieval_routes() -> None:
    with pytest.raises(ValueError, match="outside"):
        NvidiaRerankModelSpec(
            model_id="nvidia/model",
            model_version="v1",
            endpoint_url="https://attacker.invalid/v1/ranking",
            batch_limit=32,
            provenance=_provenance(),
        )

    integrate = NvidiaRerankModelSpec(
        model_id="nvidia/model",
        model_version="v1",
        endpoint_url="https://integrate.api.nvidia.com/v1/ranking",
        batch_limit=32,
        provenance=_provenance(),
    )
    assert integrate.endpoint_url.endswith("/v1/ranking")

    with pytest.raises(ValueError, match="truncation"):
        NvidiaRerankModelSpec(
            model_id="nvidia/model",
            model_version="v1",
            endpoint_url="https://integrate.api.nvidia.com/v1/ranking",
            batch_limit=32,
            provenance=_provenance(),
            truncate=NvidiaTruncate.START,
        )


def test_nvidia_catalog_model_identity_has_no_permanent_free_tier_assumption() -> None:
    spec = _embedding_spec()
    assert spec.model_id == "nvidia/recorded-embed-model"
    assert spec.model_version == "catalog-version-7"
    assert spec.provenance.catalog_version.startswith("recorded-")
    assert not hasattr(spec, "free")
