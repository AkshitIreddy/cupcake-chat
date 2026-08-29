"""Management APIs for Ollama, LM Studio, llama.cpp, and external vLLM."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .discovery import RuntimeDiscovery, validate_endpoint
from .http import JsonHttpClient
from .types import PerformanceMeasurement, RuntimeEndpoint, RuntimeKind, RuntimeState


@dataclass(frozen=True, slots=True)
class OperationProgress:
    operation: str
    state: str
    completed: int | None = None
    total: int | None = None
    detail: str | None = None


@dataclass(frozen=True, slots=True)
class LlamaServerConfig:
    context_size: int = 4096
    gpu_layers: int | str = 0
    threads: int | None = None
    device: str | None = "none"
    parallel: int = 1
    batch_size: int | None = None
    ubatch_size: int | None = None

    def validate(self) -> None:
        if not 512 <= self.context_size <= 1_048_576:
            raise ValueError("context_size is outside safe bounds")
        if isinstance(self.gpu_layers, int):
            if not 0 <= self.gpu_layers <= 10_000:
                raise ValueError("gpu_layers is outside safe bounds")
        elif self.gpu_layers not in {"auto", "all"}:
            raise ValueError("gpu_layers must be an integer, 'auto', or 'all'")
        if self.threads is not None and not 1 <= self.threads <= 1024:
            raise ValueError("threads is outside safe bounds")
        if not 1 <= self.parallel <= 64:
            raise ValueError("parallel is outside safe bounds")
        for name, value in (("batch_size", self.batch_size), ("ubatch_size", self.ubatch_size)):
            if value is not None and not 1 <= value <= 65_536:
                raise ValueError(f"{name} is outside safe bounds")
        if self.device is not None and any(character in self.device for character in "\r\n\0"):
            raise ValueError("device contains invalid characters")


class OllamaManager:
    def __init__(
        self, base_url: str = "http://127.0.0.1:11434", client: JsonHttpClient | None = None
    ):
        self.base_url = validate_endpoint(base_url, allow_remote=False)
        self.client = client or JsonHttpClient()

    async def pull(self, model: str) -> AsyncIterator[OperationProgress]:
        if not model.strip():
            raise ValueError("model name is required")
        async for event in self.client.stream_json(
            "POST", f"{self.base_url}/api/pull", {"name": model, "stream": True}
        ):
            yield OperationProgress(
                "pull",
                event.get("status", "working"),
                event.get("completed"),
                event.get("total"),
                event.get("digest"),
            )

    async def remove(self, model: str) -> None:
        await self.client.request("DELETE", f"{self.base_url}/api/delete", {"name": model})

    async def load(self, model: str, *, keep_alive: str = "5m") -> None:
        await self.client.request(
            "POST", f"{self.base_url}/api/generate", {"model": model, "keep_alive": keep_alive}
        )

    async def unload(self, model: str) -> None:
        await self.client.request(
            "POST", f"{self.base_url}/api/generate", {"model": model, "keep_alive": 0}
        )


class LMStudioManager:
    def __init__(
        self, base_url: str = "http://127.0.0.1:1234", client: JsonHttpClient | None = None
    ):
        self.base_url = validate_endpoint(base_url, allow_remote=False)
        self.client = client or JsonHttpClient()

    async def list_models(self) -> Any:
        return await self.client.request("GET", f"{self.base_url}/api/v1/models")

    async def download(self, model: str) -> Any:
        return await self.client.request(
            "POST", f"{self.base_url}/api/v1/models/download", {"model": model}
        )

    async def load(self, model: str, *, context_length: int | None = None) -> Any:
        payload: dict[str, Any] = {"model": model}
        if context_length:
            payload["context_length"] = context_length
        return await self.client.request("POST", f"{self.base_url}/api/v1/models/load", payload)

    async def unload(self, model: str) -> Any:
        return await self.client.request(
            "POST", f"{self.base_url}/api/v1/models/unload", {"model": model}
        )


class LlamaCppSupervisor:
    """Own one authenticated, loopback-only ``llama-server`` process.

    The server's built-in UI, agent mode, MCP proxy, and filesystem/shell tools
    are never enabled. CUPCAKEAGI's broker remains the sole tool authority.
    Current llama.cpp server arguments are documented at:
    https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
    """

    def __init__(
        self,
        executable: Path,
        *,
        host: str = "127.0.0.1",
        port: int = 0,
        log_directory: Path | None = None,
    ):
        if not (0 <= port <= 65535):
            raise ValueError("port must be in 0..65535")
        if host not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("managed llama.cpp must bind to loopback")
        self.executable = executable
        self.host = host
        self.port = port
        self._process: subprocess.Popen[bytes] | None = None
        self._state = RuntimeState.STOPPED if executable.is_file() else RuntimeState.ABSENT
        self._detail: str | None = None
        self._model: Path | None = None
        self._api_key: str | None = None
        self._api_prefix: str | None = None
        self._started_at: float | None = None
        # Kept as a compatibility argument for callers from earlier RCs. Logs
        # are intentionally retained only as a bounded in-memory tail.
        del log_directory
        self._stderr_tail = bytearray()
        self._stderr_thread: threading.Thread | None = None

    @property
    def state(self) -> RuntimeState:
        if self._process is None:
            return RuntimeState.STOPPED if self.executable.is_file() else RuntimeState.ABSENT
        if self._process.poll() is not None and self._state not in {
            RuntimeState.STOPPED,
            RuntimeState.FAILED,
        }:
            self._state = RuntimeState.FAILED
            self._detail = f"llama-server exited with code {self._process.returncode}"
        return self._state

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}{self._api_prefix or ''}"

    @property
    def active_model(self) -> Path | None:
        return self._model

    @property
    def detail(self) -> str | None:
        return self._detail

    def start(
        self,
        model: Path,
        *,
        context_size: int = 4096,
        gpu_layers: int | str = 0,
        threads: int | None = None,
        device: str | None = "none",
        parallel: int = 1,
        batch_size: int | None = None,
        ubatch_size: int | None = None,
    ) -> int:
        if self._process and self._process.poll() is None:
            raise RuntimeError("llama.cpp runtime is already running")
        if not self.executable.is_file():
            raise FileNotFoundError(self.executable)
        if not model.is_file():
            raise FileNotFoundError(model)
        config = LlamaServerConfig(
            context_size=context_size,
            gpu_layers=gpu_layers,
            threads=threads,
            device=device,
            parallel=parallel,
            batch_size=batch_size,
            ubatch_size=ubatch_size,
        )
        config.validate()
        if self.port == 0:
            self.port = _unused_loopback_port(self.host)
        self._api_key = secrets.token_urlsafe(32)
        self._api_prefix = f"/cupcake-{secrets.token_hex(16)}"
        args = [
            str(self.executable),
            "--model",
            str(model),
            "--host",
            self.host,
            "--port",
            str(self.port),
            "--ctx-size",
            str(context_size),
            "--n-gpu-layers",
            str(gpu_layers),
            "--parallel",
            str(parallel),
            "--no-ui",
            "--jinja",
        ]
        if device is not None:
            args.extend(["--device", device])
        if threads:
            args.extend(["--threads", str(threads)])
        if batch_size:
            args.extend(["--batch-size", str(batch_size)])
        if ubatch_size:
            args.extend(["--ubatch-size", str(ubatch_size)])
        environment = _minimal_server_environment(self._api_key, self._api_prefix)
        creationflags = 0
        if sys.platform == "win32":
            creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        self._process = subprocess.Popen(
            args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            shell=False,
            cwd=self.executable.parent,
            env=environment,
            creationflags=creationflags,
        )
        self._state = RuntimeState.STARTING
        self._detail = "loading model"
        self._model = model
        self._started_at = time.monotonic()
        self._stderr_tail.clear()
        self._stderr_thread = threading.Thread(
            target=self._drain_stderr,
            name="cupcake-llama-stderr",
            daemon=True,
        )
        self._stderr_thread.start()
        return self._process.pid

    async def wait_until_ready(self, *, timeout_seconds: float = 180.0) -> RuntimeEndpoint:
        if self._process is None:
            raise RuntimeError("llama.cpp runtime is not starting")
        deadline = time.monotonic() + timeout_seconds
        last_detail = "loading model"
        while time.monotonic() < deadline:
            if self._process.poll() is not None:
                self._state = RuntimeState.FAILED
                self._detail = self._failure_detail()
                raise RuntimeError(self._detail)
            try:
                status, payload = await asyncio.to_thread(self._health_request)
                if status == 200:
                    self._state = RuntimeState.READY
                    self._detail = None
                    return self.endpoint(metadata=payload if isinstance(payload, dict) else {})
                if isinstance(payload, dict):
                    last_detail = str(payload.get("error") or payload.get("status") or last_detail)
            except (OSError, URLError, TimeoutError):
                pass
            await asyncio.sleep(0.1)
        self._state = RuntimeState.FAILED
        detail = f"llama-server did not become ready within {timeout_seconds:g}s: {last_detail}"
        self._detail = detail
        await self.stop()
        raise TimeoutError(detail)

    def endpoint(self, *, metadata: dict[str, Any] | None = None) -> RuntimeEndpoint:
        return RuntimeEndpoint(
            id=f"{RuntimeKind.CUPCAKE_LLAMA_CPP.value}:{self.base_url}",
            kind=RuntimeKind.CUPCAKE_LLAMA_CPP,
            base_url=self.base_url,
            state=self.state,
            models=(str(self._model),) if self._model else (),
            managed=True,
            detail=self._detail,
            metadata={
                "pid": self._process.pid
                if self._process and self._process.poll() is None
                else None,
                "uptimeSeconds": (
                    time.monotonic() - self._started_at if self._started_at is not None else None
                ),
                "diagnosticBytes": len(self._stderr_tail),
                **(metadata or {}),
            },
        )

    def authorization_headers(self) -> dict[str, str]:
        if not self._api_key:
            raise RuntimeError("llama.cpp runtime is not running")
        return {"Authorization": f"Bearer {self._api_key}"}

    def version(self, *, timeout_seconds: float = 5.0) -> str:
        if not self.executable.is_file():
            raise FileNotFoundError(self.executable)
        result = subprocess.run(
            [str(self.executable), "--version"],
            cwd=self.executable.parent,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=False,
            shell=False,
            timeout=timeout_seconds,
            env=_minimal_server_environment(None, None),
        )
        output = (result.stdout + result.stderr).decode("utf-8", errors="replace").strip()
        if result.returncode != 0 or not output:
            raise RuntimeError(f"could not inspect llama.cpp version (exit {result.returncode})")
        return output[:4096]

    def list_devices(self, *, timeout_seconds: float = 10.0) -> tuple[str, ...]:
        if not self.executable.is_file():
            raise FileNotFoundError(self.executable)
        result = subprocess.run(
            [str(self.executable), "--list-devices"],
            cwd=self.executable.parent,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=False,
            shell=False,
            timeout=timeout_seconds,
            env=_minimal_server_environment(None, None),
        )
        output = (result.stdout + result.stderr).decode("utf-8", errors="replace")
        if result.returncode != 0:
            raise RuntimeError(f"could not list llama.cpp devices (exit {result.returncode})")
        return tuple(line.strip() for line in output.splitlines() if line.strip())

    async def stop(self, *, timeout_seconds: float = 8.0) -> None:
        process = self._process
        if process is None or process.poll() is not None:
            self._cleanup_process()
            return
        self._state = RuntimeState.STOPPING
        process.terminate()
        try:
            await asyncio.to_thread(process.wait, timeout_seconds)
        except subprocess.TimeoutExpired:
            process.kill()
            await asyncio.to_thread(process.wait, 3)
        finally:
            self._cleanup_process()

    def _health_request(self) -> tuple[int, Any]:
        request = Request(f"{self.base_url}/health", headers={"Accept": "application/json"})
        try:
            with urlopen(request, timeout=1.0) as response:
                data = response.read(1024 * 1024)
                return int(response.status), json.loads(data) if data else None
        except HTTPError as exc:
            data = exc.read(1024 * 1024)
            try:
                payload: Any = json.loads(data) if data else None
            except json.JSONDecodeError:
                payload = data.decode("utf-8", errors="replace")
            return exc.code, payload

    def _failure_detail(self) -> str:
        code = self._process.returncode if self._process else None
        tail = bytes(self._stderr_tail[-8192:]).decode("utf-8", errors="replace").strip()
        return f"llama-server exited with code {code}" + (f": {tail}" if tail else "")

    def _drain_stderr(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        try:
            while chunk := process.stderr.read(8192):
                self._stderr_tail.extend(chunk)
                if len(self._stderr_tail) > 65_536:
                    del self._stderr_tail[:-65_536]
        except (OSError, ValueError):
            return

    def _cleanup_process(self) -> None:
        process = self._process
        if process is not None and process.stderr is not None:
            process.stderr.close()
        if self._stderr_thread and self._stderr_thread is not threading.current_thread():
            self._stderr_thread.join(timeout=1.0)
        self._stderr_thread = None
        self._process = None
        self._api_key = None
        self._api_prefix = None
        self._model = None
        self._started_at = None
        self._state = RuntimeState.STOPPED if self.executable.is_file() else RuntimeState.ABSENT
        self._detail = None


def _unused_loopback_port(host: str) -> int:
    family = socket.AF_INET6 if host == "::1" else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as listener:
        listener.bind((host, 0))
        return int(listener.getsockname()[1])


def _minimal_server_environment(api_key: str | None, api_prefix: str | None) -> dict[str, str]:
    # Provider credentials must never leak into a model process. Keep only the
    # Windows runtime variables and hardware-driver selectors llama.cpp needs.
    allowed = {
        "SYSTEMROOT",
        "WINDIR",
        "TEMP",
        "TMP",
        "PATH",
        "PATHEXT",
        "CUDA_PATH",
        "CUDA_VISIBLE_DEVICES",
        "GGML_VK_VISIBLE_DEVICES",
        "GGML_SYCL_DEVICE",
        "ZES_ENABLE_SYSMAN",
    }
    environment = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    if api_key:
        environment["LLAMA_API_KEY"] = api_key
    if api_prefix:
        environment["LLAMA_ARG_API_PREFIX"] = api_prefix
    return environment


class LocalModelManager:
    """Facade used by runtime RPC. External vLLM is discovery-only."""

    def __init__(self, discovery: RuntimeDiscovery | None = None):
        self.discovery = discovery or RuntimeDiscovery()
        self._measurements: dict[tuple[str, str], PerformanceMeasurement] = {}

    async def discover(self, vllm_endpoints: tuple[str, ...] = ()) -> tuple[RuntimeEndpoint, ...]:
        return await self.discovery.discover_defaults(vllm_endpoints=vllm_endpoints)

    async def attach_vllm(self, base_url: str) -> RuntimeEndpoint:
        # Explicit remote opt-in occurs in the UI before this boundary.
        return await self.discovery.probe(RuntimeKind.VLLM, base_url, allow_remote=True)

    def record_performance(
        self,
        runtime_id: str,
        model_id: str,
        *,
        prompt_tokens: int,
        generated_tokens: int,
        prompt_seconds: float,
        generation_seconds: float,
        context_size: int,
    ) -> PerformanceMeasurement:
        if (
            min(prompt_tokens, generated_tokens, context_size) < 0
            or min(prompt_seconds, generation_seconds) <= 0
        ):
            raise ValueError("token counts must be non-negative and durations positive")
        measurement = PerformanceMeasurement(
            runtime_id,
            model_id,
            prompt_tokens,
            generated_tokens,
            prompt_tokens / prompt_seconds,
            generated_tokens / generation_seconds,
            context_size,
            datetime.now(UTC).isoformat(),
        )
        self._measurements[(runtime_id, model_id)] = measurement
        return measurement

    def performance(self, runtime_id: str, model_id: str) -> PerformanceMeasurement | None:
        return self._measurements.get((runtime_id, model_id))
