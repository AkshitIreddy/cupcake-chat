from __future__ import annotations

import json
import struct
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from .models import ToolDescriptor

SDK_PROTOCOL_VERSION = 1
DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024


class ProtocolError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class ToolProcessManifest:
    manifest_version: int
    plugin_id: str
    plugin_version: str
    executable: str
    tools: tuple[ToolDescriptor, ...]

    def __post_init__(self) -> None:
        if self.manifest_version != 1:
            raise ProtocolError("unsupported custom-tool manifest version")
        if not self.plugin_id or not self.plugin_version or not self.tools:
            raise ProtocolError("plugin identity and at least one tool are required")
        executable = PurePosixPath(self.executable.replace("\\", "/"))
        if executable.is_absolute() or ".." in executable.parts or not self.executable:
            raise ProtocolError("executable must be a relative path inside the plugin")
        identities = [tool.identity for tool in self.tools]
        if len(identities) != len(set(identities)):
            raise ProtocolError("custom-tool manifest contains duplicate tool identities")

    def resolve_executable(self, plugin_root: Path) -> Path:
        root = plugin_root.resolve(strict=True)
        resolved = (root / self.executable).resolve(strict=True)
        if not resolved.is_relative_to(root) or not resolved.is_file():
            raise ProtocolError("custom-tool executable escapes the plugin root")
        return resolved

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> ToolProcessManifest:
        allowed = {"manifest_version", "plugin_id", "plugin_version", "executable", "tools"}
        extras = set(value) - allowed
        if extras:
            raise ProtocolError(f"unknown manifest fields: {', '.join(sorted(extras))}")
        try:
            tools = tuple(_descriptor(item) for item in value["tools"])
            return cls(
                manifest_version=int(value["manifest_version"]),
                plugin_id=str(value["plugin_id"]),
                plugin_version=str(value["plugin_version"]),
                executable=str(value["executable"]),
                tools=tools,
            )
        except (KeyError, TypeError, ValueError) as exc:
            if isinstance(exc, ProtocolError):
                raise
            raise ProtocolError("invalid custom-tool manifest") from exc


@dataclass(frozen=True, slots=True)
class SDKEnvelope:
    message_type: str
    message_id: str
    payload: Mapping[str, Any]
    protocol_version: int = SDK_PROTOCOL_VERSION

    def __post_init__(self) -> None:
        if self.protocol_version != SDK_PROTOCOL_VERSION:
            raise ProtocolError("unsupported SDK protocol version")
        if not self.message_type or not self.message_id:
            raise ProtocolError("SDK message type and ID are required")


def encode_frame(envelope: SDKEnvelope, *, max_bytes: int = DEFAULT_MAX_FRAME_BYTES) -> bytes:
    payload = json.dumps(
        {
            "protocol_version": envelope.protocol_version,
            "message_type": envelope.message_type,
            "message_id": envelope.message_id,
            "payload": envelope.payload,
        },
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    if len(payload) > max_bytes:
        raise ProtocolError("SDK frame exceeds maximum size")
    return struct.pack(">I", len(payload)) + payload


class FrameDecoder:
    def __init__(self, *, max_bytes: int = DEFAULT_MAX_FRAME_BYTES) -> None:
        self._buffer = bytearray()
        self._max_bytes = max_bytes

    def feed(self, data: bytes) -> tuple[SDKEnvelope, ...]:
        self._buffer.extend(data)
        frames: list[SDKEnvelope] = []
        while len(self._buffer) >= 4:
            length = struct.unpack(">I", self._buffer[:4])[0]
            if length == 0 or length > self._max_bytes:
                self._buffer.clear()
                raise ProtocolError("invalid SDK frame length")
            if len(self._buffer) < length + 4:
                break
            raw = bytes(self._buffer[4 : length + 4])
            del self._buffer[: length + 4]
            try:
                value = json.loads(raw.decode("utf-8"))
                if set(value) != {"protocol_version", "message_type", "message_id", "payload"}:
                    raise ProtocolError("SDK envelope has unknown or missing fields")
                if not isinstance(value["payload"], dict):
                    raise ProtocolError("SDK payload must be an object")
                frames.append(SDKEnvelope(**value))
            except ProtocolError:
                self._buffer.clear()
                raise
            except (UnicodeDecodeError, json.JSONDecodeError, TypeError) as exc:
                self._buffer.clear()
                raise ProtocolError("invalid SDK JSON frame") from exc
        return tuple(frames)


def _descriptor(value: Mapping[str, Any]) -> ToolDescriptor:
    from .models import DataDestination, DataFlowDisclosure, Effect

    flows = tuple(
        DataFlowDisclosure(
            destination=DataDestination(flow["destination"]),
            destination_label=flow["destination_label"],
            categories=tuple(flow["categories"]),
            purpose=flow["purpose"],
            contains_user_content=bool(flow.get("contains_user_content", False)),
        )
        for flow in value.get("default_data_flows", ())
    )
    return ToolDescriptor(
        name=value["name"],
        version=value["version"],
        display_name=value["display_name"],
        description=value["description"],
        input_schema=value["input_schema"],
        output_schema=value.get("output_schema", {"type": "object"}),
        effects=frozenset(Effect(effect) for effect in value.get("effects", ())),
        required_grants=tuple(value.get("required_grants", ())),
        default_data_flows=flows,
        timeout_seconds=int(value.get("timeout_seconds", 60)),
        cancellable=bool(value.get("cancellable", True)),
        category=value.get("category", "custom"),
    )
