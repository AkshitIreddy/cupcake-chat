from __future__ import annotations

import asyncio
import os
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
    _canonical,
    _read_frame,
    _sign,
    _write_frame,
)
from cupcake_runtime.domain.ids import new_id
from cupcake_runtime.providers.types import NormalizedStreamEvent, StreamEventType


def test_canonical_float_preserves_wire_precision_for_cross_language_hmac() -> None:
    assert _canonical(31.62752914428711) == "31.62752914428711"
    assert _canonical(1.0) == "1"
    assert _canonical(1e-6) == "0.000001"
    assert _canonical(2.5e-6) == "0.0000025"
    assert _canonical(1e-7) == "1e-7"
    assert _canonical(1e20) == "100000000000000000000"
    assert _canonical(1e21) == "1e+21"


def test_canonical_object_keys_follow_utf16_ordering() -> None:
    assert _canonical({"\ue000": 1, "😀": 2}) == '{"😀":2,"\ue000":1}'


def test_canonical_json_rejects_non_string_object_keys() -> None:
    with pytest.raises(DesktopProtocolError, match="keys must be strings"):
        _canonical({1: "would collide with a string key"})


def envelope(
    message_type: str,
    payload: dict[str, object],
    *,
    session_id: str,
    correlation_id: str,
    secret: bytes,
) -> dict[str, object]:
    return _sign(
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
    frame = _read_frame(stream)
    assert frame is not None
    return cast(dict[str, Any], frame)


def test_authenticated_stdio_handshake_and_request(tmp_path: Path) -> None:
    secret = b"s" * 32
    session_id = new_id()
    source = BytesIO()
    _write_frame(
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
    _write_frame(
        source,
        envelope(
            "request",
            {"method": "runtime.health", "params": {}},
            session_id=session_id,
            correlation_id=request_id,
            secret=secret,
        ),
    )
    _write_frame(
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
    responses = []
    while frame := _read_frame(target):
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

    _write_frame(
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
    _write_frame(
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
    _write_frame(
        incoming,
        envelope(
            "cancel",
            {"targetId": request_id},
            session_id=session_id,
            correlation_id=cancel_id,
            secret=secret,
        ),
    )
    received = []
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
    _write_frame(
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
