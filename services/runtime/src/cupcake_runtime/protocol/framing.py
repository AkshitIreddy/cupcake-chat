from __future__ import annotations

import hashlib
import hmac
import json
import struct
from collections.abc import Iterable
from datetime import UTC, datetime

from pydantic import ValidationError

from cupcake_runtime.domain.errors import ProtocolViolation
from cupcake_runtime.protocol.models import ProtocolEnvelope

DEFAULT_MAX_FRAME_SIZE = 16 * 1024 * 1024
HEADER_SIZE = 4


def _canonical_json(envelope: ProtocolEnvelope) -> bytes:
    return json.dumps(
        envelope.model_dump(mode="json"),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


class FrameCodec:
    """Length-prefixed canonical JSON with a per-session authentication key."""

    def __init__(self, authentication_key: bytes, *, max_frame_size: int = DEFAULT_MAX_FRAME_SIZE):
        if len(authentication_key) < 32:
            raise ValueError("protocol authentication key must contain at least 32 bytes")
        if max_frame_size < 1024 or max_frame_size > 64 * 1024 * 1024:
            raise ValueError("max_frame_size must be between 1 KiB and 64 MiB")
        self._key = authentication_key
        self.max_frame_size = max_frame_size

    def sign(self, envelope: ProtocolEnvelope) -> ProtocolEnvelope:
        unsigned = envelope.signing_copy()
        tag = hmac.new(self._key, _canonical_json(unsigned), hashlib.sha256).hexdigest()
        return unsigned.model_copy(update={"auth_tag": tag})

    def encode(self, envelope: ProtocolEnvelope) -> bytes:
        body = _canonical_json(self.sign(envelope))
        if len(body) > self.max_frame_size:
            raise ProtocolViolation(
                f"encoded protocol frame exceeds {self.max_frame_size} byte limit"
            )
        return struct.pack(">I", len(body)) + body

    def decode_body(self, body: bytes) -> ProtocolEnvelope:
        if not body or len(body) > self.max_frame_size:
            raise ProtocolViolation("invalid protocol frame length")
        try:
            envelope = ProtocolEnvelope.model_validate_json(body, strict=True)
        except ValidationError as exc:
            raise ProtocolViolation("invalid protocol envelope") from exc
        if not envelope.auth_tag:
            raise ProtocolViolation("protocol envelope is not authenticated")
        expected = hmac.new(
            self._key, _canonical_json(envelope.signing_copy()), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(envelope.auth_tag, expected):
            raise ProtocolViolation("protocol envelope authentication failed")
        return envelope


class FrameReader:
    """Incremental parser for partial or coalesced pipe reads."""

    def __init__(self, codec: FrameCodec) -> None:
        self.codec = codec
        self._buffer = bytearray()
        self._expected_length: int | None = None

    def feed(self, data: bytes | bytearray | memoryview) -> tuple[ProtocolEnvelope, ...]:
        self._buffer.extend(data)
        decoded: list[ProtocolEnvelope] = []
        while True:
            if self._expected_length is None:
                if len(self._buffer) < HEADER_SIZE:
                    break
                expected_length = struct.unpack(">I", self._buffer[:HEADER_SIZE])[0]
                self._expected_length = expected_length
                del self._buffer[:HEADER_SIZE]
                if expected_length == 0 or expected_length > self.codec.max_frame_size:
                    self.reset()
                    raise ProtocolViolation("invalid or oversized frame header")
            expected_length = self._expected_length
            if expected_length is None or len(self._buffer) < expected_length:
                break
            body = bytes(self._buffer[:expected_length])
            del self._buffer[:expected_length]
            self._expected_length = None
            decoded.append(self.codec.decode_body(body))
        return tuple(decoded)

    def reset(self) -> None:
        self._buffer.clear()
        self._expected_length = None

    @property
    def buffered_bytes(self) -> int:
        return len(self._buffer)


class SequenceGuard:
    """Reject replayed, skipped, or reordered envelopes per correlation stream."""

    def __init__(self, *, first_sequence: int = 0) -> None:
        if first_sequence < 0:
            raise ValueError("first_sequence cannot be negative")
        self._first_sequence = first_sequence
        self._last: dict[str, int] = {}

    def accept(self, envelope: ProtocolEnvelope, *, now: datetime | None = None) -> None:
        current_time = now or datetime.now(UTC)
        if envelope.deadline is not None and envelope.deadline <= current_time:
            raise ProtocolViolation("protocol envelope deadline has expired")
        expected = self._last.get(envelope.correlation_id, self._first_sequence - 1) + 1
        if envelope.sequence != expected:
            raise ProtocolViolation(
                f"invalid sequence for {envelope.correlation_id}: "
                f"expected {expected}, got {envelope.sequence}"
            )
        self._last[envelope.correlation_id] = envelope.sequence

    def accept_many(self, envelopes: Iterable[ProtocolEnvelope]) -> None:
        for envelope in envelopes:
            self.accept(envelope)

    def forget(self, correlation_id: str) -> None:
        self._last.pop(correlation_id, None)
