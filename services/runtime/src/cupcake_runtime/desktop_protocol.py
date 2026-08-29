"""Authenticated desktop stdio transport shared with Electron and ToolBroker."""

from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import hashlib
import hmac
import json
import math
import os
import struct
import sys
import threading
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta
from typing import Any, BinaryIO, cast
from uuid import UUID

from cupcake_runtime.application import RuntimeCommandError, RuntimeService
from cupcake_runtime.domain.ids import new_id

PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 8 * 1024 * 1024


class DesktopProtocolError(RuntimeError):
    pass


def _canonical(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _canonical_float(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        array_value = cast(list[Any], value)
        return "[" + ",".join(_canonical(item) for item in array_value) + "]"
    if isinstance(value, dict):
        object_value = cast(dict[object, Any], value)
        keys: list[str] = []
        for key in object_value:
            if not isinstance(key, str):
                raise DesktopProtocolError("JSON object keys must be strings")
            keys.append(key)
        parts: list[str] = []
        # ECMAScript (and Rust's ryu_js/JCS implementation) orders object keys
        # by UTF-16 code units, not Python Unicode code points.
        for key in sorted(keys, key=lambda item: item.encode("utf-16-be")):
            parts.append(f"{_canonical(key)}:{_canonical(object_value[key])}")
        return "{" + ",".join(parts) + "}"
    raise DesktopProtocolError(f"unsupported JSON value: {type(value).__name__}")


def _canonical_float(value: float) -> str:
    """Render one finite double with ECMAScript JSON number thresholds.

    Rust signs parsed values through ``ryu_js`` and TypeScript through
    ``JSON.stringify``. Python's ordinary ``repr`` has the same shortest
    round-trip digits but chooses scientific notation at a different boundary
    (notably ``1e-6``), so expand only the range JavaScript renders as decimal.
    """
    if not math.isfinite(value):
        raise DesktopProtocolError("non-finite JSON number")
    if value == 0:
        return "0"
    rendered = repr(value).lower()
    magnitude = abs(value)
    if "e" not in rendered:
        return rendered[:-2] if rendered.endswith(".0") else rendered
    mantissa, raw_exponent = rendered.split("e", 1)
    exponent = int(raw_exponent)
    if 1e-6 <= magnitude < 1e21:
        return _expand_scientific_decimal(mantissa, exponent)
    sign = "+" if exponent >= 0 else "-"
    return f"{mantissa}e{sign}{abs(exponent)}"


def _expand_scientific_decimal(mantissa: str, exponent: int) -> str:
    negative = mantissa.startswith("-")
    digits = mantissa.removeprefix("-").replace(".", "")
    point = 1 + exponent
    if point <= 0:
        result = "0." + ("0" * -point) + digits
    elif point >= len(digits):
        result = digits + ("0" * (point - len(digits)))
    else:
        result = digits[:point] + "." + digits[point:]
    return "-" + result if negative else result


def _unsigned(envelope: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in envelope.items() if key != "authTag"}


def _sign(envelope: dict[str, Any], secret: bytes) -> dict[str, Any]:
    unsigned = _unsigned(envelope)
    digest = hmac.new(secret, _canonical(unsigned).encode("utf-8"), hashlib.sha256).digest()
    tag = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return {**unsigned, "authTag": tag}


def _verify(envelope: dict[str, Any], secret: bytes) -> bool:
    tag = envelope.get("authTag")
    return isinstance(tag, str) and hmac.compare_digest(_sign(envelope, secret)["authTag"], tag)


def _read_frame(stream: BinaryIO) -> dict[str, Any] | None:
    header = stream.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise DesktopProtocolError("truncated frame header")
    length = struct.unpack(">I", header)[0]
    if length == 0 or length > MAX_FRAME_BYTES:
        raise DesktopProtocolError("invalid frame length")
    body = stream.read(length)
    if len(body) != length:
        raise DesktopProtocolError("truncated frame body")
    value = json.loads(body)
    if not isinstance(value, dict):
        raise DesktopProtocolError("frame body must be an object")
    return cast(dict[str, Any], value)


def _write_frame(stream: BinaryIO, envelope: dict[str, Any]) -> None:
    body = json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if not body or len(body) > MAX_FRAME_BYTES:
        raise DesktopProtocolError("encoded frame exceeds limit")
    stream.write(struct.pack(">I", len(body)))
    stream.write(body)
    stream.flush()


class ReplayGuard:
    def __init__(self) -> None:
        self.session_id: str | None = None
        self.next_by_correlation: dict[str, int] = defaultdict(lambda: 1)
        self.seen: set[str] = set()
        self.order: deque[str] = deque()

    def accept(self, envelope: dict[str, Any]) -> None:
        required = {
            "version",
            "messageId",
            "correlationId",
            "sessionId",
            "sequence",
            "deadline",
            "lineage",
            "type",
            "payload",
            "authTag",
        }
        if set(envelope) != required or envelope.get("version") != PROTOCOL_VERSION:
            raise DesktopProtocolError("invalid envelope shape or version")
        for key in ("messageId", "correlationId", "sessionId"):
            try:
                if UUID(str(envelope[key])).version != 7:
                    raise ValueError
            except (ValueError, TypeError, AttributeError) as exc:
                raise DesktopProtocolError(f"{key} must be UUIDv7") from exc
        deadline = datetime.fromisoformat(str(envelope["deadline"]).replace("Z", "+00:00"))
        if deadline <= datetime.now(UTC):
            raise DesktopProtocolError("deadline has elapsed")
        session_id = str(envelope["sessionId"])
        if self.session_id is None:
            if envelope["type"] != "handshake":
                raise DesktopProtocolError("first frame must be a handshake")
            self.session_id = session_id
        elif session_id != self.session_id:
            raise DesktopProtocolError("session mismatch")
        message_id = str(envelope["messageId"])
        if message_id in self.seen:
            raise DesktopProtocolError("message replay detected")
        correlation_id = str(envelope["correlationId"])
        expected = self.next_by_correlation[correlation_id]
        if envelope["sequence"] != expected:
            raise DesktopProtocolError(
                f"invalid sequence: expected {expected}, got {envelope['sequence']}"
            )
        self.next_by_correlation[correlation_id] = expected + 1
        self.seen.add(message_id)
        self.order.append(message_id)
        if len(self.order) > 4096:
            self.seen.remove(self.order.popleft())


class DesktopRuntimeServer:
    def __init__(self, service: RuntimeService, secret: bytes) -> None:
        if len(secret) < 32:
            raise ValueError("runtime transport secret must contain at least 32 bytes")
        self.service = service
        self.secret = secret
        self.guard = ReplayGuard()
        self.out_sequences: dict[str, int] = defaultdict(int)
        self.handshaken = False
        self._write_lock = threading.RLock()
        self._pending_lock = threading.RLock()
        self._pending: dict[str, tuple[concurrent.futures.Future[None], threading.Event]] = {}
        self._run_correlations: dict[str, str] = {}

    @classmethod
    def from_environment(cls) -> DesktopRuntimeServer:
        encoded = os.environ.pop("CUPCAKE_RUNTIME_AUTH", None)
        if not encoded:
            raise RuntimeError("CUPCAKE_RUNTIME_AUTH is required")
        padding = "=" * (-len(encoded) % 4)
        secret = base64.urlsafe_b64decode(encoded + padding)
        return cls(RuntimeService.from_environment(), secret)

    def run(
        self,
        input_stream: BinaryIO | None = None,
        output_stream: BinaryIO | None = None,
    ) -> None:
        source = input_stream or sys.stdin.buffer
        target = output_stream or sys.stdout.buffer
        loop = asyncio.new_event_loop()
        loop_thread = threading.Thread(
            target=_run_event_loop,
            args=(loop,),
            name="cupcake-runtime-requests",
            daemon=True,
        )
        loop_thread.start()
        try:
            while True:
                envelope = _read_frame(source)
                if envelope is None:
                    self._finish_pending(timeout=5)
                    return
                if not _verify(envelope, self.secret):
                    raise DesktopProtocolError("authentication tag mismatch")
                self.guard.accept(envelope)
                message_type = str(envelope["type"])
                correlation_id = str(envelope["correlationId"])
                session_id = str(envelope["sessionId"])
                if message_type == "handshake" and not self.handshaken:
                    payload = envelope["payload"]
                    if (
                        payload.get("product") != "CUPCAKEAGI"
                        or payload.get("protocolVersion") != PROTOCOL_VERSION
                    ):
                        raise DesktopProtocolError("invalid runtime handshake")
                    self.handshaken = True
                    self._send(
                        target,
                        "handshake",
                        correlation_id,
                        session_id,
                        {
                            "product": "CUPCAKEAGI",
                            "protocolVersion": PROTOCOL_VERSION,
                            "runtimeVersion": "2.0.0-rc.1",
                            "pid": os.getpid(),
                        },
                    )
                    continue
                if not self.handshaken:
                    raise DesktopProtocolError("runtime handshake is incomplete")
                if message_type == "ping":
                    self._send(target, "pong", correlation_id, session_id, {})
                    continue
                if message_type == "shutdown":
                    self._send(
                        target,
                        "response",
                        correlation_id,
                        session_id,
                        {"ok": True, "result": {"stopped": True}},
                    )
                    return
                if message_type == "cancel":
                    payload = envelope["payload"]
                    target_id = str(payload.get("targetId") or "")
                    try:
                        cancelled = self._cancel_target(target_id)
                        if cancelled:
                            result = {"targetId": target_id, "status": "cancelling"}
                        else:
                            result, _ = self.service.handle("tasks.cancel", {"runId": target_id})
                        response = {"ok": True, "result": result}
                    except Exception:
                        response = {
                            "ok": False,
                            "error": {
                                "code": "NOT_RUNNING",
                                "message": "No matching run is active",
                                "retryable": False,
                            },
                        }
                    self._send(target, "response", correlation_id, session_id, response)
                    continue
                if message_type != "request":
                    raise DesktopProtocolError(f"unsupported message type: {message_type}")
                request = cast(dict[str, Any], envelope["payload"])
                method = request.get("method")
                params = request.get("params")
                if not isinstance(method, str) or (
                    params is not None and not isinstance(params, dict)
                ):
                    self._send_error(
                        target,
                        correlation_id,
                        session_id,
                        "INVALID_REQUEST",
                        "Request method and params are invalid",
                    )
                    continue
                typed_params = None if params is None else cast(dict[str, Any], params)
                cancellation = threading.Event()
                future = asyncio.run_coroutine_threadsafe(
                    self._handle_request(
                        target,
                        correlation_id,
                        session_id,
                        method,
                        typed_params,
                        cancellation,
                    ),
                    loop,
                )
                with self._pending_lock:
                    self._pending[correlation_id] = (future, cancellation)
                future.add_done_callback(
                    lambda _future, key=correlation_id: self._request_finished(key)
                )
        finally:
            self._cancel_all_pending()
            self._finish_pending(timeout=5)
            loop.call_soon_threadsafe(loop.stop)
            loop_thread.join(timeout=5)
            if loop_thread.is_alive():
                print(
                    json.dumps(
                        {
                            "level": "warning",
                            "component": "runtime",
                            "event": "event_loop_shutdown_timeout",
                        }
                    ),
                    file=sys.stderr,
                    flush=True,
                )
            else:
                loop.close()
                self.service.close()

    async def _handle_request(
        self,
        target: BinaryIO,
        correlation_id: str,
        session_id: str,
        method: str,
        params: dict[str, Any] | None,
        cancellation: threading.Event,
    ) -> None:
        async def emit(event: dict[str, Any]) -> None:
            payload = event.get("payload")
            payload_map = cast(dict[str, Any], payload) if isinstance(payload, dict) else None
            if payload_map and isinstance(payload_map.get("runId"), str):
                with self._pending_lock:
                    self._run_correlations[payload_map["runId"]] = correlation_id
            self._send(target, "event", correlation_id, session_id, event)

        try:
            result = await self.service.handle_stream(
                method, params, emit, cancellation=cancellation
            )
            self._send(
                target,
                "response",
                correlation_id,
                session_id,
                {"ok": True, "result": result},
            )
        except RuntimeCommandError as exc:
            self._send_error(
                target,
                correlation_id,
                session_id,
                exc.code,
                str(exc),
                retryable=exc.retryable,
            )
        except asyncio.CancelledError:
            self._send_error(
                target,
                correlation_id,
                session_id,
                "CANCELLED",
                "The runtime request was cancelled",
            )
        except Exception as exc:
            print(
                json.dumps(
                    {
                        "level": "error",
                        "component": "runtime",
                        "errorType": type(exc).__name__,
                    }
                ),
                file=sys.stderr,
                flush=True,
            )
            self._send_error(
                target,
                correlation_id,
                session_id,
                "RUNTIME_ERROR",
                "The local runtime could not complete the request",
                retryable=True,
            )

    def _cancel_target(self, target_id: str) -> bool:
        if self.service.cancel_active(target_id):
            return True
        with self._pending_lock:
            correlation_id = self._run_correlations.get(target_id, target_id)
            pending = self._pending.get(correlation_id)
        if pending is None:
            return False
        return self.service.cancel_stream(pending[1])

    def _cancel_all_pending(self) -> None:
        with self._pending_lock:
            values = list(self._pending.values())
        for _, cancellation in values:
            self.service.cancel_stream(cancellation)

    def _finish_pending(self, *, timeout: float) -> None:
        with self._pending_lock:
            futures = [value[0] for value in self._pending.values()]
        if futures:
            concurrent.futures.wait(futures, timeout=timeout)

    def _request_finished(self, correlation_id: str) -> None:
        with self._pending_lock:
            self._pending.pop(correlation_id, None)
            stale = [
                run_id
                for run_id, mapped in self._run_correlations.items()
                if mapped == correlation_id
            ]
            for run_id in stale:
                self._run_correlations.pop(run_id, None)

    def _send_error(
        self,
        stream: BinaryIO,
        correlation_id: str,
        session_id: str,
        code: str,
        message: str,
        *,
        retryable: bool = False,
    ) -> None:
        self._send(
            stream,
            "response",
            correlation_id,
            session_id,
            {"ok": False, "error": {"code": code, "message": message, "retryable": retryable}},
        )

    def _send(
        self,
        stream: BinaryIO,
        message_type: str,
        correlation_id: str,
        session_id: str,
        payload: dict[str, Any],
    ) -> None:
        with self._write_lock:
            self.out_sequences[correlation_id] += 1
            deadline = (
                (datetime.now(UTC) + timedelta(seconds=30))
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z")
            )
            envelope = {
                "version": PROTOCOL_VERSION,
                "messageId": new_id(),
                "correlationId": correlation_id,
                "sessionId": session_id,
                "sequence": self.out_sequences[correlation_id],
                "deadline": deadline,
                "lineage": {},
                "type": message_type,
                "payload": payload,
            }
            _write_frame(stream, _sign(envelope, self.secret))


def _run_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    asyncio.set_event_loop(loop)
    loop.run_forever()


__all__ = [
    "MAX_FRAME_BYTES",
    "PROTOCOL_VERSION",
    "DesktopProtocolError",
    "DesktopRuntimeServer",
]
