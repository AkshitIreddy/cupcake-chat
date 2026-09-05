from __future__ import annotations

import contextlib
import hashlib
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Protocol

from .models import IngestionLimits, LimitExceededError, SourceLocator, UnsupportedFormatError
from .worker_protocol import (
    WorkerLimits,
    WorkerParseRequest,
    WorkerProtocolError,
    decode_document,
    decode_single_frame,
    encode_frame,
    parse_response,
    sha256_hex,
)

SUPPORTED_WORKER_EXTENSIONS = frozenset(
    {
        ".pdf",
        ".docx",
        ".odt",
        ".pptx",
        ".xlsx",
        ".html",
        ".xhtml",
        ".md",
        ".markdown",
        ".csv",
    }
)
DOCUMENT_REQUEST_FILE = "document-request.frame"
DOCUMENT_RESPONSE_FILE = "document-response.frame"


class NetworkPolicy(StrEnum):
    DENY = "deny"


class WorkerIsolation(StrEnum):
    WINDOWS_APPCONTAINER_NO_NETWORK = "windows-appcontainer-no-network"
    PROCESS_GUARD_TEST_ONLY = "process-guard-test-only"

    @property
    def production_safe(self) -> bool:
        return self is WorkerIsolation.WINDOWS_APPCONTAINER_NO_NETWORK


@dataclass(frozen=True, slots=True)
class WindowsSandboxRequirements:
    app_container: bool = True
    capabilities: tuple[str, ...] = ()
    job_kill_on_close: bool = True
    active_process_limit: int = 1
    memory_limit_bytes: int = 2 * 1024 * 1024 * 1024
    cpu_time_limit_seconds: int = 180
    child_processes: bool = False
    win32k_system_calls: bool = False
    dynamic_code: bool = False
    network: NetworkPolicy = NetworkPolicy.DENY


@dataclass(frozen=True, slots=True)
class DocumentWorkerLaunchSpec:
    """Declarative request for the signed Rust broker's Windows sandbox.

    The broker must resolve every path before creating the process, grant only
    ``read_paths`` and ``write_paths``, launch in an AppContainer with no network
    capability, and attach the process to a kill-on-close Job Object. A broker
    that cannot prove those properties must reject the launch.
    """

    executable: str
    arguments: tuple[str, ...]
    working_directory: str
    read_paths: tuple[str, ...]
    write_paths: tuple[str, ...]
    environment: tuple[tuple[str, str], ...]
    stdin_protocol: str
    stdout_protocol: str
    timeout_seconds: int
    max_stdout_bytes: int
    max_stderr_bytes: int
    windows: WindowsSandboxRequirements

    def to_json(self) -> dict[str, object]:
        return {
            "version": 1,
            "executable": self.executable,
            "arguments": list(self.arguments),
            "workingDirectory": self.working_directory,
            "filesystem": {
                "default": "deny",
                "readOnly": list(self.read_paths),
                "writeOnly": list(self.write_paths),
            },
            "environment": {
                "inherit": False,
                "values": dict(self.environment),
            },
            "protocol": {
                "stdin": self.stdin_protocol,
                "stdout": self.stdout_protocol,
                "maxStdoutBytes": self.max_stdout_bytes,
                "maxStderrBytes": self.max_stderr_bytes,
            },
            "timeoutSeconds": self.timeout_seconds,
            "network": self.windows.network,
            "windows": {
                "appContainer": self.windows.app_container,
                "capabilities": list(self.windows.capabilities),
                "jobKillOnClose": self.windows.job_kill_on_close,
                "activeProcessLimit": self.windows.active_process_limit,
                "memoryLimitBytes": self.windows.memory_limit_bytes,
                "cpuTimeLimitSeconds": self.windows.cpu_time_limit_seconds,
                "childProcesses": self.windows.child_processes,
                "win32kSystemCalls": self.windows.win32k_system_calls,
                "dynamicCode": self.windows.dynamic_code,
            },
        }


class DocumentWorkerTransport(Protocol):
    @property
    def available(self) -> bool: ...

    @property
    def isolation(self) -> WorkerIsolation: ...

    def invoke(self, spec: DocumentWorkerLaunchSpec, request_frame: bytes) -> bytes: ...


BrokerInvoke = Callable[[DocumentWorkerLaunchSpec, bytes], bytes]


@dataclass(frozen=True, slots=True)
class BrokerSandboxTransport:
    """Adapter around the broker's authenticated sandbox invocation channel."""

    invoke_sandbox: BrokerInvoke

    @property
    def available(self) -> bool:
        return True

    @property
    def isolation(self) -> WorkerIsolation:
        return WorkerIsolation.WINDOWS_APPCONTAINER_NO_NETWORK

    def invoke(self, spec: DocumentWorkerLaunchSpec, request_frame: bytes) -> bytes:
        response = self.invoke_sandbox(spec, request_frame)
        if len(response) > spec.max_stdout_bytes:
            raise WorkerProtocolError("sandbox returned an oversized control response")
        return response


@dataclass(frozen=True, slots=True)
class LocalTestSubprocessTransport:
    """Real child-process transport for tests, never acceptable in production.

    Python-level socket blocking is defense in depth, not an OS security
    boundary. The adapter requires a second explicit test opt-in before it will
    accept this transport.
    """

    command: tuple[str, ...] = ()

    @property
    def available(self) -> bool:
        return True

    @property
    def isolation(self) -> WorkerIsolation:
        return WorkerIsolation.PROCESS_GUARD_TEST_ONLY

    def invoke(self, spec: DocumentWorkerLaunchSpec, request_frame: bytes) -> bytes:
        command = self.command or (spec.executable, *spec.arguments)
        environment = dict(spec.environment)
        creation_flags = 0
        if os.name == "nt":
            creation_flags = int(getattr(subprocess, "CREATE_NO_WINDOW", 0)) | int(
                getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            )
        process = subprocess.Popen(
            command,
            cwd=spec.working_directory,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=creation_flags,
        )
        try:
            stdout, _stderr = process.communicate(request_frame, timeout=spec.timeout_seconds)
        except subprocess.TimeoutExpired as exc:
            process.kill()
            process.communicate()
            raise TimeoutError("document worker exceeded its deadline") from exc
        if len(stdout) > spec.max_stdout_bytes:
            raise WorkerProtocolError("document worker wrote an oversized control response")
        if spec.stdout_protocol == "none":
            return b""
        if process.returncode != 0 and not stdout:
            raise WorkerProtocolError("document worker terminated without a protocol response")
        return stdout


@dataclass(slots=True)
class DoclingWorkerAdapter:
    transport: DocumentWorkerTransport | None = None
    limits: IngestionLimits = field(default_factory=IngestionLimits)
    worker_executable: str | None = None
    staging_root: Path | None = None
    allow_unenforced_for_tests: bool = False

    @property
    def available(self) -> bool:
        if self.transport is None or not self.transport.available:
            return False
        return self.transport.isolation.production_safe or self.allow_unenforced_for_tests

    def configure_limits(self, limits: IngestionLimits) -> None:
        self.limits = limits

    def convert(self, path: Path) -> Sequence[tuple[str, SourceLocator]]:
        if not self.available or self.transport is None:
            raise UnsupportedFormatError(
                "structured document parsing requires the broker's network-denied Windows sandbox"
            )
        suffix = path.suffix.casefold()
        if suffix not in SUPPORTED_WORKER_EXTENSIONS:
            raise UnsupportedFormatError(f"isolated document parser does not allow {suffix!r}")
        with _ImmutableStage.create(self.staging_root) as stage:
            staged_input = stage.copy_input(path, self.limits.max_file_bytes)
            request_id = uuid.uuid4().hex
            stage_token = uuid.uuid4().hex
            output_name = f"{uuid.uuid4().hex}.json"
            stage.reserve_output(output_name)
            deadline_ms = int((time.time() + self.limits.document_worker_timeout_seconds) * 1_000)
            request = WorkerParseRequest(
                request_id=request_id,
                stage_token=stage_token,
                input_name=staged_input.name,
                output_name=output_name,
                source_name=path.name,
                source_suffix=suffix,
                input_size=staged_input.size,
                input_sha256=staged_input.sha256,
                limits=WorkerLimits(
                    max_input_bytes=self.limits.max_file_bytes,
                    max_output_bytes=self.limits.max_document_worker_output_bytes,
                    max_text_characters=self.limits.max_text_characters,
                    max_pages=self.limits.max_document_pages,
                    max_entries=self.limits.max_document_entries,
                    deadline_unix_ms=deadline_ms,
                ),
            )
            request_frame = encode_frame(request.to_json())
            staged_control = self.transport.isolation.production_safe
            if staged_control:
                stage.write_control_request(DOCUMENT_REQUEST_FILE, request_frame)
                stage.reserve_output(DOCUMENT_RESPONSE_FILE)
            spec = self._launch_spec(
                stage.path,
                staged_input.path,
                stage.path / output_name,
                staged_control=staged_control,
            )
            returned_frame = self.transport.invoke(spec, b"" if staged_control else request_frame)
            if staged_control and not returned_frame:
                returned_frame = stage.read_control_response(
                    DOCUMENT_RESPONSE_FILE, max_bytes=spec.max_stdout_bytes
                )
            response_payload = decode_single_frame(returned_frame)
            response = parse_response(
                response_payload, request_id=request_id, stage_token=stage_token
            )
            if response.output_name != output_name:
                raise WorkerProtocolError("worker selected an unexpected staged output name")
            data = stage.read_output(
                response.output_name,
                expected_size=response.output_size,
                expected_sha256=response.output_sha256,
                max_bytes=self.limits.max_document_worker_output_bytes,
            )
            document = decode_document(
                data,
                max_entries=self.limits.max_document_entries,
                max_characters=self.limits.max_text_characters,
            )
            if len(document.entries) != response.entry_count:
                raise WorkerProtocolError("worker entry count does not match its staged result")
            pages = {entry.locator.page for entry in document.entries if entry.locator.page}
            if len(pages) != response.page_count:
                raise WorkerProtocolError("worker page count does not match its staged result")
            return tuple((entry.text, entry.locator) for entry in document.entries)

    def _launch_spec(
        self,
        stage: Path,
        input_path: Path,
        output_path: Path,
        *,
        staged_control: bool,
    ) -> DocumentWorkerLaunchSpec:
        executable = self.worker_executable or sys.executable
        arguments: tuple[str, ...]
        if self.worker_executable or bool(getattr(sys, "frozen", False)):
            arguments = (
                "--document-worker",
                "--stage-root",
                str(stage),
                "--worker-transport",
                "staged" if staged_control else "stdio",
            )
        else:
            arguments = (
                "-I",
                "-m",
                "cupcake_runtime.ingestion.document_worker",
                "--stage-root",
                str(stage),
                "--worker-transport",
                "staged" if staged_control else "stdio",
            )
        environment = _minimal_worker_environment(stage)
        timeout = self.limits.document_worker_timeout_seconds
        return DocumentWorkerLaunchSpec(
            executable=str(Path(executable).resolve()),
            arguments=arguments,
            working_directory=str(stage),
            read_paths=(str(input_path),)
            + ((str(stage / DOCUMENT_REQUEST_FILE),) if staged_control else ()),
            write_paths=(str(output_path),)
            + ((str(stage / DOCUMENT_RESPONSE_FILE),) if staged_control else ()),
            environment=tuple(sorted(environment.items())),
            stdin_protocol=(
                "none"
                if staged_control
                else "cupcake-document-worker/1 length-prefixed-json single-request"
            ),
            stdout_protocol=(
                "none"
                if staged_control
                else "cupcake-document-worker/1 length-prefixed-json single-response"
            ),
            timeout_seconds=timeout,
            max_stdout_bytes=1 * 1024 * 1024 + 4,
            max_stderr_bytes=64 * 1024,
            windows=WindowsSandboxRequirements(
                memory_limit_bytes=2 * 1024 * 1024 * 1024,
                cpu_time_limit_seconds=timeout,
            ),
        )


@dataclass(frozen=True, slots=True)
class _StagedInput:
    name: str
    path: Path
    size: int
    sha256: str


@dataclass(slots=True)
class _ImmutableStage:
    path: Path

    @classmethod
    def create(cls, staging_root: Path | None) -> _ImmutableStage:
        if staging_root is not None:
            staging_root.mkdir(parents=True, exist_ok=True)
            root = str(staging_root.resolve())
        else:
            root = None
        path = Path(tempfile.mkdtemp(prefix="cupcake-document-", dir=root)).resolve()
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
        return cls(path)

    def __enter__(self) -> _ImmutableStage:
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        for child in self.path.iterdir():
            with contextlib.suppress(OSError):
                os.chmod(child, stat.S_IRUSR | stat.S_IWUSR)
        shutil.rmtree(self.path, ignore_errors=False)

    def copy_input(self, source: Path, max_bytes: int) -> _StagedInput:
        before = source.stat(follow_symlinks=False)
        if before.st_size > max_bytes:
            raise LimitExceededError(f"source exceeds {max_bytes} bytes: {source.name}")
        name = f"{uuid.uuid4().hex}.input"
        destination = self.path / name
        source_flags = (
            os.O_RDONLY | int(getattr(os, "O_BINARY", 0)) | int(getattr(os, "O_NOFOLLOW", 0))
        )
        output_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | int(getattr(os, "O_BINARY", 0))
        source_fd = os.open(source, source_flags)
        output_fd = os.open(destination, output_flags, stat.S_IRUSR | stat.S_IWUSR)
        digest = hashlib.sha256()
        size = 0
        try:
            opened = os.fstat(source_fd)
            if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                raise WorkerProtocolError("source changed while it was staged")
            while True:
                block = os.read(source_fd, min(1024 * 1024, max_bytes + 1 - size))
                if not block:
                    break
                size += len(block)
                if size > max_bytes:
                    raise LimitExceededError(f"source exceeds {max_bytes} bytes: {source.name}")
                digest.update(block)
                _write_all(output_fd, block)
            os.fsync(output_fd)
            after = source.stat(follow_symlinks=False)
            if (after.st_size, after.st_mtime_ns) != (before.st_size, before.st_mtime_ns):
                raise WorkerProtocolError("source changed while it was staged")
        except BaseException:
            os.close(output_fd)
            output_fd = -1
            destination.unlink(missing_ok=True)
            raise
        finally:
            os.close(source_fd)
            if output_fd >= 0:
                os.close(output_fd)
        os.chmod(destination, stat.S_IRUSR)
        return _StagedInput(name, destination, size, digest.hexdigest())

    def read_output(
        self,
        name: str,
        *,
        expected_size: int,
        expected_sha256: str,
        max_bytes: int,
    ) -> bytes:
        path = self.path / name
        if path.parent != self.path or path.is_symlink():
            raise WorkerProtocolError("staged result path is unsafe")
        descriptor = os.open(
            path,
            os.O_RDONLY | int(getattr(os, "O_BINARY", 0)) | int(getattr(os, "O_NOFOLLOW", 0)),
        )
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                raise WorkerProtocolError("staged result is not a regular file")
            if info.st_size != expected_size or info.st_size > max_bytes:
                raise WorkerProtocolError("staged result size does not match its response")
            data = bytearray()
            while len(data) < info.st_size:
                block = os.read(descriptor, min(1024 * 1024, info.st_size - len(data)))
                if not block:
                    raise WorkerProtocolError("staged result was truncated during reading")
                data.extend(block)
        finally:
            os.close(descriptor)
        immutable = bytes(data)
        if sha256_hex(immutable) != expected_sha256:
            raise WorkerProtocolError("staged result digest does not match its response")
        return immutable

    def reserve_output(self, name: str) -> Path:
        path = self.path / name
        if path.parent != self.path:
            raise WorkerProtocolError("staged output path is unsafe")
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | int(getattr(os, "O_BINARY", 0)),
            stat.S_IRUSR | stat.S_IWUSR,
        )
        os.close(descriptor)
        return path

    def write_control_request(self, name: str, frame: bytes) -> Path:
        path = self.reserve_output(name)
        path.write_bytes(frame)
        os.chmod(path, stat.S_IRUSR)
        return path

    def read_control_response(self, name: str, *, max_bytes: int) -> bytes:
        path = self.path / name
        if path.is_symlink():
            raise WorkerProtocolError("control response cannot be a symbolic link")
        info = path.stat(follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) or not 1 <= info.st_size <= max_bytes:
            raise WorkerProtocolError("control response size is outside the allowed range")
        descriptor = os.open(
            path,
            os.O_RDONLY | int(getattr(os, "O_BINARY", 0)) | int(getattr(os, "O_NOFOLLOW", 0)),
        )
        try:
            data = bytearray()
            while len(data) < info.st_size:
                block = os.read(descriptor, info.st_size - len(data))
                if not block:
                    raise WorkerProtocolError("control response was truncated")
                data.extend(block)
            return bytes(data)
        finally:
            os.close(descriptor)


def _minimal_worker_environment(stage: Path) -> dict[str, str]:
    environment = {
        "CUPCAKE_DOCUMENT_WORKER": "1",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "NO_PROXY": "*",
        "no_proxy": "*",
        "TEMP": str(stage),
        "TMP": str(stage),
    }
    if os.name == "nt":
        for name in ("SystemRoot", "WINDIR"):
            value = os.environ.get(name)
            if value:
                environment[name] = value
    return environment


def _write_all(descriptor: int, data: bytes) -> None:
    offset = 0
    while offset < len(data):
        written = os.write(descriptor, data[offset:])
        if written < 1:
            raise OSError("unable to write staged input")
        offset += written
