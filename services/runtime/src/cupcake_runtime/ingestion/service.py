from __future__ import annotations

import csv
import fnmatch
import hashlib
import io
import mimetypes
import os
import re
import subprocess
import tarfile
import uuid
import zipfile
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Protocol
from xml.etree import ElementTree

from .models import (
    IngestedChunk,
    IngestionLimits,
    IngestionResult,
    IngestionStatus,
    LimitExceededError,
    SourceFormat,
    SourceLocator,
    UnsafeSourceError,
    UnsupportedFormatError,
)
from .safety import read_bounded, safe_source_path, validate_archive_member
from .worker_client import DoclingWorkerAdapter

TEXT_EXTENSIONS = {
    ".txt",
    ".md",
    ".markdown",
    ".rst",
    ".log",
    ".json",
    ".jsonl",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".cfg",
    ".xml",
    ".html",
    ".css",
    ".sql",
}
CODE_EXTENSIONS = {
    ".py",
    ".pyi",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".mjs",
    ".cjs",
    ".rs",
    ".go",
    ".java",
    ".kt",
    ".kts",
    ".c",
    ".h",
    ".cc",
    ".cpp",
    ".hpp",
    ".cs",
    ".swift",
    ".rb",
    ".php",
    ".sh",
    ".bash",
    ".zsh",
    ".ps1",
    ".lua",
}
DOCUMENT_EXTENSIONS = {".docx", ".odt"}
SHEET_EXTENSIONS = {".csv", ".tsv", ".xlsx"}
ARCHIVE_EXTENSIONS = {".zip", ".tar", ".tgz", ".gz", ".bz2", ".xz"}
MEDIA_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".svg",
    ".mp3",
    ".wav",
    ".flac",
    ".m4a",
    ".ogg",
    ".mp4",
    ".mov",
    ".mkv",
    ".webm",
}


class BroadDocumentAdapter(Protocol):
    @property
    def available(self) -> bool: ...

    def convert(self, path: Path) -> Sequence[tuple[str, SourceLocator]]: ...


class DoclingAdapter(DoclingWorkerAdapter):
    """Compatibility name for the fail-closed out-of-process Docling adapter."""


@dataclass(slots=True)
class IngestionService:
    limits: IngestionLimits = field(default_factory=IngestionLimits)
    broad_adapter: BroadDocumentAdapter | None = None

    def __post_init__(self) -> None:
        configure = getattr(self.broad_adapter, "configure_limits", None)
        if callable(configure):
            configure(self.limits)

    def ingest_path(
        self,
        *,
        project_id: str,
        path: str | Path,
        granted_root: str | Path | None = None,
    ) -> IngestionResult:
        if not project_id.strip():
            raise ValueError("project_id is required")
        supplied = Path(path)
        root = (
            Path(granted_root)
            if granted_root
            else (supplied if supplied.is_dir() else supplied.parent)
        )
        resolved = safe_source_path(supplied, root)
        if resolved.is_dir():
            return self.ingest_repository(project_id=project_id, root=resolved)
        extension = _effective_suffix(resolved)
        if extension in TEXT_EXTENSIONS or extension in CODE_EXTENSIONS:
            return self._ingest_text_file(project_id, resolved, extension in CODE_EXTENSIONS)
        if extension == ".pdf":
            return self._ingest_pdf(project_id, resolved)
        if extension in DOCUMENT_EXTENSIONS:
            return self._ingest_document(project_id, resolved)
        if extension in SHEET_EXTENSIONS:
            return self._ingest_sheet(project_id, resolved)
        if extension in ARCHIVE_EXTENSIONS:
            return self._ingest_archive(project_id, resolved)
        if extension in MEDIA_EXTENSIONS:
            return self._ingest_media(project_id, resolved)
        if self.broad_adapter and self.broad_adapter.available:
            return self._ingest_broad(project_id, resolved)
        raise UnsupportedFormatError(f"unsupported source format: {resolved.suffix or '(none)'}")

    def ingest_repository(self, *, project_id: str, root: str | Path) -> IngestionResult:
        root_path = Path(root)
        resolved = safe_source_path(root_path, root_path)
        source_id = _source_id(resolved)
        chunks: list[IngestedChunk] = []
        warnings: list[str] = []
        file_count = 0
        for path in self._repository_files(resolved, warnings):
            file_count += 1
            if file_count > self.limits.max_repository_files:
                raise LimitExceededError(
                    f"repository exceeds {self.limits.max_repository_files} ingestible files"
                )
            extension = _effective_suffix(path)
            if extension not in TEXT_EXTENSIONS | CODE_EXTENSIONS:
                continue
            try:
                data = read_bounded(path, self.limits.max_file_bytes)
                text = _decode_text(data, self.limits.max_text_characters)
            except (UnicodeError, LimitExceededError) as exc:
                warnings.append(f"Skipped {path.relative_to(resolved)}: {exc}")
                continue
            relative = path.relative_to(resolved).as_posix()
            chunks.extend(
                self._text_chunks(
                    project_id=project_id,
                    source_id=source_id,
                    title=relative,
                    text=text,
                    source_format=SourceFormat.CODE
                    if extension in CODE_EXTENSIONS
                    else SourceFormat.TEXT,
                    path=relative,
                    ordinal_start=len(chunks),
                )
            )
        return IngestionResult(
            source_id=source_id,
            project_id=project_id,
            source_path=resolved,
            format=SourceFormat.REPOSITORY,
            status=IngestionStatus.PARTIAL if warnings else IngestionStatus.COMPLETE,
            chunks=tuple(chunks),
            warnings=tuple(warnings),
            metadata={"files_considered": file_count, "network_access": False},
        )

    def _ingest_text_file(self, project_id: str, path: Path, code: bool) -> IngestionResult:
        text = _decode_text(
            read_bounded(path, self.limits.max_file_bytes), self.limits.max_text_characters
        )
        source_id = _source_id(path)
        chunks = self._text_chunks(
            project_id=project_id,
            source_id=source_id,
            title=path.name,
            text=text,
            source_format=SourceFormat.CODE if code else SourceFormat.TEXT,
            path=path.name,
        )
        return IngestionResult(
            source_id,
            project_id,
            path,
            SourceFormat.CODE if code else SourceFormat.TEXT,
            IngestionStatus.COMPLETE,
            tuple(chunks),
            metadata={"network_access": False},
        )

    def _ingest_pdf(self, project_id: str, path: Path) -> IngestionResult:
        data = read_bounded(path, self.limits.max_file_bytes)
        try:
            from pypdf import PdfReader  # type: ignore[import-not-found]
        except ImportError:
            if self.broad_adapter and self.broad_adapter.available:
                return self._ingest_broad(project_id, path, source_format=SourceFormat.PDF)
            raise UnsupportedFormatError("PDF ingestion requires pypdf or Docling") from None
        reader = PdfReader(io.BytesIO(data), strict=True)
        if len(reader.pages) > self.limits.max_document_pages:
            raise LimitExceededError("PDF page count exceeds configured limit")
        source_id = _source_id(path)
        chunks: list[IngestedChunk] = []
        total = 0
        for page_number, page in enumerate(reader.pages, start=1):
            text = page.extract_text() or ""
            total += len(text)
            if total > self.limits.max_text_characters:
                raise LimitExceededError("PDF extracted text exceeds configured limit")
            if text.strip():
                chunks.append(
                    IngestedChunk(
                        id=_chunk_id(source_id, page_number, text),
                        project_id=project_id,
                        source_id=source_id,
                        format=SourceFormat.PDF,
                        title=path.name,
                        content=text,
                        locator=SourceLocator(path=path.name, page=page_number),
                        ordinal=page_number - 1,
                    )
                )
        return IngestionResult(
            source_id, project_id, path, SourceFormat.PDF, IngestionStatus.COMPLETE, tuple(chunks)
        )

    def _ingest_document(self, project_id: str, path: Path) -> IngestionResult:
        if path.suffix.casefold() == ".docx":
            data = read_bounded(path, self.limits.max_file_bytes)
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                self._validate_zip(archive)
                try:
                    xml = archive.read("word/document.xml")
                except KeyError as exc:
                    raise UnsupportedFormatError("DOCX has no word/document.xml") from exc
            root = _parse_xml(xml)
            paragraphs: list[str] = []
            for paragraph in root.iter(
                "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p"
            ):
                text = "".join(
                    node.text or ""
                    for node in paragraph.iter(
                        "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"
                    )
                )
                if text.strip():
                    paragraphs.append(text)
                    if len(paragraphs) > self.limits.max_document_entries:
                        raise LimitExceededError("DOCX paragraph count exceeds configured limit")
            text = "\n\n".join(paragraphs)
            source_id = _source_id(path)
            chunks = self._text_chunks(
                project_id=project_id,
                source_id=source_id,
                title=path.name,
                text=text,
                source_format=SourceFormat.DOCUMENT,
                path=path.name,
            )
            return IngestionResult(
                source_id,
                project_id,
                path,
                SourceFormat.DOCUMENT,
                IngestionStatus.COMPLETE,
                tuple(chunks),
            )
        return self._ingest_broad(project_id, path, source_format=SourceFormat.DOCUMENT)

    def _ingest_sheet(self, project_id: str, path: Path) -> IngestionResult:
        source_id = _source_id(path)
        if path.suffix.casefold() in {".csv", ".tsv"}:
            data = read_bounded(path, self.limits.max_file_bytes)
            text = _decode_text(data, self.limits.max_text_characters)
            dialect = "excel-tab" if path.suffix.casefold() == ".tsv" else "excel"
            rows = list(csv.reader(io.StringIO(text), dialect=dialect))
            if len(rows) > self.limits.max_document_entries:
                raise LimitExceededError("spreadsheet row count exceeds configured limit")
            rendered = "\n".join("\t".join(cell for cell in row) for row in rows)
            locator = SourceLocator(
                path=path.name,
                sheet="Sheet1",
                cell_range=(
                    f"A1:{_column_name(max((len(row) for row in rows), default=1))}"
                    f"{max(len(rows), 1)}"
                ),
            )
            chunk = IngestedChunk(
                _chunk_id(source_id, 0, rendered),
                project_id,
                source_id,
                SourceFormat.SPREADSHEET,
                path.name,
                rendered,
                locator,
                0,
            )
            return IngestionResult(
                source_id,
                project_id,
                path,
                SourceFormat.SPREADSHEET,
                IngestionStatus.COMPLETE,
                (chunk,),
            )
        data = read_bounded(path, self.limits.max_file_bytes)
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            self._validate_zip(archive)
            shared = _xlsx_shared_strings(archive)
            names = _xlsx_sheet_names(archive)
            chunks: list[IngestedChunk] = []
            for index, member in enumerate(
                sorted(
                    name
                    for name in archive.namelist()
                    if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name)
                )
            ):
                if index >= self.limits.max_document_entries:
                    raise LimitExceededError("spreadsheet sheet count exceeds configured limit")
                rows, cell_range = _xlsx_rows(archive.read(member), shared)
                rendered = "\n".join("\t".join(row) for row in rows)
                if rendered.strip():
                    sheet = names[index] if index < len(names) else f"Sheet{index + 1}"
                    chunks.append(
                        IngestedChunk(
                            _chunk_id(source_id, index, rendered),
                            project_id,
                            source_id,
                            SourceFormat.SPREADSHEET,
                            f"{path.name} — {sheet}",
                            rendered,
                            SourceLocator(path=path.name, sheet=sheet, cell_range=cell_range),
                            index,
                        )
                    )
        return IngestionResult(
            source_id,
            project_id,
            path,
            SourceFormat.SPREADSHEET,
            IngestionStatus.COMPLETE,
            tuple(chunks),
        )

    def _ingest_archive(self, project_id: str, path: Path) -> IngestionResult:
        data = read_bounded(path, self.limits.max_file_bytes)
        source_id = _source_id(path)
        chunks: list[IngestedChunk] = []
        warnings: list[str] = []
        if zipfile.is_zipfile(io.BytesIO(data)):
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                self._validate_zip(archive)
                for zip_info in archive.infolist():
                    if zip_info.is_dir():
                        continue
                    member = validate_archive_member(zip_info.filename)
                    if member.suffix.casefold() not in TEXT_EXTENSIONS | CODE_EXTENSIONS:
                        continue
                    member_data = archive.read(zip_info)
                    self._append_archive_member(
                        chunks, warnings, project_id, source_id, path.name, member, member_data
                    )
        else:
            try:
                with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
                    members = archive.getmembers()
                    self._validate_tar(members)
                    total_uncompressed = sum(member.size for member in members)
                    ratio = total_uncompressed / max(len(data), 1)
                    if ratio > self.limits.max_archive_ratio:
                        raise LimitExceededError(
                            "archive compression ratio exceeds configured limit"
                        )
                    for tar_info in members:
                        if not tar_info.isfile():
                            continue
                        member = validate_archive_member(tar_info.name)
                        if member.suffix.casefold() not in TEXT_EXTENSIONS | CODE_EXTENSIONS:
                            continue
                        source = archive.extractfile(tar_info)
                        if source:
                            self._append_archive_member(
                                chunks,
                                warnings,
                                project_id,
                                source_id,
                                path.name,
                                member,
                                source.read(self.limits.max_file_bytes + 1),
                            )
            except tarfile.TarError as exc:
                raise UnsupportedFormatError("archive is not a supported ZIP or TAR") from exc
        return IngestionResult(
            source_id,
            project_id,
            path,
            SourceFormat.ARCHIVE,
            IngestionStatus.PARTIAL if warnings else IngestionStatus.COMPLETE,
            tuple(chunks),
            tuple(warnings),
            {"network_access": False},
        )

    def _ingest_media(self, project_id: str, path: Path) -> IngestionResult:
        data = read_bounded(path, self.limits.max_file_bytes)
        source_id = _source_id(path)
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        metadata = {
            "mime_type": mime,
            "byte_size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "extraction": "metadata-only",
            "network_access": False,
        }
        content = f"Media file {path.name} ({mime}, {len(data)} bytes)"
        chunk = IngestedChunk(
            _chunk_id(source_id, 0, content),
            project_id,
            source_id,
            SourceFormat.MEDIA,
            path.name,
            content,
            SourceLocator(path=path.name, timestamp_start_ms=0),
            0,
        )
        return IngestionResult(
            source_id,
            project_id,
            path,
            SourceFormat.MEDIA,
            IngestionStatus.PARTIAL,
            (chunk,),
            ("Content extraction is unavailable; indexed metadata only.",),
            metadata,
        )

    def _ingest_broad(
        self, project_id: str, path: Path, source_format: SourceFormat = SourceFormat.DOCUMENT
    ) -> IngestionResult:
        if not self.broad_adapter or not self.broad_adapter.available:
            raise UnsupportedFormatError("no broad document adapter is available")
        source_id = _source_id(path)
        chunks: list[IngestedChunk] = []
        total = 0
        for text, locator in self.broad_adapter.convert(path):
            total += len(text)
            if total > self.limits.max_text_characters:
                raise LimitExceededError("converted document exceeds configured text limit")
            segments = (
                text[offset : offset + self.limits.max_chunk_characters]
                for offset in range(0, len(text), self.limits.max_chunk_characters)
            )
            for offset, segment in enumerate(segments):
                ordinal = len(chunks)
                chunks.append(
                    IngestedChunk(
                        _chunk_id(source_id, ordinal, segment),
                        project_id,
                        source_id,
                        source_format,
                        path.name,
                        segment,
                        SourceLocator(
                            path=locator.path,
                            line_start=locator.line_start,
                            line_end=locator.line_end,
                            page=locator.page,
                            sheet=locator.sheet,
                            cell_range=locator.cell_range,
                            archive_member=locator.archive_member,
                            timestamp_start_ms=locator.timestamp_start_ms,
                            timestamp_end_ms=locator.timestamp_end_ms,
                            metadata={
                                **locator.metadata,
                                "character_offset": offset * self.limits.max_chunk_characters,
                            },
                        ),
                        ordinal,
                    )
                )
        return IngestionResult(
            source_id,
            project_id,
            path,
            source_format,
            IngestionStatus.COMPLETE,
            tuple(chunks),
            metadata={"adapter": type(self.broad_adapter).__name__, "network_access": False},
        )

    def _text_chunks(
        self,
        *,
        project_id: str,
        source_id: str,
        title: str,
        text: str,
        source_format: SourceFormat,
        path: str,
        ordinal_start: int = 0,
    ) -> list[IngestedChunk]:
        lines = text.splitlines(keepends=True) or [text]
        chunks: list[IngestedChunk] = []
        buffer: list[str] = []
        length = 0
        start_line = 1
        ordinal = ordinal_start
        for line_number, line in enumerate(lines, start=1):
            if buffer and length + len(line) > self.limits.max_chunk_characters:
                content = "".join(buffer).rstrip()
                chunks.append(
                    IngestedChunk(
                        _chunk_id(source_id, ordinal, content),
                        project_id,
                        source_id,
                        source_format,
                        title,
                        content,
                        SourceLocator(path=path, line_start=start_line, line_end=line_number - 1),
                        ordinal,
                    )
                )
                ordinal += 1
                buffer, length, start_line = [], 0, line_number
            if len(line) > self.limits.max_chunk_characters:
                for offset in range(0, len(line), self.limits.max_chunk_characters):
                    segment = line[offset : offset + self.limits.max_chunk_characters]
                    chunks.append(
                        IngestedChunk(
                            _chunk_id(source_id, ordinal, segment),
                            project_id,
                            source_id,
                            source_format,
                            title,
                            segment,
                            SourceLocator(
                                path=path,
                                line_start=line_number,
                                line_end=line_number,
                                metadata={"character_offset": offset},
                            ),
                            ordinal,
                        )
                    )
                    ordinal += 1
                buffer, length, start_line = [], 0, line_number + 1
            else:
                buffer.append(line)
                length += len(line)
        if buffer:
            content = "".join(buffer).rstrip()
            if content:
                chunks.append(
                    IngestedChunk(
                        _chunk_id(source_id, ordinal, content),
                        project_id,
                        source_id,
                        source_format,
                        title,
                        content,
                        SourceLocator(path=path, line_start=start_line, line_end=len(lines)),
                        ordinal,
                    )
                )
        return chunks

    def _repository_files(self, root: Path, warnings: list[str]) -> Iterator[Path]:
        ignored_directories = {
            ".git",
            ".hg",
            ".svn",
            "node_modules",
            "__pycache__",
            ".venv",
            "dist",
            "build",
        }
        for current, directories, files in os.walk(root, followlinks=False):
            current_path = Path(current)
            safe_directories: list[str] = []
            for name in sorted(directories):
                candidate = current_path / name
                if candidate.is_symlink():
                    warnings.append(f"Skipped symbolic link {candidate.relative_to(root)}")
                elif name not in ignored_directories and not self._git_ignored(root, candidate):
                    safe_directories.append(name)
            directories[:] = safe_directories
            for name in sorted(files):
                candidate = current_path / name
                if candidate.is_symlink():
                    warnings.append(f"Skipped symbolic link {candidate.relative_to(root)}")
                elif not self._git_ignored(root, candidate):
                    yield candidate

    @staticmethod
    def _git_ignored(root: Path, path: Path) -> bool:
        relative = path.relative_to(root).as_posix()
        if (root / ".git").exists():
            try:
                result = subprocess.run(
                    ["git", "-C", str(root), "check-ignore", "--quiet", "--", relative],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                    timeout=2,
                )
            except (OSError, subprocess.TimeoutExpired):
                pass
            else:
                if result.returncode in (0, 1):
                    return result.returncode == 0
        return _fallback_gitignore(root, relative, path.is_dir())

    def _validate_zip(self, archive: zipfile.ZipFile) -> None:
        infos = archive.infolist()
        if len(infos) > self.limits.max_archive_members:
            raise LimitExceededError("archive contains too many members")
        total = 0
        compressed = 0
        normalized_names: set[str] = set()
        for info in infos:
            member = validate_archive_member(info.filename.rstrip("/") or info.filename)
            normalized_name = member.as_posix().casefold()
            if normalized_name in normalized_names:
                raise UnsafeSourceError(f"archive contains duplicate member paths: {info.filename}")
            normalized_names.add(normalized_name)
            total += info.file_size
            compressed += max(info.compress_size, 1)
            mode = info.external_attr >> 16
            if (mode & 0o170000) == 0o120000:
                raise UnsafeSourceError(f"archive contains a symbolic link: {info.filename}")
        if total > self.limits.max_archive_uncompressed_bytes:
            raise LimitExceededError("archive uncompressed size exceeds configured limit")
        if total / max(compressed, 1) > self.limits.max_archive_ratio:
            raise LimitExceededError("archive compression ratio exceeds configured limit")

    def _validate_tar(self, members: Sequence[tarfile.TarInfo]) -> None:
        if len(members) > self.limits.max_archive_members:
            raise LimitExceededError("archive contains too many members")
        total = 0
        for info in members:
            validate_archive_member(info.name.rstrip("/") or info.name)
            if info.issym() or info.islnk() or info.isdev() or info.isfifo():
                raise UnsafeSourceError(f"archive contains a special member: {info.name}")
            total += info.size
        if total > self.limits.max_archive_uncompressed_bytes:
            raise LimitExceededError("archive uncompressed size exceeds configured limit")

    def _append_archive_member(
        self,
        chunks: list[IngestedChunk],
        warnings: list[str],
        project_id: str,
        source_id: str,
        archive_name: str,
        member: PurePosixPath,
        data: bytes,
    ) -> None:
        if len(data) > self.limits.max_file_bytes:
            warnings.append(f"Skipped {member}: member exceeds file limit")
            return
        try:
            text = _decode_text(data, self.limits.max_text_characters)
        except (UnicodeError, LimitExceededError) as exc:
            warnings.append(f"Skipped {member}: {exc}")
            return
        member_chunks = self._text_chunks(
            project_id=project_id,
            source_id=source_id,
            title=f"{archive_name}/{member}",
            text=text,
            source_format=SourceFormat.CODE
            if member.suffix.casefold() in CODE_EXTENSIONS
            else SourceFormat.TEXT,
            path=archive_name,
            ordinal_start=len(chunks),
        )
        for chunk in member_chunks:
            chunks.append(
                IngestedChunk(
                    chunk.id,
                    chunk.project_id,
                    chunk.source_id,
                    chunk.format,
                    chunk.title,
                    chunk.content,
                    SourceLocator(
                        path=archive_name,
                        line_start=chunk.locator.line_start,
                        line_end=chunk.locator.line_end,
                        archive_member=member.as_posix(),
                        metadata=chunk.locator.metadata,
                    ),
                    chunk.ordinal,
                )
            )


def _decode_text(data: bytes, max_characters: int) -> str:
    if b"\x00" in data[:8192]:
        raise UnicodeError("file appears to be binary")
    text = data.decode("utf-8-sig", errors="strict")
    if len(text) > max_characters:
        raise LimitExceededError("decoded text exceeds configured limit")
    return text


def _effective_suffix(path: Path) -> str:
    name = path.name.casefold()
    if name.endswith(".tar.gz") or name.endswith(".tar.bz2") or name.endswith(".tar.xz"):
        return ".tar"
    return path.suffix.casefold()


def _source_id(path: Path) -> str:
    stat = path.stat(follow_symlinks=False)
    seed = f"{path.resolve()}\0{stat.st_size}\0{stat.st_mtime_ns}"
    return str(uuid.uuid5(uuid.NAMESPACE_URL, seed))


def _chunk_id(source_id: str, ordinal: int, text: str) -> str:
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return str(uuid.uuid5(uuid.UUID(source_id), f"{ordinal}:{digest}"))


def _column_name(column: int) -> str:
    result = ""
    while column:
        column, remainder = divmod(column - 1, 26)
        result = chr(65 + remainder) + result
    return result or "A"


def _xlsx_shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        xml = archive.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    root = _parse_xml(xml)
    namespace = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    return [
        "".join(node.text or "" for node in item.iter(namespace + "t"))
        for item in root.iter(namespace + "si")
    ]


def _xlsx_sheet_names(archive: zipfile.ZipFile) -> list[str]:
    try:
        root = _parse_xml(archive.read("xl/workbook.xml"))
    except KeyError:
        return []
    namespace = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    return [item.attrib.get("name", "") for item in root.iter(namespace + "sheet")]


def _xlsx_rows(xml: bytes, shared: Sequence[str]) -> tuple[list[list[str]], str]:
    root = _parse_xml(xml)
    namespace = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    rows: list[list[str]] = []
    max_column = 1
    max_row = 1
    for row_element in root.iter(namespace + "row"):
        values: dict[int, str] = {}
        row_number = int(row_element.attrib.get("r", len(rows) + 1))
        max_row = max(max_row, row_number)
        for cell in row_element.iter(namespace + "c"):
            reference = cell.attrib.get("r", "A1")
            match = re.match(r"([A-Z]+)", reference)
            column = _column_number(match.group(1) if match else "A")
            value_node = cell.find(namespace + "v")
            inline = cell.find(namespace + "is")
            if inline is not None:
                value = "".join(node.text or "" for node in inline.iter(namespace + "t"))
            elif value_node is None:
                value = ""
            elif cell.attrib.get("t") == "s":
                index = int(value_node.text or "0")
                value = shared[index] if 0 <= index < len(shared) else ""
            else:
                value = value_node.text or ""
            values[column] = value
            max_column = max(max_column, column)
        rows.append([values.get(column, "") for column in range(1, max(values, default=1) + 1)])
    return rows, f"A1:{_column_name(max_column)}{max_row}"


def _column_number(name: str) -> int:
    result = 0
    for character in name:
        result = result * 26 + (ord(character) - 64)
    return result


def _parse_xml(data: bytes) -> ElementTree.Element:
    prefix = data[:4096].upper()
    if b"<!DOCTYPE" in prefix or b"<!ENTITY" in prefix:
        raise UnsafeSourceError("document XML contains a prohibited DTD or entity declaration")
    try:
        return ElementTree.fromstring(data)
    except ElementTree.ParseError as exc:
        raise UnsupportedFormatError("document contains malformed XML") from exc


def _fallback_gitignore(root: Path, relative: str, is_directory: bool) -> bool:
    """Conservative fallback for environments where Git is not installed.

    It intentionally supports only the common pattern subset. Negated patterns
    and exact Git precedence remain delegated to ``git check-ignore``.
    """
    patterns: list[str] = []
    ignore_file = root / ".gitignore"
    try:
        lines = ignore_file.read_text(encoding="utf-8-sig").splitlines()
    except (FileNotFoundError, UnicodeError, OSError):
        return False
    for line in lines:
        pattern = line.strip()
        if not pattern or pattern.startswith("#") or pattern.startswith("!"):
            continue
        patterns.append(pattern)
    relative = relative.rstrip("/")
    for pattern in patterns:
        directory_only = pattern.endswith("/")
        pattern = pattern.rstrip("/")
        anchored = pattern.startswith("/")
        pattern = pattern.lstrip("/")
        if directory_only and not is_directory:
            continue
        if anchored and fnmatch.fnmatchcase(relative, pattern):
            return True
        if fnmatch.fnmatchcase(relative, pattern) or fnmatch.fnmatchcase(
            Path(relative).name, pattern
        ):
            return True
        if "/" not in pattern and any(
            fnmatch.fnmatchcase(part, pattern) for part in PurePosixPath(relative).parts
        ):
            return True
    return False
