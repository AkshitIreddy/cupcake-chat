from __future__ import annotations

import json
import struct
from pathlib import Path

import pytest

from cupcake_runtime.tools.sdk import (
    FrameDecoder,
    ProtocolError,
    SDKEnvelope,
    ToolProcessManifest,
    encode_frame,
)


def manifest(executable: str = "bin/tool") -> dict[str, object]:
    return {
        "manifest_version": 1,
        "plugin_id": "example.tool",
        "plugin_version": "1.0.0",
        "executable": executable,
        "tools": [
            {
                "name": "example.lookup",
                "version": "1.0.0",
                "display_name": "Lookup",
                "description": "Look up an example.",
                "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
                "effects": [],
            }
        ],
    }


def test_custom_tool_manifest_rejects_path_escape_and_symlink(tmp_path: Path) -> None:
    with pytest.raises(ProtocolError, match="relative path"):
        ToolProcessManifest.from_mapping(manifest("../../evil"))
    root = tmp_path / "plugin"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.write_text("tool")
    (root / "link").symlink_to(outside)
    parsed = ToolProcessManifest.from_mapping(manifest("link"))
    with pytest.raises(ProtocolError, match="escapes"):
        parsed.resolve_executable(root)


def test_framing_is_incremental_strict_and_bounded() -> None:
    message = SDKEnvelope("tool.result", "message-1", {"ok": True})
    encoded = encode_frame(message)
    decoder = FrameDecoder()
    assert decoder.feed(encoded[:3]) == ()
    assert decoder.feed(encoded[3:]) == (message,)
    with pytest.raises(ProtocolError, match="frame length"):
        FrameDecoder(max_bytes=4).feed(struct.pack(">I", 5) + b"12345")
    bad = json.dumps(
        {"protocol_version": 1, "message_type": "x", "message_id": "y", "payload": {}, "extra": 1}
    ).encode()
    with pytest.raises(ProtocolError, match="unknown or missing"):
        FrameDecoder().feed(struct.pack(">I", len(bad)) + bad)
