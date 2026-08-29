from __future__ import annotations

import asyncio
import math
import sqlite3
import struct
import threading
from collections.abc import Awaitable, Callable, Mapping, Sequence
from datetime import UTC, datetime
from hashlib import sha256
from typing import Protocol
from uuid import uuid4

from .models import (
    CloudEmbeddingDisclosure,
    DestinationKind,
    EmbeddingInputType,
    EmbeddingModelDescriptor,
    SearchDocument,
    SemanticCandidate,
    SemanticEnrichmentReport,
    SemanticIndexState,
    SemanticIndexStatus,
)


class EmbeddingPrivacyError(PermissionError):
    """Raised before any text crosses an unapproved embedding data route."""


class EmbeddingProvider(Protocol):
    """Production adapter boundary for local or explicitly disclosed cloud embeddings."""

    @property
    def descriptor(self) -> EmbeddingModelDescriptor: ...

    async def embed(
        self,
        texts: Sequence[str],
        *,
        input_type: EmbeddingInputType = EmbeddingInputType.PASSAGE,
        project_id: str | None = None,
        disclosure: CloudEmbeddingDisclosure | None = None,
        cancellation: asyncio.Event | None = None,
    ) -> Sequence[Sequence[float]]: ...


EmbeddingFunction = Callable[
    [
        Sequence[str],
        EmbeddingInputType,
        str | None,
        CloudEmbeddingDisclosure | None,
        asyncio.Event | None,
    ],
    Awaitable[Sequence[Sequence[float]]],
]


class FunctionEmbeddingProvider:
    """Small adapter for production SDK clients without coupling retrieval to an SDK."""

    def __init__(
        self,
        descriptor: EmbeddingModelDescriptor,
        embed: EmbeddingFunction,
    ) -> None:
        self._descriptor = descriptor
        self._embed = embed

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
        return await self._embed(texts, input_type, project_id, disclosure, cancellation)


class DeterministicEmbeddingProvider:
    """Network-free fixture with stable vectors for tests, demos, and mock-provider CI."""

    def __init__(self, *, dimensions: int = 32, model_version: str = "fixture-v1") -> None:
        self._descriptor = EmbeddingModelDescriptor(
            provider_id="cupcake-fixture",
            model_id="deterministic-hash-embedding",
            model_version=model_version,
            dimensions=dimensions,
            destination=DestinationKind.LOCAL,
            disclosure="Runs locally using a deterministic test-only hash embedding.",
        )

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
        return tuple(_deterministic_vector(text, self.descriptor.dimensions) for text in texts)


class SemanticVectorIndex:
    """Derived, model-versioned semantic accelerator hosted in the product database.

    The FTS/product records remain authoritative. This class stores only rebuildable
    vectors and refuses to score candidates until their project boundary and content
    hashes have been rechecked against the active derived generation.
    """

    def __init__(
        self,
        connection: sqlite3.Connection,
        provider: EmbeddingProvider,
        *,
        index_name: str = "product-search",
        batch_size: int = 64,
    ) -> None:
        if not index_name.strip():
            raise ValueError("semantic index_name must not be empty")
        if not 1 <= batch_size <= 1_024:
            raise ValueError("semantic batch_size must be between 1 and 1024")
        self._connection = connection
        self._provider = provider
        self._index_name = index_name
        self._batch_size = batch_size
        self._lock = threading.RLock()
        self._background_tasks: set[asyncio.Task[SemanticEnrichmentReport]] = set()
        with self._lock:
            self._connection.executescript(_SEMANTIC_SCHEMA)
            self._connection.commit()

    @property
    def descriptor(self) -> EmbeddingModelDescriptor:
        return self._provider.descriptor

    @property
    def model_fingerprint(self) -> str:
        return self.descriptor.fingerprint

    def status(self) -> SemanticIndexStatus:
        with self._lock:
            row = self._connection.execute(
                """SELECT state, model_fingerprint, active_generation, updated_at, failure
                   FROM semantic_index_state WHERE index_name = ?""",
                (self._index_name,),
            ).fetchone()
            if row is None:
                return SemanticIndexStatus(
                    state=SemanticIndexState.EMPTY,
                    model_fingerprint=None,
                    active_generation=None,
                    document_count=0,
                    updated_at=None,
                )
            active_generation = _optional_str(row[2])
            count = 0
            if active_generation:
                count = int(
                    self._connection.execute(
                        """SELECT count(*) FROM semantic_vectors
                           WHERE index_name = ? AND generation = ?""",
                        (self._index_name, active_generation),
                    ).fetchone()[0]
                )
        return SemanticIndexStatus(
            state=SemanticIndexState(str(row[0])),
            model_fingerprint=_optional_str(row[1]),
            active_generation=active_generation,
            document_count=count,
            updated_at=_parse_datetime(row[3]),
            failure=_optional_str(row[4]),
        )

    def invalidate_stale_version(self) -> int:
        """Delete derived rows when the configured embedding model identity changes."""
        with self._lock:
            row = self._connection.execute(
                "SELECT model_fingerprint FROM semantic_index_state WHERE index_name = ?",
                (self._index_name,),
            ).fetchone()
            if row is None or row[0] == self.model_fingerprint:
                return 0
            try:
                self._connection.execute("BEGIN IMMEDIATE")
                count = int(
                    self._connection.execute(
                        "SELECT count(*) FROM semantic_vectors WHERE index_name = ?",
                        (self._index_name,),
                    ).fetchone()[0]
                )
                self._connection.execute(
                    "DELETE FROM semantic_vectors WHERE index_name = ?", (self._index_name,)
                )
                self._upsert_state(
                    state=SemanticIndexState.STALE,
                    active_generation=None,
                    failure="embedding model version changed; rebuild required",
                )
            except BaseException:
                self._connection.rollback()
                raise
            else:
                self._connection.commit()
                return count

    async def enrich_documents(
        self,
        documents: Sequence[SearchDocument],
        *,
        disclosures: Mapping[str, CloudEmbeddingDisclosure] | None = None,
    ) -> SemanticEnrichmentReport:
        """Incrementally enrich records while leaving lexical search immediately usable."""
        checked = _unique_documents(documents)
        self._authorize_documents(checked, disclosures or {})
        stale_removed = self.invalidate_stale_version()
        status = self.status()
        generation = status.active_generation or uuid4().hex
        vectors = await self._embed_documents(checked, disclosures or {})
        now = _now()
        with self._lock:
            try:
                self._connection.execute("BEGIN IMMEDIATE")
                self._upsert_state(
                    state=SemanticIndexState.BUILDING,
                    active_generation=status.active_generation,
                    failure=None,
                )
                for document, vector in zip(checked, vectors, strict=True):
                    self._write_vector(generation, document, vector, now)
                self._upsert_state(
                    state=SemanticIndexState.READY,
                    active_generation=generation,
                    failure=None,
                )
            except BaseException:
                self._connection.rollback()
                raise
            else:
                self._connection.commit()
        return SemanticEnrichmentReport(
            generation=generation,
            model_fingerprint=self.model_fingerprint,
            enriched=len(checked),
            skipped=len(documents) - len(checked),
            stale_removed=stale_removed,
            promoted=True,
        )

    async def rebuild(
        self,
        documents: Sequence[SearchDocument],
        *,
        disclosures: Mapping[str, CloudEmbeddingDisclosure] | None = None,
    ) -> SemanticEnrichmentReport:
        """Build a new generation and promote it atomically; prior generations are derived."""
        checked = _unique_documents(documents)
        self._authorize_documents(checked, disclosures or {})
        stale_removed = self.invalidate_stale_version()
        previous = self.status()
        generation = uuid4().hex
        with self._lock:
            try:
                self._connection.execute("BEGIN IMMEDIATE")
                self._upsert_state(
                    state=SemanticIndexState.BUILDING,
                    active_generation=previous.active_generation,
                    failure=None,
                )
                self._connection.execute(
                    "DELETE FROM semantic_vectors WHERE index_name = ? AND generation = ?",
                    (self._index_name, generation),
                )
            except BaseException:
                self._connection.rollback()
                raise
            else:
                self._connection.commit()

        try:
            for start in range(0, len(checked), self._batch_size):
                batch = checked[start : start + self._batch_size]
                vectors = await self._embed_documents(batch, disclosures or {})
                now = _now()
                with self._lock:
                    try:
                        self._connection.execute("BEGIN IMMEDIATE")
                        for document, vector in zip(batch, vectors, strict=True):
                            self._write_vector(generation, document, vector, now)
                    except BaseException:
                        self._connection.rollback()
                        raise
                    else:
                        self._connection.commit()
        except BaseException as exc:
            with self._lock:
                try:
                    self._connection.execute("BEGIN IMMEDIATE")
                    self._connection.execute(
                        "DELETE FROM semantic_vectors WHERE index_name = ? AND generation = ?",
                        (self._index_name, generation),
                    )
                    self._upsert_state(
                        state=(
                            SemanticIndexState.READY
                            if previous.active_generation
                            else SemanticIndexState.FAILED
                        ),
                        active_generation=previous.active_generation,
                        failure=_safe_failure(exc),
                    )
                except BaseException:
                    self._connection.rollback()
                else:
                    self._connection.commit()
            raise

        with self._lock:
            try:
                self._connection.execute("BEGIN IMMEDIATE")
                removed = int(
                    self._connection.execute(
                        """SELECT count(*) FROM semantic_vectors
                           WHERE index_name = ? AND generation != ?""",
                        (self._index_name, generation),
                    ).fetchone()[0]
                )
                self._upsert_state(
                    state=SemanticIndexState.READY,
                    active_generation=generation,
                    failure=None,
                )
                self._connection.execute(
                    "DELETE FROM semantic_vectors WHERE index_name = ? AND generation != ?",
                    (self._index_name, generation),
                )
            except BaseException:
                self._connection.rollback()
                raise
            else:
                self._connection.commit()
        return SemanticEnrichmentReport(
            generation=generation,
            model_fingerprint=self.model_fingerprint,
            enriched=len(checked),
            skipped=len(documents) - len(checked),
            stale_removed=stale_removed + removed,
            promoted=True,
        )

    async def ascore(
        self,
        query: str,
        candidates: Sequence[SemanticCandidate],
        *,
        project_id: str,
        disclosure: CloudEmbeddingDisclosure | None = None,
    ) -> Mapping[str, float]:
        """Score only candidates admitted by a prior hard project/source filter."""
        if not project_id.strip():
            raise ValueError("project_id is required before semantic scoring")
        if any(candidate.project_id != project_id for candidate in candidates):
            raise EmbeddingPrivacyError("cross-project candidates were rejected before scoring")
        self._authorize_project(project_id, disclosure)
        status = self.status()
        if not status.active_generation or status.model_fingerprint != self.model_fingerprint:
            return {}
        if not candidates:
            return {}
        query_vectors = await self._embed_checked(
            (query,),
            input_type=EmbeddingInputType.QUERY,
            project_id=project_id,
            disclosure=disclosure,
        )
        query_vector = query_vectors[0]
        candidate_by_id = {candidate.document_id: candidate for candidate in candidates}
        placeholders = ",".join("?" for _ in candidate_by_id)
        arguments: list[object] = [
            self._index_name,
            status.active_generation,
            project_id,
            *candidate_by_id,
        ]
        sql = f"""SELECT document_id, content_hash, vector, vector_norm
                  FROM semantic_vectors
                  WHERE index_name = ? AND generation = ? AND project_id = ?
                    AND document_id IN ({placeholders})"""
        with self._lock:
            rows = self._connection.execute(sql, arguments).fetchall()
        query_norm = _norm(query_vector)
        scores: dict[str, float] = {}
        for row in rows:
            document_id = str(row[0])
            candidate = candidate_by_id[document_id]
            if str(row[1]) != candidate.content_hash:
                continue
            stored = _unpack_vector(bytes(row[2]), self.descriptor.dimensions)
            denominator = query_norm * float(row[3])
            cosine = 0.0 if denominator <= 0 else _dot(query_vector, stored) / denominator
            scores[document_id] = max(0.0, min(1.0, (cosine + 1.0) / 2.0))
        return scores

    def enrich_in_background(
        self,
        documents: Sequence[SearchDocument],
        *,
        disclosures: Mapping[str, CloudEmbeddingDisclosure] | None = None,
    ) -> asyncio.Task[SemanticEnrichmentReport]:
        """Schedule non-blocking enrichment; callers may await `drain_background`."""
        task = asyncio.create_task(
            self.enrich_documents(documents, disclosures=disclosures),
            name=f"semantic-enrichment:{self._index_name}",
        )
        self._background_tasks.add(task)
        return task

    async def drain_background(self) -> tuple[SemanticEnrichmentReport, ...]:
        tasks = tuple(self._background_tasks)
        if not tasks:
            return ()
        try:
            return tuple(await asyncio.gather(*tasks))
        finally:
            self._background_tasks.difference_update(tasks)

    def _authorize_documents(
        self,
        documents: Sequence[SearchDocument],
        disclosures: Mapping[str, CloudEmbeddingDisclosure],
    ) -> None:
        for project_id in {document.project_id for document in documents}:
            self._authorize_project(project_id, disclosures.get(project_id))

    def _authorize_project(
        self,
        project_id: str,
        disclosure: CloudEmbeddingDisclosure | None,
    ) -> None:
        if not project_id.strip():
            raise EmbeddingPrivacyError("project-less records cannot enter semantic retrieval")
        descriptor = self.descriptor
        if descriptor.destination is DestinationKind.LOCAL:
            return
        if (
            disclosure is None
            or not disclosure.acknowledged
            or disclosure.project_id != project_id
            or disclosure.provider_id != descriptor.provider_id
            or disclosure.model_id != descriptor.model_id
        ):
            raise EmbeddingPrivacyError(
                "cloud embeddings require an explicit matching project/provider/model disclosure"
            )

    async def _embed_documents(
        self,
        documents: Sequence[SearchDocument],
        disclosures: Mapping[str, CloudEmbeddingDisclosure],
    ) -> tuple[tuple[float, ...], ...]:
        by_project: dict[str, list[tuple[int, SearchDocument]]] = {}
        for index, document in enumerate(documents):
            by_project.setdefault(document.project_id, []).append((index, document))
        vectors: list[tuple[float, ...] | None] = [None] * len(documents)
        for project_id, indexed_documents in by_project.items():
            embedded = await self._embed_checked(
                tuple(document.semantic_content for _, document in indexed_documents),
                input_type=EmbeddingInputType.PASSAGE,
                project_id=project_id,
                disclosure=disclosures.get(project_id),
            )
            for (index, _), vector in zip(indexed_documents, embedded, strict=True):
                vectors[index] = vector
        if any(vector is None for vector in vectors):
            raise RuntimeError("semantic document embedding did not preserve input ordering")
        return tuple(vector for vector in vectors if vector is not None)

    async def _embed_checked(
        self,
        texts: Sequence[str],
        *,
        input_type: EmbeddingInputType,
        project_id: str,
        disclosure: CloudEmbeddingDisclosure | None,
    ) -> tuple[tuple[float, ...], ...]:
        if not texts:
            return ()
        values = await self._provider.embed(
            texts,
            input_type=input_type,
            project_id=project_id,
            disclosure=disclosure,
        )
        if len(values) != len(texts):
            raise ValueError("embedding provider returned the wrong number of vectors")
        checked: list[tuple[float, ...]] = []
        for value in values:
            vector = tuple(float(item) for item in value)
            if len(vector) != self.descriptor.dimensions:
                raise ValueError("embedding provider returned an unexpected vector dimension")
            if not all(math.isfinite(item) for item in vector):
                raise ValueError("embedding vectors must contain only finite values")
            checked.append(vector)
        return tuple(checked)

    def _write_vector(
        self,
        generation: str,
        document: SearchDocument,
        vector: Sequence[float],
        enriched_at: str,
    ) -> None:
        self._connection.execute(
            """INSERT INTO semantic_vectors(
                   index_name, generation, document_id, project_id, source_kind,
                   content_hash, vector, vector_norm, enriched_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(index_name, generation, document_id) DO UPDATE SET
                   project_id = excluded.project_id,
                   source_kind = excluded.source_kind,
                   content_hash = excluded.content_hash,
                   vector = excluded.vector,
                   vector_norm = excluded.vector_norm,
                   enriched_at = excluded.enriched_at""",
            (
                self._index_name,
                generation,
                document.id,
                document.project_id,
                document.source_kind,
                document.semantic_content_hash,
                _pack_vector(vector),
                _norm(vector),
                enriched_at,
            ),
        )

    def _upsert_state(
        self,
        *,
        state: SemanticIndexState,
        active_generation: str | None,
        failure: str | None,
    ) -> None:
        descriptor = self.descriptor
        self._connection.execute(
            """INSERT INTO semantic_index_state(
                   index_name, state, provider_id, model_id, model_version, dimensions,
                   destination, model_fingerprint, active_generation, failure, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(index_name) DO UPDATE SET
                   state = excluded.state,
                   provider_id = excluded.provider_id,
                   model_id = excluded.model_id,
                   model_version = excluded.model_version,
                   dimensions = excluded.dimensions,
                   destination = excluded.destination,
                   model_fingerprint = excluded.model_fingerprint,
                   active_generation = excluded.active_generation,
                   failure = excluded.failure,
                   updated_at = excluded.updated_at""",
            (
                self._index_name,
                state.value,
                descriptor.provider_id,
                descriptor.model_id,
                descriptor.model_version,
                descriptor.dimensions,
                descriptor.destination.value,
                descriptor.fingerprint,
                active_generation,
                failure,
                _now(),
            ),
        )


def _unique_documents(documents: Sequence[SearchDocument]) -> tuple[SearchDocument, ...]:
    unique: dict[str, SearchDocument] = {}
    for document in documents:
        if not document.project_id.strip():
            raise EmbeddingPrivacyError("semantic documents require a project privacy boundary")
        if not document.content.strip():
            raise ValueError("semantic document content must not be empty")
        unique[document.id] = document
    return tuple(unique.values())


def _deterministic_vector(text: str, dimensions: int) -> tuple[float, ...]:
    # Signed feature hashing keeps related tokens related while remaining deterministic.
    vector = [0.0] * dimensions
    tokens = text.casefold().split()
    for position, token in enumerate(tokens or ("",)):
        digest = sha256(f"{position % 3}:{token}".encode()).digest()
        bucket = int.from_bytes(digest[:4], "big") % dimensions
        sign = 1.0 if digest[4] & 1 else -1.0
        vector[bucket] += sign * (1.0 + min(len(token), 20) / 20.0)
    magnitude = _norm(vector)
    if magnitude:
        return tuple(value / magnitude for value in vector)
    return tuple(vector)


def _pack_vector(vector: Sequence[float]) -> bytes:
    return struct.pack(f"<{len(vector)}f", *vector)


def _unpack_vector(value: bytes, dimensions: int) -> tuple[float, ...]:
    expected = dimensions * 4
    if len(value) != expected:
        raise ValueError("stored semantic vector has an invalid byte length")
    return tuple(struct.unpack(f"<{dimensions}f", value))


def _dot(left: Sequence[float], right: Sequence[float]) -> float:
    return sum(a * b for a, b in zip(left, right, strict=True))


def _norm(vector: Sequence[float]) -> float:
    return math.sqrt(sum(item * item for item in vector))


def _optional_str(value: object) -> str | None:
    return None if value is None else str(value)


def _parse_datetime(value: object) -> datetime | None:
    if value is None:
        return None
    return datetime.fromisoformat(str(value)).astimezone(UTC)


def _safe_failure(exc: BaseException) -> str:
    # Persist exception type, not provider text that could contain remote payloads.
    return f"{type(exc).__name__}: embedding rebuild failed"


def _now() -> str:
    return datetime.now(UTC).isoformat()


_SEMANTIC_SCHEMA = """
CREATE TABLE IF NOT EXISTS semantic_index_state (
    index_name TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK(state IN ('empty', 'building', 'ready', 'stale', 'failed')),
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    model_version TEXT NOT NULL,
    dimensions INTEGER NOT NULL CHECK(dimensions > 0),
    destination TEXT NOT NULL CHECK(destination IN ('local', 'cloud')),
    model_fingerprint TEXT NOT NULL,
    active_generation TEXT,
    failure TEXT,
    updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS semantic_vectors (
    index_name TEXT NOT NULL,
    generation TEXT NOT NULL,
    document_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
    vector BLOB NOT NULL,
    vector_norm REAL NOT NULL CHECK(vector_norm >= 0),
    enriched_at TEXT NOT NULL,
    PRIMARY KEY(index_name, generation, document_id)
) STRICT;
CREATE INDEX IF NOT EXISTS semantic_vectors_scope_idx
    ON semantic_vectors(index_name, generation, project_id, source_kind, document_id);
"""
