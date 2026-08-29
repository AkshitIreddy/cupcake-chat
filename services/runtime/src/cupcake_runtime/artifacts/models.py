from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any


class ArtifactKind(StrEnum):
    DOCUMENT = "document"
    CODE = "code"
    CONFIGURATION = "configuration"
    TABLE = "table"
    SPREADSHEET = "spreadsheet"
    IMAGE = "image"
    DIAGRAM = "diagram"
    WEBPAGE = "webpage"
    REPORT = "report"


@dataclass(frozen=True, slots=True)
class Artifact:
    id: str
    project_id: str
    title: str
    kind: ArtifactKind
    mime_type: str
    head_revision_id: str
    created_at: datetime
    updated_at: datetime
    metadata: Mapping[str, Any] = field(default_factory=dict[str, Any])


@dataclass(frozen=True, slots=True)
class ArtifactRevision:
    id: str
    artifact_id: str
    parent_revision_id: str | None
    object_digest: str
    byte_size: int
    author_kind: str
    change_summary: str | None
    created_at: datetime
    metadata: Mapping[str, Any] = field(default_factory=dict[str, Any])


@dataclass(frozen=True, slots=True)
class ArtifactSnapshot:
    artifact: Artifact
    revision: ArtifactRevision
    content: bytes


@dataclass(frozen=True, slots=True)
class ExportResult:
    artifact_id: str
    revision_id: str
    destination: str
    byte_size: int
    exported_at: datetime = field(default_factory=lambda: datetime.now(UTC))


class RevisionConflictError(RuntimeError):
    pass
