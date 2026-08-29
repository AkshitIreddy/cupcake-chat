from __future__ import annotations

import json
import math
import re
import sqlite3
import threading
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from .models import (
    Citation,
    CloudEmbeddingDisclosure,
    RetrievalMode,
    RetrievalPlan,
    SearchDocument,
    SearchHit,
    SemanticCandidate,
)


class SemanticIndex(Protocol):
    def score(
        self, query: str, document_ids: Sequence[str], *, project_id: str
    ) -> Mapping[str, float]: ...


class AsyncSemanticIndex(Protocol):
    async def ascore(
        self,
        query: str,
        candidates: Sequence[SemanticCandidate],
        *,
        project_id: str,
        disclosure: CloudEmbeddingDisclosure | None = None,
    ) -> Mapping[str, float]: ...


class RetrievalPlanner:
    def plan(
        self,
        *,
        query: str,
        project_id: str,
        semantic_available: bool,
        source_kinds: Sequence[str] = (),
        limit: int = 20,
    ) -> RetrievalPlan:
        query = query.strip()
        if not query:
            raise ValueError("query must not be empty")
        if not project_id.strip():
            raise ValueError("project_id is required; cross-project search is prohibited")
        if not 1 <= limit <= 100:
            raise ValueError("limit must be between 1 and 100")
        return RetrievalPlan(
            query=query,
            project_id=project_id,
            mode=RetrievalMode.HYBRID if semantic_available else RetrievalMode.LEXICAL,
            source_kinds=tuple(source_kinds),
            limit=limit,
            candidate_limit=max(limit * 5, 50),
        )


class SearchIndex:
    """Project-isolated FTS5 index with optional rebuildable semantic scoring."""

    def __init__(
        self,
        database: str | Path | sqlite3.Connection = ":memory:",
        *,
        semantic_index: SemanticIndex | None = None,
        async_semantic_index: AsyncSemanticIndex | None = None,
    ) -> None:
        if isinstance(database, (str, Path)):
            self._connection = sqlite3.connect(str(database), check_same_thread=False)
            self._owns_connection = True
            self._connection.row_factory = sqlite3.Row
        else:
            self._connection = database
            self._owns_connection = False
        self._lock = threading.RLock()
        self._semantic = semantic_index
        self._async_semantic = async_semantic_index
        with self._lock:
            self._connection.executescript(_SCHEMA)
            self._connection.commit()

    def close(self) -> None:
        if self._owns_connection:
            self._connection.close()

    @property
    def semantic_available(self) -> bool:
        return self._semantic is not None or self._async_semantic is not None

    def upsert(self, document: SearchDocument) -> None:
        self.upsert_many((document,))

    def upsert_many(self, documents: Sequence[SearchDocument]) -> None:
        """Atomically update FTS records; suitable for ingestion and benchmark fixtures."""
        if not documents:
            return
        identifiers: set[str] = set()
        for document in documents:
            if document.id in identifiers:
                raise ValueError(f"duplicate indexed document id: {document.id}")
            identifiers.add(document.id)
            if not document.project_id.strip():
                raise ValueError("indexed documents require a project_id")
            if not document.content.strip():
                raise ValueError("indexed document content must not be empty")
        with self._lock:
            try:
                self._connection.execute("BEGIN IMMEDIATE")
                existing: list[sqlite3.Row] = []
                for identifier_batch in _chunks(tuple(identifiers), 900):
                    placeholders = ",".join("?" for _ in identifier_batch)
                    existing.extend(
                        self._connection.execute(
                            f"SELECT rowid FROM retrieval_documents WHERE id IN ({placeholders})",
                            identifier_batch,
                        ).fetchall()
                    )
                self._connection.executemany(
                    "DELETE FROM retrieval_fts WHERE rowid = ?",
                    ((row["rowid"],) for row in existing),
                )
                self._connection.executemany(
                    "DELETE FROM retrieval_documents WHERE id = ?",
                    ((document.id,) for document in documents),
                )
                for document in documents:
                    cursor = self._connection.execute(
                        """INSERT INTO retrieval_documents(
                            id, project_id, source_kind, source_id, title, content,
                            locator_json, metadata_json, indexed_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            document.id,
                            document.project_id,
                            document.source_kind,
                            document.source_id,
                            document.title,
                            document.content,
                            json.dumps(dict(document.locator), sort_keys=True),
                            json.dumps(dict(document.metadata), sort_keys=True),
                            document.indexed_at.astimezone(UTC).isoformat(),
                        ),
                    )
                    self._connection.execute(
                        "INSERT INTO retrieval_fts(rowid, title, content) VALUES (?, ?, ?)",
                        (cursor.lastrowid, document.title, document.content),
                    )
            except BaseException:
                self._connection.rollback()
                raise
            else:
                self._connection.commit()

    def remove_source(self, *, project_id: str, source_id: str) -> int:
        with self._lock:
            rows = self._connection.execute(
                "SELECT rowid FROM retrieval_documents WHERE project_id = ? AND source_id = ?",
                (project_id, source_id),
            ).fetchall()
            try:
                self._connection.execute("BEGIN IMMEDIATE")
                for row in rows:
                    self._connection.execute(
                        "DELETE FROM retrieval_fts WHERE rowid = ?", (row["rowid"],)
                    )
                cursor = self._connection.execute(
                    "DELETE FROM retrieval_documents WHERE project_id = ? AND source_id = ?",
                    (project_id, source_id),
                )
            except BaseException:
                self._connection.rollback()
                raise
            else:
                self._connection.commit()
                return cursor.rowcount

    def documents_for_sources(
        self,
        *,
        project_id: str,
        source_ids: Sequence[str],
        max_documents: int = 32,
    ) -> list[SearchDocument]:
        """Return deterministic exact-source context inside one privacy scope.

        Attachments and explicit references must not depend on lexical overlap
        with the user's prompt.  The project predicate is deliberately part of
        the same SQL statement as the source predicate so a guessed source ID
        can never cross a project boundary.
        """
        if not project_id.strip():
            raise ValueError("project_id is required")
        identifiers = tuple(dict.fromkeys(item.strip() for item in source_ids if item.strip()))
        if not identifiers:
            return []
        if len(identifiers) > 32:
            raise ValueError("at most 32 source IDs can be resolved")
        if not 1 <= max_documents <= 256:
            raise ValueError("max_documents must be between 1 and 256")
        per_source_limit = max(1, max_documents // len(identifiers))
        with self._lock:
            rows = [
                row
                for source_id in identifiers
                for row in self._connection.execute(
                    """SELECT * FROM retrieval_documents
                       WHERE project_id = ? AND source_id = ?
                       ORDER BY id LIMIT ?""",
                    (project_id, source_id, per_source_limit),
                ).fetchall()
            ][:max_documents]
        return [_decode(row) for row in rows]

    def search(self, plan: RetrievalPlan) -> list[SearchHit]:
        rows = self._candidate_rows(plan)
        if not rows:
            return []
        semantic: Mapping[str, float] = {}
        if plan.mode is RetrievalMode.HYBRID and self._semantic:
            semantic = self._semantic.score(
                plan.query, [row["id"] for row in rows], project_id=plan.project_id
            )
        return self._rank_hits(plan, rows, semantic)

    async def search_async(
        self,
        plan: RetrievalPlan,
        *,
        semantic_disclosure: CloudEmbeddingDisclosure | None = None,
    ) -> list[SearchHit]:
        """Lexical-first search with optional asynchronous semantic enrichment.

        The SQL project/source clauses execute before any query text is sent to an
        embedding provider. If the accelerator is absent or stale, this is exactly
        the always-available lexical result path.
        """
        rows = self._candidate_rows(plan)
        if not rows:
            return []
        semantic: Mapping[str, float] = {}
        if plan.mode is RetrievalMode.HYBRID and self._async_semantic:
            candidates = tuple(
                SemanticCandidate(
                    document_id=str(row["id"]),
                    project_id=str(row["project_id"]),
                    source_kind=str(row["source_kind"]),
                    content_hash=_decode(row).semantic_content_hash,
                )
                for row in rows
            )
            semantic = await self._async_semantic.ascore(
                plan.query,
                candidates,
                project_id=plan.project_id,
                disclosure=semantic_disclosure,
            )
        elif plan.mode is RetrievalMode.HYBRID and self._semantic:
            semantic = self._semantic.score(
                plan.query, [row["id"] for row in rows], project_id=plan.project_id
            )
        return self._rank_hits(plan, rows, semantic)

    def _candidate_rows(self, plan: RetrievalPlan) -> list[sqlite3.Row]:
        if not plan.project_id.strip():
            raise ValueError("project_id is required")
        terms = _terms(plan.query)
        if not terms:
            return []
        fts_query = " AND ".join(f'"{term.replace(chr(34), chr(34) * 2)}"' for term in terms)
        clauses = ["d.project_id = ?", "retrieval_fts MATCH ?"]
        arguments: list[object] = [plan.project_id, fts_query]
        if plan.source_kinds:
            placeholders = ",".join("?" for _ in plan.source_kinds)
            clauses.append(f"d.source_kind IN ({placeholders})")
            arguments.extend(plan.source_kinds)
        arguments.append(plan.candidate_limit)
        sql = (
            """SELECT d.*, bm25(retrieval_fts, 2.0, 1.0) AS rank
                 FROM retrieval_fts JOIN retrieval_documents d ON d.rowid = retrieval_fts.rowid
                 WHERE """
            + " AND ".join(clauses)
            + " ORDER BY rank LIMIT ?"
        )
        with self._lock:
            rows = self._connection.execute(sql, arguments).fetchall()
        return list(rows)

    def _rank_hits(
        self,
        plan: RetrievalPlan,
        rows: Sequence[sqlite3.Row],
        semantic: Mapping[str, float],
    ) -> list[SearchHit]:
        terms = _terms(plan.query)
        lexical = _normalized_lexical_scores([row["rank"] for row in rows])
        hits: list[SearchHit] = []
        for row, lexical_score in zip(rows, lexical, strict=True):
            semantic_score = semantic.get(row["id"])
            if semantic_score is None:
                score = lexical_score
            else:
                semantic_score = max(0.0, min(1.0, float(semantic_score)))
                score = plan.lexical_weight * lexical_score + plan.semantic_weight * semantic_score
            document = _decode(row)
            hits.append(
                SearchHit(
                    document=document,
                    score=score,
                    lexical_score=lexical_score,
                    semantic_score=semantic_score,
                    citation=Citation(
                        source_id=document.source_id,
                        title=document.title,
                        locator=document.locator,
                        excerpt=_excerpt(document.content, terms),
                    ),
                )
            )
        hits.sort(key=lambda item: (-item.score, item.document.id))
        return hits[: plan.limit]


def _terms(query: str) -> list[str]:
    return re.findall(r"[\w'-]+", query.casefold(), flags=re.UNICODE)[:32]


def _chunks(values: tuple[str, ...], size: int) -> list[tuple[str, ...]]:
    return [values[start : start + size] for start in range(0, len(values), size)]


def _normalized_lexical_scores(ranks: Sequence[float]) -> list[float]:
    # FTS5 bm25 returns better scores as more-negative values in common builds.
    values = [-float(rank) for rank in ranks]
    low, high = min(values), max(values)
    if math.isclose(low, high):
        return [1.0 for _ in values]
    return [(value - low) / (high - low) for value in values]


def _excerpt(content: str, terms: Sequence[str], radius: int = 100) -> str:
    folded = content.casefold()
    positions = [folded.find(term) for term in terms]
    positions = [position for position in positions if position >= 0]
    center = min(positions) if positions else 0
    start = max(0, center - radius)
    end = min(len(content), center + radius * 2)
    prefix = "…" if start else ""
    suffix = "…" if end < len(content) else ""
    return prefix + content[start:end].strip() + suffix


def _decode(row: sqlite3.Row) -> SearchDocument:
    return SearchDocument(
        id=row["id"],
        project_id=row["project_id"],
        source_kind=row["source_kind"],
        source_id=row["source_id"],
        title=row["title"],
        content=row["content"],
        locator=json.loads(row["locator_json"]),
        metadata=json.loads(row["metadata_json"]),
        indexed_at=datetime.fromisoformat(row["indexed_at"]).astimezone(UTC),
    )


_SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS retrieval_documents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    locator_json TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS retrieval_documents_project_source_idx
    ON retrieval_documents(project_id, source_kind, source_id);
CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_fts USING fts5(title, content, tokenize='unicode61');
"""
