from __future__ import annotations

import asyncio
import base64
import json
import os
import struct
import threading
from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path
from typing import Any, cast

import pytest

from cupcake_runtime.application import RuntimeService
from cupcake_runtime.desktop_protocol import (
    DesktopProtocolError,
    DesktopRuntimeServer,
    canonical_json,
    read_frame,
    sign_envelope,
    verify_envelope,
    write_frame,
)
from cupcake_runtime.domain.ids import new_id
from cupcake_runtime.providers.types import NormalizedStreamEvent, StreamEventType


def test_canonical_float_preserves_wire_precision_for_cross_language_hmac() -> None:
    assert canonical_json(31.62752914428711) == "31.62752914428711"
    assert canonical_json(1.0) == "1"
    assert canonical_json(1e-6) == "0.000001"
    assert canonical_json(2.5e-6) == "0.0000025"
    assert canonical_json(1e-7) == "1e-7"
    assert canonical_json(1e20) == "100000000000000000000"
    assert canonical_json(1e21) == "1e+21"


def test_canonical_object_keys_follow_utf16_ordering() -> None:
    assert canonical_json({"\ue000": 1, "😀": 2}) == '{"😀":2,"\ue000":1}'


def test_canonical_json_rejects_non_string_object_keys() -> None:
    with pytest.raises(DesktopProtocolError, match="keys must be strings"):
        canonical_json({1: "would collide with a string key"})


def test_cross_language_authentication_vectors() -> None:
    fixture_path = Path(__file__).parents[3] / "packages/contracts/test/protocol-auth-vectors.json"
    fixture = cast(dict[str, Any], json.loads(fixture_path.read_text(encoding="utf-8")))
    unsigned = cast(dict[str, Any], fixture["unsignedEnvelope"])
    secret = base64.urlsafe_b64decode(fixture["secretBase64Url"] + "=")
    assert canonical_json(unsigned) == fixture["canonicalUnsigned"]
    signed = sign_envelope(unsigned, secret)
    assert signed["authTag"] == fixture["authTag"]
    assert verify_envelope(signed, secret)


def test_wire_writer_emits_canonical_json_and_reader_rejects_noncanonical_body() -> None:
    value = {"z": 1, "a": {"probe": 1e-6}}
    stream = BytesIO()
    write_frame(stream, value)
    body = stream.getvalue()[4:]
    assert body == canonical_json(value).encode("utf-8")

    noncanonical = json.dumps(value, separators=(",", ":")).encode("utf-8")
    assert noncanonical != body
    framed = BytesIO(struct.pack(">I", len(noncanonical)) + noncanonical)
    with pytest.raises(DesktopProtocolError, match="canonical"):
        read_frame(framed)


def test_failed_frame_preparation_does_not_consume_outbound_sequence(tmp_path: Path) -> None:
    secret = b"p" * 32
    correlation_id = new_id()
    session_id = new_id()
    target = BytesIO()
    runtime = RuntimeService(tmp_path, master_key=b"k" * 32, require_sqlcipher=False)
    server = DesktopRuntimeServer(runtime, secret)
    test_server = cast(Any, server)

    with pytest.raises(DesktopProtocolError, match="unsupported JSON value"):
        test_server._send(
            target,
            "response",
            correlation_id,
            session_id,
            {"ok": True, "result": object()},
        )

    assert server.out_sequences[correlation_id] == 0
    assert target.getvalue() == b""
    test_server._send_error(
        target,
        correlation_id,
        session_id,
        "RUNTIME_ERROR",
        "The local runtime could not complete the request",
        retryable=True,
    )
    target.seek(0)
    fallback = required_frame(target)
    assert fallback["sequence"] == 1
    assert fallback["payload"]["error"]["code"] == "RUNTIME_ERROR"
    runtime.close()


def envelope(
    message_type: str,
    payload: dict[str, object],
    *,
    session_id: str,
    correlation_id: str,
    secret: bytes,
) -> dict[str, object]:
    return sign_envelope(
        {
            "version": 1,
            "messageId": new_id(),
            "correlationId": correlation_id,
            "sessionId": session_id,
            "sequence": 1,
            "deadline": (datetime.now(UTC) + timedelta(minutes=1))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "lineage": {},
            "type": message_type,
            "payload": payload,
        },
        secret,
    )


def required_frame(stream: Any) -> dict[str, Any]:
    frame = read_frame(stream)
    assert frame is not None
    return frame


def test_authenticated_stdio_handshake_and_request(tmp_path: Path) -> None:
    secret = b"s" * 32
    session_id = new_id()
    source = BytesIO()
    write_frame(
        source,
        envelope(
            "handshake",
            {"product": "CUPCAKEAGI", "protocolVersion": 1},
            session_id=session_id,
            correlation_id=new_id(),
            secret=secret,
        ),
    )
    request_id = new_id()
    write_frame(
        source,
        envelope(
            "request",
            {"method": "runtime.health", "params": {}},
            session_id=session_id,
            correlation_id=request_id,
            secret=secret,
        ),
    )
    write_frame(
        source,
        envelope(
            "shutdown",
            {},
            session_id=session_id,
            correlation_id=new_id(),
            secret=secret,
        ),
    )
    source.seek(0)
    target = BytesIO()
    service = RuntimeService(tmp_path, master_key=b"k" * 32, require_sqlcipher=False)
    DesktopRuntimeServer(service, secret).run(source, target)

    target.seek(0)
    responses: list[dict[str, Any]] = []
    while frame := read_frame(target):
        responses.append(frame)
    assert responses[0]["type"] == "handshake"
    health = next(item for item in responses if item["correlationId"] == request_id)
    assert health["payload"]["ok"] is True
    assert health["payload"]["result"]["healthy"] is True


class _PipeSlowEngine:
    async def stream(self, request: Any, **_kwargs: Any):
        run_id = str(request.metadata["run_id"])
        yield NormalizedStreamEvent(StreamEventType.START, 1, run_id)
        yield NormalizedStreamEvent(StreamEventType.TEXT_DELTA, 2, run_id, text="live")
        await asyncio.sleep(60)


def test_stdio_streams_before_response_and_accepts_cancel(tmp_path: Path) -> None:
    secret = b"z" * 32
    session_id = new_id()
    input_read, input_write = os.pipe()
    output_read, output_write = os.pipe()
    source = os.fdopen(input_read, "rb", buffering=0)
    incoming = os.fdopen(input_write, "wb", buffering=0)
    outgoing = os.fdopen(output_read, "rb", buffering=0)
    target = os.fdopen(output_write, "wb", buffering=0)
    runtime = RuntimeService(tmp_path, master_key=b"k" * 32, require_sqlcipher=False)
    runtime.agent_engine = _PipeSlowEngine()  # type: ignore[assignment]
    server = DesktopRuntimeServer(runtime, secret)
    thread = threading.Thread(target=server.run, args=(source, target), daemon=True)
    thread.start()

    write_frame(
        incoming,
        envelope(
            "handshake",
            {"product": "CUPCAKEAGI", "protocolVersion": 1},
            session_id=session_id,
            correlation_id=new_id(),
            secret=secret,
        ),
    )
    assert required_frame(outgoing)["type"] == "handshake"
    request_id = new_id()
    write_frame(
        incoming,
        envelope(
            "request",
            {
                "method": "chat.send",
                "params": {"content": "slow", "modelId": "mock:cupcake-deterministic"},
            },
            session_id=session_id,
            correlation_id=request_id,
            secret=secret,
        ),
    )
    first = required_frame(outgoing)
    assert first["correlationId"] == request_id
    assert first["type"] == "event"
    assert first["payload"]["type"] == "message.started"

    cancel_id = new_id()
    write_frame(
        incoming,
        envelope(
            "cancel",
            {"targetId": request_id},
            session_id=session_id,
            correlation_id=cancel_id,
            secret=secret,
        ),
    )
    received: list[dict[str, Any]] = []
    while len(received) < 8:
        item = required_frame(outgoing)
        received.append(item)
        correlations = {frame["correlationId"] for frame in received if frame["type"] == "response"}
        if {request_id, cancel_id} <= correlations:
            break
    cancel_response = next(item for item in received if item["correlationId"] == cancel_id)
    original_response = next(
        item
        for item in received
        if item["correlationId"] == request_id and item["type"] == "response"
    )
    assert cancel_response["payload"]["ok"] is True
    assert original_response["payload"]["error"]["code"] == "CANCELLED"

    shutdown_id = new_id()
    write_frame(
        incoming,
        envelope(
            "shutdown",
            {},
            session_id=session_id,
            correlation_id=shutdown_id,
            secret=secret,
        ),
    )
    assert required_frame(outgoing)["correlationId"] == shutdown_id
    thread.join(timeout=5)
    assert not thread.is_alive()
    incoming.close()
    outgoing.close()
