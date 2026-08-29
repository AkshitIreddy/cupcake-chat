from __future__ import annotations

import hashlib
import json
import re
import struct
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, BinaryIO, Final, cast

from .models import SourceLocator

PROTOCOL_VERSION: Final = 1
MAX_CONTROL_FRAME_BYTES: Final = 1 * 1024 * 1024
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_STAGED_NAME = re.compile(r"^[0-9a-f-]{16,80}\.(?:input|json)$")


class WorkerProtocolError(RuntimeError):
    """The worker control channel or staged result violated its contract."""


class WorkerFailureError(RuntimeError):
    """The isolated parser rejected or failed a document."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"document worker {code}: {message}")
        self.code = code


class WorkerRequestKind(StrEnum):
    PARSE = "document.parse"


class WorkerResponseKind(StrEnum):
    COMPLETE = "document.parse.complete"
    FAILED = "document.parse.failed"


@dataclass(frozen=True, slots=True)
class WorkerLimits:
    max_input_bytes: int
    max_output_bytes: int
    max_text_characters: int
    max_pages: int
    max_entries: int
    deadline_unix_ms: int

    def to_json(self) -> dict[str, int]:
        return {
            "max_input_bytes": self.max_input_bytes,
            "max_output_bytes": self.max_output_bytes,
            "max_text_characters": self.max_text_characters,
            "max_pages": self.max_pages,
            "max_entries": self.max_entries,
            "deadline_unix_ms": self.deadline_unix_ms,
        }


@dataclass(frozen=True, slots=True)
class WorkerParseRequest:
    request_id: str
    stage_token: str
    input_name: str
    output_name: str
    source_name: str
    source_suffix: str
    input_size: int
    input_sha256: str
    limits: WorkerLimits

    def to_json(self) -> dict[str, object]:
        return {
            "version": PROTOCOL_VERSION,
            "kind": WorkerRequestKind.PARSE,
            "request_id": self.request_id,
            "stage_token": self.stage_token,
            "payload": {
                "input_name": self.input_name,
                "output_name": self.output_name,
                "source_name": self.source_name,
                "source_suffix": self.source_suffix,
                "input_size": self.input_size,
                "input_sha256": self.input_sha256,
                "limits": self.limits.to_json(),
            },
        }


@dataclass(frozen=True, slots=True)
class WorkerParseResponse:
    request_id: str
    stage_token: str
    output_name: str
    output_size: int
    output_sha256: str
    entry_count: int
    page_count: int


@dataclass(frozen=True, slots=True)
class WorkerEntry:
    text: str
    locator: SourceLocator


@dataclass(frozen=True, slots=True)
class WorkerDocument:
    entries: tuple[WorkerEntry, ...]
    warnings: tuple[str, ...]
    metadata: Mapping[str, object]


def encode_frame(payload: Mapping[str, object]) -> bytes:
    body = json.dumps(
        payload,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    if not body or len(body) > MAX_CONTROL_FRAME_BYTES:
        raise WorkerProtocolError("control frame size is outside the allowed range")
    return struct.pack(">I", len(body)) + body


def decode_single_frame(data: bytes) -> Mapping[str, object]:
    if len(data) < 4:
        raise WorkerProtocolError("truncated control frame header")
    (size,) = struct.unpack(">I", data[:4])
    if size < 1 or size > MAX_CONTROL_FRAME_BYTES:
        raise WorkerProtocolError("control frame declares an invalid size")
    if len(data) != size + 4:
        raise WorkerProtocolError("control channel must contain exactly one complete frame")
    return _decode_json_object(data[4:])


def read_frame(stream: BinaryIO) -> Mapping[str, object]:
    header = _read_exact(stream, 4)
    (size,) = struct.unpack(">I", header)
    if size < 1 or size > MAX_CONTROL_FRAME_BYTES:
        raise WorkerProtocolError("control frame declares an invalid size")
    return _decode_json_object(_read_exact(stream, size))


def write_frame(stream: BinaryIO, payload: Mapping[str, object]) -> None:
    stream.write(encode_frame(payload))
    stream.flush()


def parse_request(payload: Mapping[str, object]) -> WorkerParseRequest:
    _require_exact_keys(payload, {"version", "kind", "request_id", "stage_token", "payload"})
    if _integer(payload["version"], "version") != PROTOCOL_VERSION:
        raise WorkerProtocolError("unsupported document worker protocol version")
    if payload["kind"] != WorkerRequestKind.PARSE:
        raise WorkerProtocolError("unsupported document worker request kind")
    request_id = _identifier(payload["request_id"], "request_id")
    stage_token = _identifier(payload["stage_token"], "stage_token")
    body = _object(payload["payload"], "payload")
    _require_exact_keys(
        body,
        {
            "input_name",
            "output_name",
            "source_name",
            "source_suffix",
            "input_size",
            "input_sha256",
            "limits",
        },
    )
    input_name = _staged_name(body["input_name"], "input_name", ".input")
    output_name = _staged_name(body["output_name"], "output_name", ".json")
    source_name = _bounded_string(body["source_name"], "source_name", 1, 255)
    if "/" in source_name or "\\" in source_name or "\x00" in source_name:
        raise WorkerProtocolError("source_name must be a leaf filename")
    source_suffix = _bounded_string(body["source_suffix"], "source_suffix", 2, 16).casefold()
    if not source_suffix.startswith(".") or not source_suffix[1:].isalnum():
        raise WorkerProtocolError("source_suffix is invalid")
    digest = _bounded_string(body["input_sha256"], "input_sha256", 64, 64)
    if not _SHA256.fullmatch(digest):
        raise WorkerProtocolError("input_sha256 is invalid")
    limits_payload = _object(body["limits"], "limits")
    _require_exact_keys(
        limits_payload,
        {
            "max_input_bytes",
            "max_output_bytes",
            "max_text_characters",
            "max_pages",
            "max_entries",
            "deadline_unix_ms",
        },
    )
    limits = WorkerLimits(
        max_input_bytes=_positive_integer(limits_payload["max_input_bytes"], "max_input_bytes"),
        max_output_bytes=_positive_integer(limits_payload["max_output_bytes"], "max_output_bytes"),
        max_text_characters=_positive_integer(
            limits_payload["max_text_characters"], "max_text_characters"
        ),
        max_pages=_positive_integer(limits_payload["max_pages"], "max_pages"),
        max_entries=_positive_integer(limits_payload["max_entries"], "max_entries"),
        deadline_unix_ms=_positive_integer(limits_payload["deadline_unix_ms"], "deadline_unix_ms"),
    )
    return WorkerParseRequest(
        request_id=request_id,
        stage_token=stage_token,
        input_name=input_name,
        output_name=output_name,
        source_name=source_name,
        source_suffix=source_suffix,
        input_size=_positive_integer(body["input_size"], "input_size", allow_zero=True),
        input_sha256=digest,
        limits=limits,
    )


def parse_response(
    payload: Mapping[str, object], *, request_id: str, stage_token: str
) -> WorkerParseResponse:
    common = {"version", "kind", "request_id", "stage_token"}
    kind = payload.get("kind")
    if kind == WorkerResponseKind.FAILED:
        _require_exact_keys(payload, common | {"error"})
        _validate_response_identity(payload, request_id, stage_token)
        error = _object(payload["error"], "error")
        _require_exact_keys(error, {"code", "message"})
        raise WorkerFailureError(
            _bounded_string(error["code"], "error.code", 1, 64),
            _bounded_string(error["message"], "error.message", 1, 512),
        )
    if kind != WorkerResponseKind.COMPLETE:
        raise WorkerProtocolError("unsupported document worker response kind")
    _require_exact_keys(payload, common | {"result"})
    _validate_response_identity(payload, request_id, stage_token)
    result = _object(payload["result"], "result")
    _require_exact_keys(
        result,
        {
            "output_name",
            "output_size",
            "output_sha256",
            "entry_count",
            "page_count",
        },
    )
    output_sha256 = _bounded_string(result["output_sha256"], "output_sha256", 64, 64)
    if not _SHA256.fullmatch(output_sha256):
        raise WorkerProtocolError("output_sha256 is invalid")
    return WorkerParseResponse(
        request_id=request_id,
        stage_token=stage_token,
        output_name=_staged_name(result["output_name"], "output_name", ".json"),
        output_size=_positive_integer(result["output_size"], "output_size", allow_zero=False),
        output_sha256=output_sha256,
        entry_count=_positive_integer(result["entry_count"], "entry_count", allow_zero=True),
        page_count=_positive_integer(result["page_count"], "page_count", allow_zero=True),
    )


def decode_document(data: bytes, *, max_entries: int, max_characters: int) -> WorkerDocument:
    payload = _decode_json_object(data)
    _require_exact_keys(payload, {"version", "entries", "warnings", "metadata"})
    if _integer(payload["version"], "version") != PROTOCOL_VERSION:
        raise WorkerProtocolError("staged result has an unsupported version")
    entries_payload = _array(payload["entries"], "entries")
    if len(entries_payload) > max_entries:
        raise WorkerProtocolError("staged result exceeds its entry limit")
    entries: list[WorkerEntry] = []
    total = 0
    for index, item in enumerate(entries_payload):
        entry = _object(item, f"entries[{index}]")
        _require_exact_keys(entry, {"text", "locator"})
        text = _bounded_string(entry["text"], f"entries[{index}].text", 0, max_characters)
        total += len(text)
        if total > max_characters:
            raise WorkerProtocolError("staged result exceeds its text limit")
        entries.append(
            WorkerEntry(
                text=text,
                locator=_decode_locator(entry["locator"], f"entries[{index}].locator"),
            )
        )
    warnings = tuple(
        _bounded_string(item, f"warnings[{index}]", 1, 512)
        for index, item in enumerate(_array(payload["warnings"], "warnings"))
    )
    if len(warnings) > 100:
        raise WorkerProtocolError("staged result has too many warnings")
    metadata = _object(payload["metadata"], "metadata")
    return WorkerDocument(tuple(entries), warnings, metadata)


def encode_document(document: WorkerDocument) -> bytes:
    payload: dict[str, object] = {
        "version": PROTOCOL_VERSION,
        "entries": [
            {"text": entry.text, "locator": _encode_locator(entry.locator)}
            for entry in document.entries
        ],
        "warnings": list(document.warnings),
        "metadata": dict(document.metadata),
    }
    return json.dumps(
        payload,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _encode_locator(locator: SourceLocator) -> dict[str, object]:
    return {
        "path": locator.path,
        "line_start": locator.line_start,
        "line_end": locator.line_end,
        "page": locator.page,
        "sheet": locator.sheet,
        "cell_range": locator.cell_range,
        "archive_member": locator.archive_member,
        "timestamp_start_ms": locator.timestamp_start_ms,
        "timestamp_end_ms": locator.timestamp_end_ms,
        "metadata": dict(locator.metadata),
    }


def _decode_locator(value: object, field: str) -> SourceLocator:
    locator = _object(value, field)
    _require_exact_keys(
        locator,
        {
            "path",
            "line_start",
            "line_end",
            "page",
            "sheet",
            "cell_range",
            "archive_member",
            "timestamp_start_ms",
            "timestamp_end_ms",
            "metadata",
        },
    )
    return SourceLocator(
        path=_bounded_string(locator["path"], f"{field}.path", 1, 255),
        line_start=_optional_positive_integer(locator["line_start"], f"{field}.line_start"),
        line_end=_optional_positive_integer(locator["line_end"], f"{field}.line_end"),
        page=_optional_positive_integer(locator["page"], f"{field}.page"),
        sheet=_optional_string(locator["sheet"], f"{field}.sheet", 255),
        cell_range=_optional_string(locator["cell_range"], f"{field}.cell_range", 64),
        archive_member=_optional_string(locator["archive_member"], f"{field}.archive_member", 1024),
        timestamp_start_ms=_optional_nonnegative_integer(
            locator["timestamp_start_ms"], f"{field}.timestamp_start_ms"
        ),
        timestamp_end_ms=_optional_nonnegative_integer(
            locator["timestamp_end_ms"], f"{field}.timestamp_end_ms"
        ),
        metadata=_object(locator["metadata"], f"{field}.metadata"),
    )


def _validate_response_identity(
    payload: Mapping[str, object], request_id: str, stage_token: str
) -> None:
    if _integer(payload["version"], "version") != PROTOCOL_VERSION:
        raise WorkerProtocolError("unsupported document worker response version")
    if payload["request_id"] != request_id or payload["stage_token"] != stage_token:
        raise WorkerProtocolError("document worker response identity does not match its request")


def _decode_json_object(data: bytes) -> Mapping[str, object]:
    try:
        text = data.decode("utf-8", errors="strict")
        value = json.loads(text, object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise WorkerProtocolError("control payload is not strict UTF-8 JSON") from exc
    return _object(value, "root")


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise WorkerProtocolError(f"duplicate JSON member: {key}")
        result[key] = value
    return result


def _read_exact(stream: BinaryIO, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        block = stream.read(size - len(chunks))
        if not block:
            raise WorkerProtocolError("truncated control frame")
        chunks.extend(block)
    return bytes(chunks)


def _require_exact_keys(value: Mapping[str, object], expected: set[str]) -> None:
    actual = set(value)
    if actual != expected:
        raise WorkerProtocolError(
            f"JSON object fields do not match the contract; missing={sorted(expected - actual)}, "
            f"unknown={sorted(actual - expected)}"
        )


def _object(value: object, field: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise WorkerProtocolError(f"{field} must be a JSON object")
    mapping = cast(Mapping[object, object], value)
    if not all(isinstance(key, str) for key in mapping):
        raise WorkerProtocolError(f"{field} must be a JSON object")
    return cast(Mapping[str, object], mapping)


def _array(value: object, field: str) -> list[object]:
    if not isinstance(value, list):
        raise WorkerProtocolError(f"{field} must be a JSON array")
    return cast(list[object], value)


def _integer(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise WorkerProtocolError(f"{field} must be an integer")
    return value


def _positive_integer(value: object, field: str, *, allow_zero: bool = False) -> int:
    result = _integer(value, field)
    if result < (0 if allow_zero else 1):
        raise WorkerProtocolError(f"{field} is outside the allowed range")
    return result


def _optional_positive_integer(value: object, field: str) -> int | None:
    if value is None:
        return None
    return _positive_integer(value, field)


def _optional_nonnegative_integer(value: object, field: str) -> int | None:
    if value is None:
        return None
    return _positive_integer(value, field, allow_zero=True)


def _bounded_string(value: object, field: str, minimum: int, maximum: int) -> str:
    if not isinstance(value, str) or not minimum <= len(value) <= maximum:
        raise WorkerProtocolError(f"{field} must be a string of {minimum}..{maximum} characters")
    return value


def _optional_string(value: object, field: str, maximum: int) -> str | None:
    if value is None:
        return None
    return _bounded_string(value, field, 0, maximum)


def _identifier(value: object, field: str) -> str:
    result = _bounded_string(value, field, 16, 80)
    if not all(character.isalnum() or character in "-_" for character in result):
        raise WorkerProtocolError(f"{field} is not a safe identifier")
    return result


def _staged_name(value: object, field: str, suffix: str) -> str:
    result = _bounded_string(value, field, 16, 85)
    if not result.endswith(suffix) or not _STAGED_NAME.fullmatch(result):
        raise WorkerProtocolError(f"{field} is not a valid staged object name")
    return result
