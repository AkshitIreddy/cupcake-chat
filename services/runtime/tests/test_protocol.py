from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from cupcake_runtime.domain.errors import ProtocolViolation
from cupcake_runtime.protocol.framing import FrameCodec, FrameReader, SequenceGuard
from cupcake_runtime.protocol.models import ProtocolEnvelope

KEY = b"p" * 32


def envelope(sequence: int = 0, **updates: object) -> ProtocolEnvelope:
    values: dict[str, object] = {
        "correlation_id": "run-1",
        "sequence": sequence,
        "type": "message.delta",
        "payload": {"text": "hello 🧁"},
    }
    values.update(updates)
    return ProtocolEnvelope.model_validate(values)


def test_fragmented_and_coalesced_frames_round_trip() -> None:
    codec = FrameCodec(KEY)
    reader = FrameReader(codec)
    encoded = codec.encode(envelope(0)) + codec.encode(envelope(1))
    assert reader.feed(encoded[:3]) == ()
    assert reader.feed(encoded[3:11]) == ()
    decoded = reader.feed(encoded[11:])
    assert [item.sequence for item in decoded] == [0, 1]
    assert decoded[0].payload == {"text": "hello 🧁"}


def test_tampering_and_oversized_header_are_rejected() -> None:
    codec = FrameCodec(KEY, max_frame_size=1024)
    encoded = bytearray(codec.encode(envelope()))
    encoded[-2] ^= 1
    with pytest.raises(ProtocolViolation):
        FrameReader(codec).feed(encoded)
    with pytest.raises(ProtocolViolation, match="oversized"):
        FrameReader(codec).feed((1025).to_bytes(4, "big"))


def test_sequence_guard_rejects_replay_gap_and_expired_deadline() -> None:
    guard = SequenceGuard()
    guard.accept(envelope(0))
    with pytest.raises(ProtocolViolation, match="expected 1"):
        guard.accept(envelope(0))
    with pytest.raises(ProtocolViolation, match="expected 1"):
        guard.accept(envelope(2))
    with pytest.raises(ProtocolViolation, match="expired"):
        SequenceGuard().accept(envelope(0, deadline=datetime.now(UTC) - timedelta(seconds=1)))


def test_unknown_fields_and_protocol_versions_are_rejected() -> None:
    with pytest.raises(ValidationError):
        ProtocolEnvelope.model_validate(
            {
                "version": 2,
                "correlation_id": "run-1",
                "sequence": 0,
                "type": "message.delta",
                "payload": {},
            }
        )
    with pytest.raises(ValidationError):
        ProtocolEnvelope.model_validate(
            {
                "correlation_id": "run-1",
                "sequence": 0,
                "type": "message.delta",
                "payload": {},
                "surprise": True,
            }
        )
