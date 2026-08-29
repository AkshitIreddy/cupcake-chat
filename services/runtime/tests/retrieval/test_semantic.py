from __future__ import annotations

import asyncio
import sqlite3
from collections.abc import Sequence
from datetime import UTC, datetime
from importlib.util import find_spec
from pathlib import Path

import pytest

from cupcake_runtime.retrieval import (
    CloudEmbeddingDisclosure,
    DestinationKind,
    DeterministicEmbeddingProvider,
    EmbeddingInputType,
    EmbeddingModelDescriptor,
    EmbeddingPrivacyError,
    RetrievalPlanner,
    SearchDocument,
    SearchIndex,
    SemanticCandidate,
    SemanticIndexState,
    SemanticVectorIndex,
)
from cupcake_runtime.storage import Database, DatabaseConfig


class RecordingProvider:
    def __init__(
        self,
        *,
        destination: DestinationKind = DestinationKind.LOCAL,
        model_version: str = "v1",
        fail: bool = False,
    ) -> None:
        self._descriptor = EmbeddingModelDescriptor(
            provider_id="recording-provider",
            model_id="recording-model",
            model_version=model_version,
            dimensions=4,
            destination=destination,
            disclosure="Test recording provider route.",
        )
        self.calls: list[tuple[str, ...]] = []
        self.input_types: list[EmbeddingInputType] = []
        self.fail = fail

    @property
    def descriptor(self) -> EmbeddingModelDescriptor:
        return self._descriptor

    async def embed(
        self,
        texts: Sequence[str],
        *,
        input_type: EmbeddingInputType = EmbeddingInputType.PASSAGE,
        project_id: str | None = None,
        disclosure: CloudEmbeddingDisclosure | None = None,
        cancellation: asyncio.Event | None = None,
    ) -> Sequence[Sequence[float]]:
        if cancellation is not None and cancellation.is_set():
            raise asyncio.CancelledError
        self.calls.append(tuple(texts))
        self.input_types.append(input_type)
        if self.fail:
            raise RuntimeError("simulated provider body that must not be persisted")
        return tuple(_recording_vector(text) for text in texts)


def _recording_vector(text: str) -> tuple[float, float, float, float]:
    folded = text.casefold()
    return (
        float(folded.count("berry")),
        float(folded.count("vanilla")),
        float(folded.count("architecture")),
        0.25,
    )


def _document(identifier: str, project_id: str, content: str) -> SearchDocument:
    return SearchDocument(
        id=identifier,
        project_id=project_id,
        source_kind="file",
        source_id=f"{identifier}.md",
        title=f"Document {identifier}",
        content=content,
    )


def _connection() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    return connection


@pytest.mark.asyncio
async def test_deterministic_fixture_is_stable_and_network_free() -> None:
    first = DeterministicEmbeddingProvider(dimensions=16)
    second = DeterministicEmbeddingProvider(dimensions=16)

    left = await first.embed(("berry frosting", "architecture notes"))
    right = await second.embed(("berry frosting", "architecture notes"))

    assert left == right
    assert left[0] != left[1]
    assert len(left[0]) == 16


@pytest.mark.asyncio
async def test_async_hybrid_search_scores_only_hard_filtered_project_candidates() -> None:
    connection = _connection()
    provider = RecordingProvider()
    semantic = SemanticVectorIndex(connection, provider)
    lexical = SearchIndex(connection, async_semantic_index=semantic)
    alpha = _document("alpha", "project-alpha", "berry frosting architecture")
    beta = _document("beta", "project-beta", "berry frosting private roadmap")
    lexical.upsert_many((alpha, beta))
    await semantic.rebuild((alpha, beta))
    provider.calls.clear()
    provider.input_types.clear()

    plan = RetrievalPlanner().plan(
        query="berry frosting",
        project_id="project-alpha",
        semantic_available=lexical.semantic_available,
    )
    hits = await lexical.search_async(plan)

    assert [hit.document.id for hit in hits] == ["alpha"]
    assert provider.calls == [("berry frosting",)]
    assert provider.input_types == [EmbeddingInputType.QUERY]
    assert hits[0].semantic_score is not None
    lexical.close()
    connection.close()


@pytest.mark.asyncio
async def test_cross_project_candidate_is_rejected_before_provider_call() -> None:
    connection = _connection()
    provider = RecordingProvider()
    semantic = SemanticVectorIndex(connection, provider)
    candidate = SemanticCandidate("foreign", "project-beta", "file", "a" * 64)

    with pytest.raises(EmbeddingPrivacyError, match="cross-project"):
        await semantic.ascore("private query", (candidate,), project_id="project-alpha")

    assert provider.calls == []
    connection.close()


@pytest.mark.asyncio
async def test_cloud_route_requires_exact_project_provider_model_disclosure() -> None:
    connection = _connection()
    provider = RecordingProvider(destination=DestinationKind.CLOUD)
    semantic = SemanticVectorIndex(connection, provider)
    document = _document("alpha", "project-alpha", "berry frosting")

    with pytest.raises(EmbeddingPrivacyError, match="explicit matching"):
        await semantic.enrich_documents((document,))
    assert provider.calls == []

    wrong_project = CloudEmbeddingDisclosure(
        project_id="project-beta",
        provider_id=provider.descriptor.provider_id,
        model_id=provider.descriptor.model_id,
        acknowledged=True,
    )
    with pytest.raises(EmbeddingPrivacyError):
        await semantic.enrich_documents((document,), disclosures={"project-alpha": wrong_project})
    assert provider.calls == []

    approved = CloudEmbeddingDisclosure(
        project_id="project-alpha",
        provider_id=provider.descriptor.provider_id,
        model_id=provider.descriptor.model_id,
        acknowledged=True,
        acknowledged_at=datetime.now(UTC),
    )
    report = await semantic.enrich_documents((document,), disclosures={"project-alpha": approved})
    assert report.enriched == 1
    assert len(provider.calls) == 1
    connection.close()


@pytest.mark.asyncio
async def test_content_hash_prevents_stale_vector_from_becoming_product_truth() -> None:
    connection = _connection()
    provider = RecordingProvider()
    semantic = SemanticVectorIndex(connection, provider)
    lexical = SearchIndex(connection, async_semantic_index=semantic)
    original = _document("alpha", "project-alpha", "berry frosting original")
    lexical.upsert(original)
    await semantic.enrich_documents((original,))

    changed = _document("alpha", "project-alpha", "berry frosting now changed")
    lexical.upsert(changed)
    plan = RetrievalPlanner().plan(
        query="berry frosting", project_id="project-alpha", semantic_available=True
    )
    hits = await lexical.search_async(plan)

    assert hits[0].document.content == changed.content
    assert hits[0].semantic_score is None
    assert hits[0].score == hits[0].lexical_score
    lexical.close()
    connection.close()


@pytest.mark.asyncio
async def test_model_version_change_invalidates_and_rebuilds_derived_rows() -> None:
    connection = _connection()
    document = _document("alpha", "project-alpha", "berry frosting")
    version_one = SemanticVectorIndex(connection, RecordingProvider(model_version="v1"))
    first = await version_one.rebuild((document,))
    assert version_one.status().state is SemanticIndexState.READY

    version_two = SemanticVectorIndex(connection, RecordingProvider(model_version="v2"))
    assert version_two.invalidate_stale_version() == 1
    stale = version_two.status()
    assert stale.state is SemanticIndexState.STALE
    assert stale.active_generation is None

    second = await version_two.rebuild((document,))
    ready = version_two.status()
    assert ready.state is SemanticIndexState.READY
    assert ready.model_fingerprint == version_two.model_fingerprint
    assert second.generation != first.generation
    connection.close()


@pytest.mark.asyncio
async def test_failed_same_model_rebuild_preserves_previous_generation() -> None:
    connection = _connection()
    provider = RecordingProvider()
    semantic = SemanticVectorIndex(connection, provider)
    document = _document("alpha", "project-alpha", "berry frosting")
    first = await semantic.rebuild((document,))
    provider.fail = True

    with pytest.raises(RuntimeError, match="simulated"):
        await semantic.rebuild((document,))

    status = semantic.status()
    assert status.state is SemanticIndexState.READY
    assert status.active_generation == first.generation
    assert status.document_count == 1
    assert status.failure == "RuntimeError: embedding rebuild failed"
    connection.close()


@pytest.mark.asyncio
async def test_background_enrichment_can_be_drained_explicitly() -> None:
    connection = _connection()
    semantic = SemanticVectorIndex(connection, DeterministicEmbeddingProvider())
    document = _document("alpha", "project-alpha", "berry frosting")

    task = semantic.enrich_in_background((document,))
    reports = await semantic.drain_background()

    assert task.done()
    assert reports[0].enriched == 1
    assert semantic.status().document_count == 1
    connection.close()


@pytest.mark.asyncio
async def test_lexical_search_survives_empty_or_unbuilt_semantic_accelerator() -> None:
    connection = _connection()
    semantic = SemanticVectorIndex(connection, DeterministicEmbeddingProvider())
    lexical = SearchIndex(connection, async_semantic_index=semantic)
    lexical.upsert(_document("alpha", "project-alpha", "berry frosting"))
    plan = RetrievalPlanner().plan(
        query="berry frosting", project_id="project-alpha", semantic_available=True
    )

    hits = await lexical.search_async(plan)

    assert [hit.document.id for hit in hits] == ["alpha"]
    assert hits[0].semantic_score is None
    lexical.close()
    connection.close()


def test_embedding_background_tasks_are_real_async_tasks() -> None:
    async def scenario() -> None:
        connection = _connection()
        semantic = SemanticVectorIndex(connection, DeterministicEmbeddingProvider())
        task = semantic.enrich_in_background(
            (_document("alpha", "project-alpha", "berry frosting"),)
        )
        assert isinstance(task, asyncio.Task)
        await task
        connection.close()

    asyncio.run(scenario())


@pytest.mark.skipif(find_spec("sqlcipher3") is None, reason="SQLCipher extra unavailable")
def test_vectors_live_in_the_encrypted_product_database(tmp_path: Path) -> None:
    path = tmp_path / "encrypted-product.sqlite3"
    key = b"semantic-test-key-material-32b!!"
    database = Database(DatabaseConfig(path=path, encryption_key=key, require_sqlcipher=True))
    provider = DeterministicEmbeddingProvider()
    semantic = SemanticVectorIndex(database.connection, provider)
    document = _document("alpha", "project-alpha", "berry frosting secret marker")
    asyncio.run(semantic.rebuild((document,)))
    expected_generation = semantic.status().active_generation
    database.checkpoint()
    database.close()

    raw = path.read_bytes()
    assert b"berry frosting secret marker" not in raw
    assert b"semantic_vectors" not in raw

    reopened = Database(DatabaseConfig(path=path, encryption_key=key, require_sqlcipher=True))
    reloaded = SemanticVectorIndex(reopened.connection, provider)
    assert reloaded.status().active_generation == expected_generation
    assert reloaded.status().document_count == 1
    reopened.close()
