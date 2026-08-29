from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any


class SourceFormat(StrEnum):
    TEXT = "text"
    CODE = "code"
    REPOSITORY = "repository"
    PDF = "pdf"
    DOCUMENT = "document"
    SPREADSHEET = "spreadsheet"
    ARCHIVE = "archive"
    MEDIA = "media"


class IngestionStatus(StrEnum):
    COMPLETE = "complete"
    PARTIAL = "partial"
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True, slots=True)
class SourceLocator:
    path: str
    line_start: int | None = None
    line_end: int | None = None
    page: int | None = None
    sheet: str | None = None
    cell_range: str | None = None
    archive_member: str | None = None
    timestamp_start_ms: int | None = None
    timestamp_end_ms: int | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict[str, Any])


@dataclass(frozen=True, slots=True)
class IngestedChunk:
    id: str
    project_id: str
    source_id: str
    format: SourceFormat
    title: str
    content: str
    locator: SourceLocator
    ordinal: int


@dataclass(frozen=True, slots=True)
class IngestionResult:
    source_id: str
    project_id: str
    source_path: Path
    format: SourceFormat
    status: IngestionStatus
    chunks: tuple[IngestedChunk, ...]
    warnings: tuple[str, ...] = ()
    metadata: Mapping[str, Any] = field(default_factory=dict[str, Any])


@dataclass(frozen=True, slots=True)
class IngestionLimits:
    max_file_bytes: int = 128 * 1024 * 1024
    max_text_characters: int = 8_000_000
    max_archive_members: int = 2_000
    max_archive_uncompressed_bytes: int = 512 * 1024 * 1024
    max_archive_ratio: float = 200.0
    max_chunk_characters: int = 12_000
    max_repository_files: int = 50_000
    max_document_pages: int = 2_000
    max_document_entries: int = 20_000
    max_document_worker_output_bytes: int = 64 * 1024 * 1024
    document_worker_timeout_seconds: int = 180

    def __post_init__(self) -> None:
        if (
            min(
                self.max_file_bytes,
                self.max_text_characters,
                self.max_archive_members,
                self.max_archive_uncompressed_bytes,
                self.max_chunk_characters,
                self.max_repository_files,
                self.max_document_pages,
                self.max_document_entries,
                self.max_document_worker_output_bytes,
                self.document_worker_timeout_seconds,
            )
            < 1
        ):
            raise ValueError("ingestion limits must be positive")
        if self.max_archive_ratio <= 1:
            raise ValueError("archive ratio limit must be greater than one")


class IngestionError(RuntimeError):
    pass


class UnsafeSourceError(IngestionError):
    pass


class LimitExceededError(IngestionError):
    pass


class UnsupportedFormatError(IngestionError):
    pass
