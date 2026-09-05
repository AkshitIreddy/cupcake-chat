from __future__ import annotations

import ast
import builtins
import hashlib
import json
import os
import re
import socket
import stat
import struct
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from types import MappingProxyType, ModuleType
from typing import Any, NoReturn, cast

PROTOCOL_VERSION = 1
REQUEST_FILE = "python-request.frame"
RESPONSE_FILE = "python-response.frame"
MAX_CONTROL_FRAME_BYTES = 2 * 1024 * 1024
_STAGED_INPUT = re.compile(r"^[0-9a-f-]{16,80}\.(?:py\.)?input$")
_LOGICAL_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SENSITIVE_MARKERS = (
    "KEY",
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "CREDENTIAL",
    "AUTH",
    "COOKIE",
    "OPENAI",
    "ANTHROPIC",
    "COHERE",
    "MISTRAL",
    "XAI",
    "AWS_",
    "AZURE_",
    "GOOGLE_",
)
_MODULE_TEST_IMPORTS = frozenset(
    {
        "argparse",
        "collections",
        "csv",
        "dataclasses",
        "datetime",
        "decimal",
        "enum",
        "functools",
        "io",
        "itertools",
        "json",
        "math",
        "re",
        "statistics",
        "string",
        "sys",
        "typing",
        "unittest",
    }
)


class PythonWorkerError(RuntimeError):
    pass


class PythonWorkerLimitError(PythonWorkerError):
    pass


class _BoundedOutput:
    def __init__(self, max_characters: int) -> None:
        self.max_characters = max_characters
        self.parts: list[str] = []
        self.length = 0

    def print(
        self,
        *values: object,
        sep: str = " ",
        end: str = "\n",
        file: object = None,
        flush: bool = False,
    ) -> None:
        del flush
        if file is not None:
            raise PythonWorkerError("print redirection is unavailable")
        rendered = sep.join(str(value) for value in values) + end
        if self.length + len(rendered) > self.max_characters:
            raise PythonWorkerLimitError("captured output exceeds its character limit")
        self.parts.append(rendered)
        self.length += len(rendered)

    def write(self, value: str) -> int:
        if not isinstance(value, str):
            raise PythonWorkerError("captured output must be text")
        if self.length + len(value) > self.max_characters:
            raise PythonWorkerLimitError("captured output exceeds its character limit")
        self.parts.append(value)
        self.length += len(value)
        return len(value)

    def flush(self) -> None:
        return None

    def isatty(self) -> bool:
        return False

    def value(self) -> str:
        return "".join(self.parts)


def main(argv: Sequence[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--stage-root", required=True)
    arguments = parser.parse_args(argv)
    request_id = "unknown-request-0"
    stage_token = "unknown-stage-000"
    stage: Path | None = None
    try:
        stage = _validate_stage(Path(arguments.stage_root))
        _reject_sensitive_environment()
        _install_network_guard()
        request = _decode_frame(_read_bounded(stage / REQUEST_FILE, MAX_CONTROL_FRAME_BYTES + 4))
        request_id, stage_token, payload = _validate_request(request)
        result = _execute(stage, payload)
        limits = _object(payload["limits"], "limits")
        response = {
            "version": PROTOCOL_VERSION,
            "kind": (
                "python.execute.failed"
                if result.get("status") == "failed"
                else "python.execute.complete"
            ),
            "request_id": request_id,
            "stage_token": stage_token,
            "result": result,
        }
        _write_response(
            stage,
            _encode_frame(response),
            _integer(limits["max_output_bytes"], "max_output_bytes"),
        )
        return 0
    except BaseException as exc:
        if stage is not None:
            try:
                response = {
                    "version": PROTOCOL_VERSION,
                    "kind": "python.execute.failed",
                    "request_id": request_id,
                    "stage_token": stage_token,
                    "error": _public_error(exc),
                }
                _write_response(stage, _encode_frame(response), MAX_CONTROL_FRAME_BYTES + 4)
            except BaseException:
                pass
        return 1


def _execute(stage: Path, payload: Mapping[str, object]) -> Mapping[str, object]:
    limits = _object(payload["limits"], "limits")
    _check_deadline(_integer(limits["deadline_unix_ms"], "deadline_unix_ms"))
    max_script_bytes = _positive(limits["max_script_bytes"], "max_script_bytes")
    max_input_bytes = _positive(limits["max_input_bytes"], "max_input_bytes")
    max_result_characters = _positive(limits["max_result_characters"], "max_result_characters")
    max_stdout_characters = _positive(limits["max_stdout_characters"], "max_stdout_characters")
    script = _read_manifest_object(stage, _object(payload["script"], "script"), max_script_bytes)
    try:
        script_text = script.decode("utf-8", errors="strict")
    except UnicodeError as exc:
        raise PythonWorkerError("script is not strict UTF-8") from exc
    execution_mode = payload.get("execution_mode", "expression")
    if execution_mode not in {"expression", "module_test"}:
        raise PythonWorkerError("unsupported Python execution mode")
    input_payload = _array(payload["inputs"], "inputs")
    if len(input_payload) > 64:
        raise PythonWorkerLimitError("input manifest has too many entries")
    inputs: dict[str, bytes] = {}
    total_input = 0
    for index, raw in enumerate(input_payload):
        entry = _object(raw, f"inputs[{index}]")
        logical_name = _string(entry["logical_name"], f"inputs[{index}].logical_name")
        if not _LOGICAL_NAME.fullmatch(logical_name) or logical_name in inputs:
            raise PythonWorkerError("input manifest has an invalid or duplicate logical name")
        remaining = max_input_bytes - total_input
        if remaining < 0:
            raise PythonWorkerLimitError("staged inputs exceed their total byte limit")
        data = _read_manifest_object(stage, entry, remaining)
        total_input += len(data)
        inputs[logical_name] = data
    _check_deadline(_integer(limits["deadline_unix_ms"], "deadline_unix_ms"))
    if execution_mode == "module_test":
        if inputs:
            raise PythonWorkerError("module test mode does not accept input files")
        return _execute_module_tests(
            script_text,
            max_result_characters=max_result_characters,
            max_output_characters=max_stdout_characters,
        )

    tree = ast.parse(script_text, filename="<sandboxed-script>", mode="exec")
    _validate_ast(tree)
    captured = _BoundedOutput(max_stdout_characters)
    builtins = _safe_builtins(captured.print)
    globals_scope: dict[str, object] = {
        "__builtins__": MappingProxyType(builtins),
        "inputs": MappingProxyType(inputs),
        "result": None,
    }
    code = compile(tree, "<sandboxed-script>", "exec", dont_inherit=True, optimize=2)
    exec(code, globals_scope, globals_scope)
    _check_deadline(_integer(limits["deadline_unix_ms"], "deadline_unix_ms"))
    normalized = _normalize_result(globals_scope.get("result"), max_result_characters)
    product_modules = sorted(
        name
        for name in sys.modules
        if name.startswith("cupcake_runtime.")
        and name
        not in {
            "cupcake_runtime.ingestion",
            "cupcake_runtime.ingestion.python_worker",
        }
    )
    return {
        "status": "complete",
        "stdout": captured.value(),
        "value": normalized,
        "metadata": {
            "network_access": False,
            "network_enforcement": "broker-appcontainer-required",
            "product_runtime_modules_loaded": product_modules,
        },
    }


def _validate_request(
    request: Mapping[str, object],
) -> tuple[str, str, Mapping[str, object]]:
    _exact(request, {"version", "kind", "request_id", "stage_token", "payload"})
    if request["version"] != PROTOCOL_VERSION or request["kind"] != "python.execute":
        raise PythonWorkerError("unsupported Python worker protocol request")
    request_id = _identifier(request["request_id"], "request_id")
    stage_token = _identifier(request["stage_token"], "stage_token")
    payload = _object(request["payload"], "payload")
    allowed_payload = {"script", "inputs", "limits", "execution_mode"}
    if set(payload) not in ({"script", "inputs", "limits"}, allowed_payload):
        raise PythonWorkerError("payload has missing or unknown fields")
    if "execution_mode" in payload:
        mode = _string(payload["execution_mode"], "execution_mode")
        if mode not in {"expression", "module_test"}:
            raise PythonWorkerError("unsupported Python execution mode")
    _validate_manifest_descriptor(_object(payload["script"], "script"), "script")
    for index, item in enumerate(_array(payload["inputs"], "inputs")):
        entry = _object(item, f"inputs[{index}]")
        _exact(entry, {"logical_name", "staged_name", "size", "sha256"})
        _validate_manifest_descriptor(entry, f"inputs[{index}]")
    limits = _object(payload["limits"], "limits")
    _exact(
        limits,
        {
            "deadline_unix_ms",
            "max_script_bytes",
            "max_input_bytes",
            "max_output_bytes",
            "max_result_characters",
            "max_stdout_characters",
        },
    )
    for name, value in limits.items():
        _positive(value, name)
    return request_id, stage_token, payload


def _validate_manifest_descriptor(value: Mapping[str, object], field: str) -> None:
    required = {"staged_name", "size", "sha256"}
    if "logical_name" not in value:
        _exact(value, required)
    name = _string(value["staged_name"], f"{field}.staged_name")
    if not _STAGED_INPUT.fullmatch(name):
        raise PythonWorkerError(f"{field}.staged_name is invalid")
    _positive(value["size"], f"{field}.size", allow_zero=True)
    digest = _string(value["sha256"], f"{field}.sha256")
    if not _SHA256.fullmatch(digest):
        raise PythonWorkerError(f"{field}.sha256 is invalid")


def _read_manifest_object(stage: Path, descriptor: Mapping[str, object], limit: int) -> bytes:
    name = _string(descriptor["staged_name"], "staged_name")
    path = stage / name
    if path.parent != stage or path.is_symlink():
        raise PythonWorkerError("staged input path is unsafe")
    expected_size = _positive(descriptor["size"], "size", allow_zero=True)
    if expected_size > limit:
        raise PythonWorkerLimitError("staged input exceeds its byte limit")
    data = _read_bounded(path, limit)
    if len(data) != expected_size:
        raise PythonWorkerError("staged input size does not match its manifest")
    if hashlib.sha256(data).hexdigest() != descriptor["sha256"]:
        raise PythonWorkerError("staged input digest does not match its manifest")
    return data


def _validate_ast(tree: ast.AST) -> None:
    forbidden = (
        ast.Import,
        ast.ImportFrom,
        ast.Global,
        ast.Nonlocal,
        ast.AsyncFunctionDef,
        ast.Await,
        ast.Yield,
        ast.YieldFrom,
        ast.ClassDef,
    )
    forbidden_calls = {
        "breakpoint",
        "compile",
        "delattr",
        "dir",
        "eval",
        "exec",
        "getattr",
        "globals",
        "help",
        "input",
        "locals",
        "memoryview",
        "open",
        "setattr",
        "type",
        "vars",
        "__import__",
    }
    for node in ast.walk(tree):
        if isinstance(node, forbidden):
            raise PythonWorkerError(f"syntax {type(node).__name__} is unavailable")
        if isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            raise PythonWorkerError("private and dunder attributes are unavailable")
        if isinstance(node, ast.Name) and node.id.startswith("_"):
            raise PythonWorkerError("private and dunder names are unavailable")
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in forbidden_calls
        ):
            raise PythonWorkerError(f"call {node.func.id} is unavailable")


def _validate_module_test_ast(tree: ast.AST) -> None:
    forbidden_calls = {
        "breakpoint",
        "compile",
        "eval",
        "exec",
        "input",
        "__import__",
    }
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [alias.name for alias in node.names]
            if isinstance(node, ast.ImportFrom):
                if node.level or not node.module:
                    raise PythonWorkerError("relative imports are unavailable in module test mode")
                names = [node.module]
            for name in names:
                if name.split(".", 1)[0] not in _MODULE_TEST_IMPORTS:
                    raise PythonWorkerError(
                        f"import {name.split('.', 1)[0]} is unavailable in module test mode"
                    )
        if isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            raise PythonWorkerError("private and dunder attributes are unavailable")
        if isinstance(node, ast.Name) and node.id.startswith("__") and node.id != "__name__":
            raise PythonWorkerError("dunder names are unavailable")
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in forbidden_calls
        ):
            raise PythonWorkerError(f"call {node.func.id} is unavailable")


def _module_test_import(
    name: str,
    globals: Mapping[str, object] | None = None,
    locals: Mapping[str, object] | None = None,
    fromlist: Sequence[str] = (),
    level: int = 0,
) -> object:
    root_name = name.split(".", 1)[0]
    if level or root_name not in _MODULE_TEST_IMPORTS:
        raise PythonWorkerError(f"import {root_name} is unavailable in module test mode")
    if root_name == "sys":
        safe_sys = ModuleType("sys")
        safe_sys.version_info = sys.version_info  # type: ignore[attr-defined]
        safe_sys.platform = sys.platform  # type: ignore[attr-defined]
        safe_sys.maxsize = sys.maxsize  # type: ignore[attr-defined]
        return safe_sys
    return builtins.__import__(name, globals, locals, fromlist, level)


def _execute_module_tests(
    script_text: str,
    *,
    max_result_characters: int,
    max_output_characters: int,
) -> Mapping[str, object]:
    import unittest

    tree = ast.parse(script_text, filename="<project-artifact>", mode="exec")
    _validate_module_test_ast(tree)
    stdout = _BoundedOutput(max_output_characters)
    stderr = _BoundedOutput(max_output_characters)
    safe_builtins = dict(vars(builtins))
    for name in ("breakpoint", "compile", "eval", "exec", "input", "open"):
        safe_builtins.pop(name, None)
    safe_builtins["__import__"] = _module_test_import
    module = ModuleType("cupcake_project_artifact")
    module.__dict__.update(
        {
            "__builtins__": safe_builtins,
            "__file__": "<project-artifact>",
            "__name__": module.__name__,
            "__package__": None,
        }
    )
    original_stdout, original_stderr = sys.stdout, sys.stderr
    module_name = module.__name__
    previous_module = sys.modules.get(module_name)
    try:
        sys.modules[module_name] = module
        sys.stdout, sys.stderr = stdout, stderr  # type: ignore[assignment]
        # Test modules must retain ordinary ``assert`` statements. Optimizing
        # this compilation could silently remove the evidence being checked.
        code = compile(tree, "<project-artifact>", "exec", dont_inherit=True, optimize=0)
        exec(code, module.__dict__)
        suite = unittest.defaultTestLoader.loadTestsFromModule(module)
        test_count = suite.countTestCases()
        if test_count < 1:
            raise PythonWorkerError("module test mode found no unittest test cases")
        result = unittest.TextTestRunner(stream=stderr, verbosity=2).run(suite)
    finally:
        sys.stdout, sys.stderr = original_stdout, original_stderr
        if previous_module is None:
            sys.modules.pop(module_name, None)
        else:
            sys.modules[module_name] = previous_module

    executed_tests = result.testsRun - len(result.skipped)
    successful = result.wasSuccessful() and executed_tests > 0
    failures = [
        {"test": str(test), "message": _sanitize_test_failure(message)}
        for test, message in (*result.failures, *result.errors)
    ]
    payload: dict[str, object] = {
        "status": "complete" if successful else "failed",
        "exit_status": 0 if successful else 1,
        "stdout": stdout.value(),
        "stderr": stderr.value(),
        "value": None,
        "tests": {
            "run": result.testsRun,
            "failures": len(result.failures),
            "errors": len(result.errors),
            "skipped": len(result.skipped),
            "successful": successful,
            "details": failures,
        },
        "metadata": {
            "network_access": False,
            "network_enforcement": "broker-appcontainer-required",
            "execution_mode": "module_test",
        },
    }
    _normalize_result(payload, max_result_characters)
    return payload


def _sanitize_test_failure(message: str) -> str:
    sanitized = re.sub(r'File "(?:[A-Za-z]:)?[^"\r\n]*[\\/]', 'File "', message)
    return sanitized[:16_384]


def _safe_builtins(print_function: Callable[..., None]) -> dict[str, object]:
    return {
        "abs": abs,
        "all": all,
        "any": any,
        "bool": bool,
        "bytes": bytes,
        "dict": dict,
        "enumerate": enumerate,
        "filter": filter,
        "float": float,
        "int": int,
        "isinstance": isinstance,
        "len": len,
        "list": list,
        "map": map,
        "max": max,
        "min": min,
        "print": print_function,
        "range": range,
        "repr": repr,
        "reversed": reversed,
        "round": round,
        "set": set,
        "slice": slice,
        "sorted": sorted,
        "str": str,
        "sum": sum,
        "tuple": tuple,
        "zip": zip,
    }


def _normalize_result(value: object, max_characters: int) -> object:
    def normalize(item: object, depth: int) -> object:
        if depth > 20:
            raise PythonWorkerLimitError("structured result nesting exceeds its limit")
        if item is None or isinstance(item, (bool, int, str)):
            return item
        if isinstance(item, float):
            if item != item or item in (float("inf"), float("-inf")):
                raise PythonWorkerError("structured result contains a non-finite number")
            return item
        if isinstance(item, bytes):
            return {"type": "bytes", "hex": item.hex()}
        if isinstance(item, (list, tuple)):
            values = cast(Sequence[object], item)
            if len(values) > 10_000:
                raise PythonWorkerLimitError("structured result collection is too large")
            return [normalize(child, depth + 1) for child in values]
        if isinstance(item, Mapping):
            mapping = cast(Mapping[object, object], item)
            if len(mapping) > 10_000 or not all(isinstance(key, str) for key in mapping):
                raise PythonWorkerError(
                    "structured result dictionaries require bounded string keys"
                )
            return {str(key): normalize(child, depth + 1) for key, child in mapping.items()}
        raise PythonWorkerError("structured result contains an unsupported value")

    normalized = normalize(value, 0)
    encoded = json.dumps(normalized, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if len(encoded) > max_characters:
        raise PythonWorkerLimitError("structured result exceeds its character limit")
    return normalized


def _validate_stage(stage: Path) -> Path:
    if stage.is_symlink():
        raise PythonWorkerError("stage root cannot be a symbolic link")
    resolved = stage.resolve(strict=True)
    if not resolved.is_dir():
        raise PythonWorkerError("stage root is not a directory")
    return resolved


def _read_bounded(path: Path, max_bytes: int) -> bytes:
    if path.is_symlink():
        raise PythonWorkerError("staged object cannot be a symbolic link")
    descriptor = os.open(
        path,
        os.O_RDONLY | int(getattr(os, "O_BINARY", 0)) | int(getattr(os, "O_NOFOLLOW", 0)),
    )
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > max_bytes:
            raise PythonWorkerLimitError("staged object exceeds its byte limit")
        data = bytearray()
        while len(data) <= max_bytes:
            block = os.read(descriptor, min(1024 * 1024, max_bytes + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        if len(data) > max_bytes:
            raise PythonWorkerLimitError("staged object exceeds its byte limit")
        return bytes(data)
    finally:
        os.close(descriptor)


def _write_response(stage: Path, frame: bytes, max_bytes: int) -> None:
    if len(frame) > min(max_bytes, MAX_CONTROL_FRAME_BYTES + 4):
        raise PythonWorkerLimitError("response frame exceeds its byte limit")
    destination = stage / RESPONSE_FILE
    if destination.is_symlink():
        raise PythonWorkerError("response frame cannot be a symbolic link")
    descriptor = os.open(
        destination,
        os.O_WRONLY
        | os.O_TRUNC
        | int(getattr(os, "O_NOFOLLOW", 0))
        | int(getattr(os, "O_BINARY", 0)),
    )
    try:
        offset = 0
        while offset < len(frame):
            written = os.write(descriptor, frame[offset:])
            if written < 1:
                raise OSError("unable to write response frame")
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.chmod(destination, stat.S_IRUSR)


def _encode_frame(payload: Mapping[str, object]) -> bytes:
    body = json.dumps(
        payload,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    if not body or len(body) > MAX_CONTROL_FRAME_BYTES:
        raise PythonWorkerLimitError("control payload exceeds its byte limit")
    return struct.pack(">I", len(body)) + body


def _decode_frame(frame: bytes) -> Mapping[str, object]:
    if len(frame) < 4:
        raise PythonWorkerError("control frame header is truncated")
    size = struct.unpack(">I", frame[:4])[0]
    if size < 1 or size > MAX_CONTROL_FRAME_BYTES or len(frame) != size + 4:
        raise PythonWorkerError("control frame size is invalid")
    try:
        value = json.loads(
            frame[4:].decode("utf-8", errors="strict"), object_pairs_hook=_unique_object
        )
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise PythonWorkerError("control frame is not strict UTF-8 JSON") from exc
    return _object(value, "root")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise PythonWorkerError(f"duplicate JSON field: {key}")
        result[key] = value
    return result


def _reject_sensitive_environment() -> None:
    for name in os.environ:
        upper = name.upper()
        if any(marker in upper for marker in _SENSITIVE_MARKERS):
            raise PythonWorkerError("worker environment contains a prohibited variable")


def _install_network_guard() -> None:
    def denied(*_args: object, **_kwargs: object) -> NoReturn:
        raise PythonWorkerError("network access is unavailable")

    socket.socket = denied  # type: ignore[assignment,misc]
    socket.create_connection = denied  # type: ignore[assignment]
    socket.create_server = denied  # type: ignore[assignment]
    socket.getaddrinfo = denied  # type: ignore[assignment]


def _check_deadline(deadline_unix_ms: int) -> None:
    if int(time.time() * 1_000) > deadline_unix_ms:
        raise PythonWorkerLimitError("execution deadline expired")


def _public_error(error: BaseException) -> Mapping[str, str]:
    if isinstance(error, PythonWorkerLimitError):
        return {"code": "limit_exceeded", "message": str(error)[:512]}
    if isinstance(error, (PythonWorkerError, SyntaxError)):
        return {"code": "invalid_execution", "message": str(error)[:512]}
    return {"code": "execution_failed", "message": "sandboxed Python execution failed"}


def _exact(value: Mapping[str, object], expected: set[str]) -> None:
    if set(value) != expected:
        raise PythonWorkerError("JSON object fields do not match the protocol")


def _object(value: object, field: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise PythonWorkerError(f"{field} must be an object")
    mapping = cast(Mapping[object, object], value)
    if not all(isinstance(key, str) for key in mapping):
        raise PythonWorkerError(f"{field} must be an object")
    return cast(Mapping[str, object], mapping)


def _array(value: object, field: str) -> list[object]:
    if not isinstance(value, list):
        raise PythonWorkerError(f"{field} must be an array")
    return cast(list[object], value)


def _string(value: object, field: str) -> str:
    if not isinstance(value, str) or len(value) > 1024:
        raise PythonWorkerError(f"{field} must be a bounded string")
    return value


def _identifier(value: object, field: str) -> str:
    result = _string(value, field)
    if not 16 <= len(result) <= 80 or not all(
        character.isalnum() or character in "-_" for character in result
    ):
        raise PythonWorkerError(f"{field} is invalid")
    return result


def _integer(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise PythonWorkerError(f"{field} must be an integer")
    return value


def _positive(value: object, field: str, *, allow_zero: bool = False) -> int:
    result = _integer(value, field)
    if result < (0 if allow_zero else 1):
        raise PythonWorkerError(f"{field} is outside the allowed range")
    return result


if __name__ == "__main__":
    raise SystemExit(main())
