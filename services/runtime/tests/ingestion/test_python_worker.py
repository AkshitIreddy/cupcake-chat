from __future__ import annotations

import hashlib
import json
import os
import stat
import struct
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, cast

import pytest

from cupcake_runtime.ingestion.python_worker import REQUEST_FILE, RESPONSE_FILE


def _frame(payload: dict[str, object]) -> bytes:
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return struct.pack(">I", len(body)) + body


def _decode(frame: bytes) -> dict[str, Any]:
    size = struct.unpack(">I", frame[:4])[0]
    assert len(frame) == size + 4
    value = json.loads(frame[4:])
    assert isinstance(value, dict)
    return cast(dict[str, Any], value)


def _stage_request(
    stage: Path,
    script: str,
    *,
    inputs: dict[str, bytes] | None = None,
    overrides: dict[str, int] | None = None,
) -> dict[str, object]:
    script_data = script.encode()
    script_name = f"{uuid.uuid4().hex}.py.input"
    (stage / script_name).write_bytes(script_data)
    os.chmod(stage / script_name, stat.S_IRUSR)
    manifest: list[dict[str, object]] = []
    for logical_name, data in (inputs or {}).items():
        name = f"{uuid.uuid4().hex}.input"
        (stage / name).write_bytes(data)
        os.chmod(stage / name, stat.S_IRUSR)
        manifest.append(
            {
                "logical_name": logical_name,
                "staged_name": name,
                "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        )
    limits = {
        "deadline_unix_ms": int((time.time() + 30) * 1_000),
        "max_script_bytes": 64 * 1024,
        "max_input_bytes": 1024 * 1024,
        "max_output_bytes": 1024 * 1024,
        "max_result_characters": 128 * 1024,
        "max_stdout_characters": 64 * 1024,
    }
    limits.update(overrides or {})
    request: dict[str, object] = {
        "version": 1,
        "kind": "python.execute",
        "request_id": uuid.uuid4().hex,
        "stage_token": uuid.uuid4().hex,
        "payload": {
            "script": {
                "staged_name": script_name,
                "size": len(script_data),
                "sha256": hashlib.sha256(script_data).hexdigest(),
            },
            "inputs": manifest,
            "limits": limits,
        },
    }
    (stage / REQUEST_FILE).write_bytes(_frame(request))
    os.chmod(stage / REQUEST_FILE, stat.S_IRUSR)
    (stage / RESPONSE_FILE).write_bytes(b"")
    return request


def _run(
    stage: Path,
    *,
    extra_environment: dict[str, str] | None = None,
    broker_private_stage: bool = False,
) -> subprocess.CompletedProcess[bytes]:
    environment = {
        "CUPCAKE_DOCUMENT_WORKER": "1",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "NO_PROXY": "*",
        "TEMP": str(stage),
        "TMP": str(stage),
    }
    for name in ("SystemRoot", "WINDIR"):
        if os.environ.get(name):
            environment[name] = os.environ[name]
    environment.update(extra_environment or {})
    return subprocess.run(
        (
            sys.executable,
            "-I",
            "-m",
            "cupcake_runtime",
            "--sandbox-python-worker",
            "--stage-root",
            "." if broker_private_stage else str(stage),
        ),
        cwd=stage if broker_private_stage else None,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        env=environment,
        check=False,
        timeout=15,
    )


def test_broker_private_working_directory_accepts_literal_dot(tmp_path: Path) -> None:
    _stage_request(tmp_path, "result = 7")
    process = _run(tmp_path, broker_private_stage=True)
    assert process.returncode == 0
    response = _decode((tmp_path / RESPONSE_FILE).read_bytes())
    assert response["result"]["value"] == 7


def test_packaged_entry_executes_bounded_script_and_input_manifest(tmp_path: Path) -> None:
    request = _stage_request(
        tmp_path,
        'print("calculating")\nresult = {"sum": sum(inputs["numbers"])}',
        inputs={"numbers": bytes((2, 3, 5))},
    )
    process = _run(tmp_path)
    assert process.returncode == 0
    assert process.stdout == b""
    assert process.stderr == b""
    response = _decode((tmp_path / RESPONSE_FILE).read_bytes())
    assert response["request_id"] == request["request_id"]
    assert response["stage_token"] == request["stage_token"]
    result = response["result"]
    assert isinstance(result, dict)
    result = cast(dict[str, Any], result)
    assert result["stdout"] == "calculating\n"
    assert result["value"] == {"sum": 10}
    metadata = result["metadata"]
    assert isinstance(metadata, dict)
    metadata = cast(dict[str, Any], metadata)
    loaded = metadata["product_runtime_modules_loaded"]
    assert isinstance(loaded, list)
    loaded = cast(list[str], loaded)
    assert not any(
        name.endswith("application")
        or ".providers" in name
        or ".storage" in name
        or ".tasks" in name
        for name in loaded
    )
    assert stat.S_IMODE((tmp_path / RESPONSE_FILE).stat().st_mode) & stat.S_IWUSR == 0


@pytest.mark.parametrize(
    "script,expected",
    [
        ("import os\nresult = 1", "Import"),
        ("result = inputs.__class__", "dunder"),
        ('result = open("anything")', "open"),
        ('result = getattr(inputs, "keys")', "getattr"),
    ],
)
def test_dangerous_language_surfaces_are_rejected(
    tmp_path: Path, script: str, expected: str
) -> None:
    _stage_request(tmp_path, script)
    process = _run(tmp_path)
    assert process.returncode == 1
    response = _decode((tmp_path / RESPONSE_FILE).read_bytes())
    assert response["kind"] == "python.execute.failed"
    assert expected in response["error"]["message"]


def test_stdout_limit_is_enforced_inside_worker(tmp_path: Path) -> None:
    _stage_request(tmp_path, 'print("x" * 100)', overrides={"max_stdout_characters": 10})
    assert _run(tmp_path).returncode == 1
    response = _decode((tmp_path / RESPONSE_FILE).read_bytes())
    assert response["error"]["code"] == "limit_exceeded"


def test_staged_script_digest_tampering_is_rejected(tmp_path: Path) -> None:
    request = _stage_request(tmp_path, "result = 1")
    payload = request["payload"]
    assert isinstance(payload, dict)
    payload = cast(dict[str, Any], payload)
    script = payload["script"]
    assert isinstance(script, dict)
    script = cast(dict[str, Any], script)
    path = tmp_path / str(script["staged_name"])
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    original = path.read_bytes()
    path.write_bytes(bytes([original[0] ^ 1]) + original[1:])
    assert _run(tmp_path).returncode == 1
    response = _decode((tmp_path / RESPONSE_FILE).read_bytes())
    assert "digest" in response["error"]["message"]


def test_manifest_path_traversal_is_rejected_without_reading_outside(tmp_path: Path) -> None:
    request = _stage_request(tmp_path, "result = 1")
    outside = tmp_path.parent / "outside-python-worker.txt"
    outside.write_text("private", encoding="utf-8")
    try:
        payload = request["payload"]
        assert isinstance(payload, dict)
        payload = cast(dict[str, Any], payload)
        script = payload["script"]
        assert isinstance(script, dict)
        script = cast(dict[str, Any], script)
        script["staged_name"] = "../outside-python-worker.txt"
        os.chmod(tmp_path / REQUEST_FILE, stat.S_IRUSR | stat.S_IWUSR)
        (tmp_path / REQUEST_FILE).write_bytes(_frame(request))
        assert _run(tmp_path).returncode == 1
        response = _decode((tmp_path / RESPONSE_FILE).read_bytes())
        assert "staged_name" in response["error"]["message"]
        assert outside.read_text(encoding="utf-8") == "private"
    finally:
        outside.unlink(missing_ok=True)


def test_prohibited_environment_fails_closed_without_disclosing_value(tmp_path: Path) -> None:
    _stage_request(tmp_path, "result = 1")
    secret = "never-print-this-provider-secret"
    process = _run(tmp_path, extra_environment={"OPENAI_API_KEY": secret})
    assert process.returncode == 1
    combined = process.stdout + process.stderr + (tmp_path / RESPONSE_FILE).read_bytes()
    assert secret.encode() not in combined
    response = _decode((tmp_path / RESPONSE_FILE).read_bytes())
    assert response["error"]["code"] == "invalid_execution"


def test_duplicate_request_fields_are_rejected(tmp_path: Path) -> None:
    duplicate = b'{"version":1,"version":1}'
    (tmp_path / REQUEST_FILE).write_bytes(struct.pack(">I", len(duplicate)) + duplicate)
    (tmp_path / RESPONSE_FILE).write_bytes(b"")
    assert _run(tmp_path).returncode == 1
    response = _decode((tmp_path / RESPONSE_FILE).read_bytes())
    assert "duplicate" in response["error"]["message"]
