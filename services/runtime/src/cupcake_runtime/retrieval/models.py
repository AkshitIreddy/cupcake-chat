from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from hashlib import sha256
from typing import Any


class RetrievalMode(StrEnum):
    LEXICAL = "lexical"
    HYBRID = "hybrid"


class DestinationKind(StrEnum):
    LOCAL = "local"
    CLOUD = "cloud"


class EmbeddingInputType(StrEnum):
    QUERY = "query"
    PASSAGE = "passage"


class SemanticIndexState(StrEnum):
    EMPTY = "empty"
    BUILDING = "building"
    READY = "ready"
    STALE = "stale"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class Citation:
    source_id: str
    title: str
    locator: Mapping[str, Any]
    excerpt: str


@dataclass(frozen=True, slots=True)
class SearchDocument:
    id: str
    project_id: str
    source_kind: str
    source_id: str
    title: str
    content: str
    locator: Mapping[str, Any] = field(default_factory=dict[str, Any])
    metadata: Mapping[str, Any] = field(default_factory=dict[str, Any])
    indexed_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    @property
    def semantic_content(self) -> str:
        return f"{self.title}\n\n{self.content}"

    @property
    def semantic_content_hash(self) -> str:
        return sha256(self.semantic_content.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class SemanticCandidate:
    """A candidate already admitted by an authoritative privacy-scoped query."""

    document_id: str
    project_id: str
    source_kind: str
    content_hash: str


@dataclass(frozen=True, slots=True)
class EmbeddingModelDescriptor:
    provider_id: str
    model_id: str
    model_version: str
    dimensions: int
    destination: DestinationKind
    disclosure: str

    def __post_init__(self) -> None:
        if not self.provider_id.strip():
            raise ValueError("embedding provider_id must not be empty")
        if not self.model_id.strip() or not self.model_version.strip():
            raise ValueError("embedding model id and version must not be empty")
        if not 1 <= self.dimensions <= 65_536:
            raise ValueError("embedding dimensions must be between 1 and 65536")
        if not self.disclosure.strip():
            raise ValueError("embedding data-flow disclosure must not be empty")

    @property
    def fingerprint(self) -> str:
        value = (
            f"{self.provider_id}\0{self.model_id}\0{self.model_version}\0"
            f"{self.dimensions}\0{self.destination.value}"
        )
        return sha256(value.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class CloudEmbeddingDisclosure:
    """Explicit consent for one cloud embedding route and one project boundary."""

    project_id: str
    provider_id: str
    model_id: str
    acknowledged: bool
    acknowledged_at: datetime = field(default_factory=lambda: datetime.now(UTC))


@dataclass(frozen=True, slots=True)
class SemanticIndexStatus:
    state: SemanticIndexState
    model_fingerprint: str | None
    active_generation: str | None
    document_count: int
    updated_at: datetime | None
    failure: str | None = None


@dataclass(frozen=True, slots=True)
class SemanticEnrichmentReport:
    generation: str
    model_fingerprint: str
    enriched: int
    skipped: int
    stale_removed: int
    promoted: bool


@dataclass(frozen=True, slots=True)
class RetrievalPlan:
    query: str
    project_id: str
    mode: RetrievalMode
    source_kinds: tuple[str, ...] = ()
    lexical_weight: float = 0.65
    semantic_weight: float = 0.35
    limit: int = 20
    candidate_limit: int = 100


@dataclass(frozen=True, slots=True)
class SearchHit:
    document: SearchDocument
    score: float
    lexical_score: float
    semantic_score: float | None
    citation: Citation


@dataclass(frozen=True, slots=True)
class ContextItem:
    kind: str
    id: str
    label: str
    token_count: int
    project_id: str | None
    destination: DestinationKind
    provenance: Mapping[str, Any] = field(default_factory=dict[str, Any])


@dataclass(frozen=True, slots=True)
class ContextInspectorRecord:
    run_id: str
    project_id: str | None
    model_id: str
    destination: DestinationKind
    items: tuple[ContextItem, ...]
    total_tokens: int
    created_at: datetime


def estimate_tokens(text: str) -> int:
    # A deterministic, deliberately conservative fallback. Provider tokenizers can
    # replace this at assembly time without changing the inspector contract.
    return max(1, (len(text) + 3) // 4)
