from __future__ import annotations

import argparse
import contextlib
import io
import os
import socket
import stat
import sys
import time
import zipfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import NoReturn
from xml.etree import ElementTree

from .models import SourceLocator
from .worker_protocol import (
    PROTOCOL_VERSION,
    WorkerDocument,
    WorkerEntry,
    WorkerParseRequest,
    WorkerProtocolError,
    WorkerResponseKind,
    decode_single_frame,
    encode_document,
    encode_frame,
    parse_request,
    read_frame,
    sha256_hex,
    write_frame,
)

_SENSITIVE_ENVIRONMENT_MARKERS = (
    "KEY",
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "CREDENTIAL",
    "AUTH",
    "COOKIE",
    "AWS_",
    "AZURE_",
    "GOOGLE_",
    "OPENAI",
    "ANTHROPIC",
    "COHERE",
    "MISTRAL",
    "XAI",
)
_ALLOWED_EXTENSIONS = {
    ".pdf",
    ".docx",
    ".odt",
    ".pptx",
    ".xlsx",
    ".html",
    ".xhtml",
    ".md",
    ".markdown",
    ".csv",
}
_REQUEST_FILE = "document-request.frame"
_RESPONSE_FILE = "document-response.frame"


class WorkerLimitError(RuntimeError):
    pass


class WorkerDeadlineError(RuntimeError):
    pass


class WorkerNetworkDeniedError(RuntimeError):
    pass


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--stage-root", required=True)
    parser.add_argument("--worker-transport", choices=("stdio", "staged"), default="stdio")
    arguments = parser.parse_args(argv)
    request: WorkerParseRequest | None = None
    stage: Path | None = None
    try:
        stage = _validate_stage_root(Path(arguments.stage_root))
        _reject_sensitive_environment()
        _install_process_network_guard()
        if arguments.worker_transport == "staged":
            payload = decode_single_frame(
                _read_path_bounded(stage / _REQUEST_FILE, 1 * 1024 * 1024 + 4)
            )
        else:
            payload = read_frame(sys.stdin.buffer)
            if sys.stdin.buffer.read(1):
                raise WorkerProtocolError("worker accepts exactly one request frame")
        request = parse_request(payload)
        _check_deadline(request)
        document = _parse_staged_document(stage, request)
        encoded = encode_document(document)
        if len(encoded) > request.limits.max_output_bytes:
            raise WorkerLimitError("structured result exceeds its byte limit")
        output_path = _write_immutable_output(stage, request.output_name, encoded)
        output_info = output_path.stat(follow_symlinks=False)
        pages = {entry.locator.page for entry in document.entries if entry.locator.page}
        response = {
                "version": PROTOCOL_VERSION,
                "kind": WorkerResponseKind.COMPLETE,
                "request_id": request.request_id,
                "stage_token": request.stage_token,
                "result": {
                    "output_name": request.output_name,
                    "output_size": output_info.st_size,
                    "output_sha256": sha256_hex(encoded),
                    "entry_count": len(document.entries),
                    "page_count": len(pages),
                },
            }
        _write_control_response(stage, arguments.worker_transport, response)
        return 0
    except BaseException as exc:
        _write_failure(stage, arguments.worker_transport, request, exc)
        return 1


def _parse_staged_document(stage: Path, request: WorkerParseRequest) -> WorkerDocument:
    if request.source_suffix not in _ALLOWED_EXTENSIONS:
        raise WorkerProtocolError("requested source format is not allowed")
    input_path = _stage_child(stage, request.input_name, must_exist=True)
    descriptor = os.open(
        input_path,
        os.O_RDONLY
        | int(getattr(os, "O_BINARY", 0))
        | int(getattr(os, "O_NOFOLLOW", 0)),
    )
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise WorkerProtocolError("staged input is not a regular file")
        if info.st_size != request.input_size or info.st_size > request.limits.max_input_bytes:
            raise WorkerProtocolError("staged input size does not match its descriptor")
        data = _read_descriptor_bounded(descriptor, request.limits.max_input_bytes)
    finally:
        os.close(descriptor)
    if sha256_hex(data) != request.input_sha256:
        raise WorkerProtocolError("staged input digest does not match its descriptor")
    _check_deadline(request)
    if request.source_suffix == ".odt":
        return _parse_odt(data, request)
    return _parse_docling(data, request)


def _parse_odt(data: bytes, request: WorkerParseRequest) -> WorkerDocument:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            _validate_zip_members(infos, request)
            try:
                content = archive.read("content.xml")
            except KeyError as exc:
                raise WorkerProtocolError("ODT document has no content.xml") from exc
    except zipfile.BadZipFile as exc:
        raise WorkerProtocolError("ODT document is not a valid ZIP container") from exc
    _check_deadline(request)
    if len(content) > request.limits.max_input_bytes:
        raise WorkerLimitError("ODT content.xml exceeds the input limit")
    prefix = content[:4096].upper()
    if b"<!DOCTYPE" in prefix or b"<!ENTITY" in prefix:
        raise WorkerProtocolError("ODT XML contains a prohibited DTD or entity")
    try:
        root = ElementTree.fromstring(content)
    except ElementTree.ParseError as exc:
        raise WorkerProtocolError("ODT content.xml is malformed") from exc
    paragraph_tags = {
        "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}p",
        "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}h",
    }
    paragraphs: list[str] = []
    total = 0
    for element in root.iter():
        if element.tag not in paragraph_tags:
            continue
        _check_deadline(request)
        text = "".join(element.itertext()).strip()
        if not text:
            continue
        total += len(text)
        if total > request.limits.max_text_characters:
            raise WorkerLimitError("ODT extracted text exceeds its character limit")
        paragraphs.append(text)
        if len(paragraphs) > request.limits.max_entries:
            raise WorkerLimitError("ODT paragraph count exceeds its entry limit")
    entries = tuple(
        WorkerEntry(
            text=text,
            locator=SourceLocator(
                path=request.source_name,
                metadata={"paragraph": index, "adapter": "odt-structured-worker"},
            ),
        )
        for index, text in enumerate(paragraphs, start=1)
    )
    return WorkerDocument(
        entries=entries,
        warnings=(),
        metadata={
            "adapter": "odt-structured-worker",
            "network_access": False,
            "network_enforcement": "broker-appcontainer-required",
            "process_guard": "python-socket-deny",
        },
    )


def _parse_docling(data: bytes, request: WorkerParseRequest) -> WorkerDocument:
    _check_deadline(request)
    try:
        from docling.datamodel.base_models import (  # pyright: ignore[reportMissingImports]
            DocumentStream,  # type: ignore[import-not-found]
        )
        from docling.document_converter import (  # pyright: ignore[reportMissingImports]
            DocumentConverter,  # type: ignore[import-not-found]
        )
    except ImportError as exc:
        raise WorkerProtocolError("Docling is not installed in the document worker") from exc
    _check_deadline(request)
    source = DocumentStream(name=request.source_name, stream=io.BytesIO(data))
    converter = DocumentConverter()
    try:
        result = converter.convert(
            source,
            raises_on_error=True,
            max_num_pages=request.limits.max_pages,
            max_file_size=request.limits.max_input_bytes,
        )
    except WorkerNetworkDeniedError:
        raise
    except Exception as exc:
        # Provider/library exceptions can contain absolute cache paths. Keep the
        # protocol error stable and intentionally omit the exception text.
        raise WorkerProtocolError("Docling could not convert the staged document") from exc
    _check_deadline(request)
    document = result.document
    page_numbers = sorted(int(page) for page in document.pages)
    if len(page_numbers) > request.limits.max_pages:
        raise WorkerLimitError("document page count exceeds its page limit")
    raw_entries: list[tuple[str, int | None]] = []
    if page_numbers:
        for page_number in page_numbers:
            _check_deadline(request)
            text = document.export_to_markdown(page_no=page_number)
            if text.strip():
                raw_entries.append((text, page_number))
    else:
        text = document.export_to_markdown()
        if text.strip():
            raw_entries.append((text, None))
    if len(raw_entries) > request.limits.max_entries:
        raise WorkerLimitError("document entry count exceeds its entry limit")
    total = sum(len(text) for text, _page in raw_entries)
    if total > request.limits.max_text_characters:
        raise WorkerLimitError("document extracted text exceeds its character limit")
    entries = tuple(
        WorkerEntry(
            text=text,
            locator=SourceLocator(
                path=request.source_name,
                page=page,
                metadata={"adapter": "docling-structured-worker"},
            ),
        )
        for text, page in raw_entries
    )
    return WorkerDocument(
        entries=entries,
        warnings=(),
        metadata={
            "adapter": "docling-structured-worker",
            "network_access": False,
            "network_enforcement": "broker-appcontainer-required",
            "process_guard": "python-socket-deny",
        },
    )


def _validate_zip_members(
    infos: Sequence[zipfile.ZipInfo], request: WorkerParseRequest
) -> None:
    if len(infos) > request.limits.max_entries:
        raise WorkerLimitError("document container has too many entries")
    total = 0
    for info in infos:
        normalized = info.filename.replace("\\", "/")
        parts = normalized.split("/")
        if (
            not normalized
            or normalized.startswith("/")
            or any(part in {"", ".", ".."} for part in parts if not info.is_dir())
            or ":" in parts[0]
            or "\x00" in normalized
        ):
            raise WorkerProtocolError("document container has an unsafe entry name")
        mode = info.external_attr >> 16
        if (mode & 0o170000) == 0o120000:
            raise WorkerProtocolError("document container has a symbolic-link entry")
        total += info.file_size
        if total > request.limits.max_input_bytes * 4:
            raise WorkerLimitError("document container expands beyond its limit")
        ratio = info.file_size / max(info.compress_size, 1)
        if ratio > 200:
            raise WorkerLimitError("document container compression ratio exceeds its limit")


def _validate_stage_root(stage: Path) -> Path:
    if stage.is_symlink():
        raise WorkerProtocolError("stage root cannot be a symbolic link")
    resolved = stage.resolve(strict=True)
    if not resolved.is_dir():
        raise WorkerProtocolError("stage root is not a directory")
    return resolved


def _stage_child(stage: Path, name: str, *, must_exist: bool) -> Path:
    candidate = stage / name
    if candidate.parent != stage:
        raise WorkerProtocolError("staged object escapes the stage root")
    if must_exist:
        if candidate.is_symlink():
            raise WorkerProtocolError("staged object cannot be a symbolic link")
        candidate.resolve(strict=True)
    return candidate


def _write_immutable_output(stage: Path, name: str, data: bytes) -> Path:
    destination = _stage_child(stage, name, must_exist=False)
    if destination.is_symlink():
        raise WorkerProtocolError("staged output cannot be a symbolic link")
    flags = os.O_WRONLY | os.O_TRUNC | int(getattr(os, "O_BINARY", 0)) | int(
        getattr(os, "O_NOFOLLOW", 0)
    )
    descriptor = os.open(destination, flags)
    try:
        _write_all(descriptor, data)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.chmod(destination, stat.S_IRUSR)
    return destination


def _read_descriptor_bounded(descriptor: int, max_bytes: int) -> bytes:
    result = bytearray()
    while len(result) <= max_bytes:
        block = os.read(descriptor, min(1024 * 1024, max_bytes + 1 - len(result)))
        if not block:
            break
        result.extend(block)
    if len(result) > max_bytes:
        raise WorkerLimitError("staged input exceeds its byte limit")
    return bytes(result)


def _write_all(descriptor: int, data: bytes) -> None:
    offset = 0
    while offset < len(data):
        written = os.write(descriptor, data[offset:])
        if written < 1:
            raise OSError("unable to write staged result")
        offset += written


def _check_deadline(request: WorkerParseRequest) -> None:
    if int(time.time() * 1_000) > request.limits.deadline_unix_ms:
        raise WorkerDeadlineError("document worker deadline expired")


def _reject_sensitive_environment() -> None:
    names = {name.upper() for name in os.environ}
    unsafe = sorted(
        name
        for name in names
        if any(marker in name for marker in _SENSITIVE_ENVIRONMENT_MARKERS)
        and name not in {"PYTHONDONTWRITEBYTECODE"}
    )
    if unsafe:
        raise WorkerProtocolError("document worker received a prohibited environment variable")


def _install_process_network_guard() -> None:
    def denied(*_args: object, **_kwargs: object) -> NoReturn:
        raise WorkerNetworkDeniedError("network access is denied in the document worker")

    socket.socket = denied  # type: ignore[assignment]
    socket.create_connection = denied  # type: ignore[assignment]
    socket.create_server = denied  # type: ignore[assignment]
    socket.getaddrinfo = denied  # type: ignore[assignment]


def _write_failure(
    stage: Path | None,
    transport: str,
    request: WorkerParseRequest | None,
    error: BaseException,
) -> None:
    request_id = request.request_id if request else "unknown-request-0"
    stage_token = request.stage_token if request else "unknown-stage-000"
    code, message = _public_error(error)
    with contextlib.suppress(BaseException):
        payload = {
                "version": PROTOCOL_VERSION,
                "kind": WorkerResponseKind.FAILED,
                "request_id": request_id,
                "stage_token": stage_token,
                "error": {"code": code, "message": message},
            }
        if stage is None:
            write_frame(sys.stdout.buffer, payload)
        else:
            _write_control_response(stage, transport, payload)


def _write_control_response(
    stage: Path, transport: str, payload: Mapping[str, object]
) -> None:
    if transport == "stdio":
        write_frame(sys.stdout.buffer, payload)
        return
    destination = stage / _RESPONSE_FILE
    if destination.is_symlink():
        raise WorkerProtocolError("control response cannot be a symbolic link")
    frame = encode_frame(payload)
    descriptor = os.open(
        destination,
        os.O_WRONLY
        | os.O_TRUNC
        | int(getattr(os, "O_BINARY", 0))
        | int(getattr(os, "O_NOFOLLOW", 0)),
    )
    try:
        _write_all(descriptor, frame)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.chmod(destination, stat.S_IRUSR)


def _read_path_bounded(path: Path, max_bytes: int) -> bytes:
    if path.is_symlink():
        raise WorkerProtocolError("control request cannot be a symbolic link")
    descriptor = os.open(
        path,
        os.O_RDONLY
        | int(getattr(os, "O_BINARY", 0))
        | int(getattr(os, "O_NOFOLLOW", 0)),
    )
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or not 1 <= info.st_size <= max_bytes:
            raise WorkerProtocolError("control request size is outside the allowed range")
        result = bytearray()
        while len(result) < info.st_size:
            block = os.read(descriptor, info.st_size - len(result))
            if not block:
                raise WorkerProtocolError("control request was truncated")
            result.extend(block)
        return bytes(result)
    finally:
        os.close(descriptor)


def _public_error(error: BaseException) -> tuple[str, str]:
    if isinstance(error, WorkerDeadlineError):
        return "deadline_exceeded", "document parsing exceeded its deadline"
    if isinstance(error, WorkerLimitError):
        return "limit_exceeded", str(error)[:512]
    if isinstance(error, WorkerNetworkDeniedError):
        return "network_denied", "document parsing attempted prohibited network access"
    if isinstance(error, WorkerProtocolError):
        return "invalid_request", str(error)[:512]
    return "conversion_failed", "document conversion failed inside the isolated worker"


if __name__ == "__main__":
    raise SystemExit(main())
