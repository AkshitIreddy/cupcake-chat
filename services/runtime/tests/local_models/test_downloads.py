import asyncio
import hashlib
import threading
import zipfile
from pathlib import Path
from types import TracebackType
from urllib.error import URLError
from urllib.request import Request

import pytest
from pytest import MonkeyPatch

import cupcake_runtime.local_models.downloads as downloads_module
from cupcake_runtime.local_models.downloads import ModelDownload, RuntimePackDownload
from cupcake_runtime.local_models.model_store import InstalledModelStore
from cupcake_runtime.local_models.runtime_packs import RuntimePackIntegrityError, RuntimePackStore
from cupcake_runtime.local_models.types import (
    DownloadState,
    ModelArtifact,
    RuntimeBackend,
    RuntimePackArtifact,
)


def _tiny_artifact(source: Path, data: bytes = b"valid model bytes") -> ModelArtifact:
    source.write_bytes(data)
    return ModelArtifact(
        "tiny",
        "Tiny",
        "tiny",
        1,
        "Q4_K_M",
        len(data),
        hashlib.sha256(data).hexdigest(),
        (source.as_uri(),),
        "installed.gguf",
        "Apache-2.0",
        "https://example.invalid/license",
        4096,
    )


def _remote_artifact(data: bytes) -> ModelArtifact:
    return ModelArtifact(
        "tiny-remote",
        "Tiny remote",
        "tiny",
        1,
        "Q4_K_M",
        len(data),
        hashlib.sha256(data).hexdigest(),
        ("https://models.example.invalid/tiny.gguf",),
        "tiny.gguf",
        "Apache-2.0",
        "https://example.invalid/license",
        4096,
    )


class _ControlledResponse:
    def __init__(
        self,
        transport: "_ControlledTransport",
        *,
        offset: int,
        timeout: float,
    ) -> None:
        self.transport = transport
        self.offset = offset
        self.timeout = timeout
        self.status = 206 if offset else 200
        remaining = len(transport.data) - offset
        self.headers = {
            "Content-Length": str(remaining),
            "Content-Range": f"bytes {offset}-{len(transport.data) - 1}/{len(transport.data)}",
        }

    def __enter__(self) -> "_ControlledResponse":
        with self.transport.lock:
            self.transport.active_responses += 1
            self.transport.max_active_responses = max(
                self.transport.max_active_responses, self.transport.active_responses
            )
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        with self.transport.lock:
            self.transport.active_responses -= 1

    def geturl(self) -> str:
        return "https://models.example.invalid/tiny.gguf"

    def read(self, amount: int = -1) -> bytes:
        self.transport.read_calls += 1
        self.transport.read_started.set()
        if self.transport.stall_after is not None and self.offset >= self.transport.stall_after:
            self.transport.read_stalled.set()
            if not self.transport.read_gate.wait(self.timeout):
                raise TimeoutError("controlled stalled read")
        if self.offset >= len(self.transport.data):
            return b""
        size = min(
            self.transport.chunk_size,
            len(self.transport.data) - self.offset,
            amount if amount >= 0 else len(self.transport.data),
        )
        chunk = self.transport.data[self.offset : self.offset + size]
        self.offset += len(chunk)
        return chunk


class _ControlledTransport:
    def __init__(
        self,
        data: bytes,
        *,
        chunk_size: int = 4,
        stall_after: int | None = None,
        stall_resolving: bool = False,
    ) -> None:
        self.data = data
        self.chunk_size = chunk_size
        self.stall_after = stall_after
        self.stall_resolving = stall_resolving
        self.resolve_started = threading.Event()
        self.resolve_gate = threading.Event()
        self.read_started = threading.Event()
        self.read_stalled = threading.Event()
        self.read_gate = threading.Event()
        self.lock = threading.Lock()
        self.active_responses = 0
        self.max_active_responses = 0
        self.open_calls = 0
        self.read_calls = 0

    def open(self, request: Request, *, timeout: float) -> _ControlledResponse:
        self.open_calls += 1
        self.resolve_started.set()
        if self.stall_resolving and not self.resolve_gate.wait(timeout):
            raise TimeoutError("controlled stalled resolve")
        range_header = request.get_header("Range")
        offset = int(range_header.removeprefix("bytes=").removesuffix("-")) if range_header else 0
        return _ControlledResponse(self, offset=offset, timeout=timeout)


async def _wait_for_signal(signal: threading.Event) -> None:
    assert await asyncio.wait_for(asyncio.to_thread(signal.wait, 1), timeout=1.5)


def test_progress_persistence_is_bounded_below_control_polling_rate(tmp_path: Path) -> None:
    data = b"x" * 64
    artifact = _remote_artifact(data)
    transport = _ControlledTransport(data, chunk_size=1)

    class PersistCountingDownload(ModelDownload):
        persist_calls = 0

        def _persist(self) -> None:
            self.persist_calls += 1
            super()._persist()

    download = PersistCountingDownload(
        artifact,
        tmp_path / artifact.filename,
        opener=transport.open,
        io_timeout_seconds=0.02,
        chunk_size=1,
    )

    assert asyncio.run(download.run()).state == DownloadState.COMPLETED
    assert transport.read_calls == len(data) + 1
    assert download.persist_calls <= 6
    assert download.persist_calls < transport.read_calls


def test_wrapped_transport_timeout_retries_but_other_url_errors_fail(tmp_path: Path) -> None:
    data = b"tiny model"
    artifact = _remote_artifact(data)
    transport = _ControlledTransport(data)
    wrapped_timeouts = 2

    def timeout_then_open(request: Request, *, timeout: float) -> _ControlledResponse:
        nonlocal wrapped_timeouts
        if wrapped_timeouts:
            wrapped_timeouts -= 1
            raise URLError(TimeoutError("controlled wrapped timeout"))
        return transport.open(request, timeout=timeout)

    recovered = ModelDownload(
        artifact,
        tmp_path / "recovered.gguf",
        opener=timeout_then_open,
        io_timeout_seconds=0.02,
        chunk_size=4,
    )
    assert asyncio.run(recovered.run()).state == DownloadState.COMPLETED
    assert wrapped_timeouts == 0

    failed_opens = 0

    def fail_without_timeout(request: Request, *, timeout: float) -> _ControlledResponse:
        nonlocal failed_opens
        failed_opens += 1
        raise URLError("controlled TLS failure")

    failed = ModelDownload(
        artifact,
        tmp_path / "failed.gguf",
        opener=fail_without_timeout,
        io_timeout_seconds=0.02,
        chunk_size=4,
    )
    result = asyncio.run(failed.run())
    assert result.state == DownloadState.FAILED
    assert failed_opens == 1


def test_file_download_completes_and_verifies(tmp_path: Path) -> None:
    source = tmp_path / "source.gguf"
    artifact = _tiny_artifact(source)
    data = source.read_bytes()
    download = ModelDownload(artifact, tmp_path / "models" / artifact.filename)
    result = asyncio.run(download.run())
    assert result.state == DownloadState.COMPLETED
    assert (tmp_path / "models" / artifact.filename).read_bytes() == data


def test_state_persist_retries_transient_windows_replace_denial(
    tmp_path: Path, monkeypatch: MonkeyPatch
) -> None:
    artifact = _tiny_artifact(tmp_path / "source.gguf")
    download = ModelDownload(artifact, tmp_path / "models" / artifact.filename)
    real_replace = downloads_module.os.replace
    attempts = 0

    def transient_replace(source: Path, destination: Path) -> None:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise PermissionError(5, "simulated Windows sharing violation", str(destination))
        real_replace(source, destination)

    def no_sleep(_delay: float) -> None:
        pass

    monkeypatch.setattr(downloads_module.os, "replace", transient_replace)
    monkeypatch.setattr(downloads_module.time, "sleep", no_sleep)

    download.cancel()

    assert attempts == 3
    assert download.state_file.is_file()
    assert download.snapshot.state == DownloadState.CANCELLED


def test_cancel_before_start_is_terminal(tmp_path: Path) -> None:
    artifact = ModelArtifact(
        "tiny",
        "Tiny",
        "tiny",
        1,
        "Q4_K_M",
        1,
        "0" * 64,
        ("https://example.invalid/model.gguf",),
        "model.gguf",
        "Apache-2.0",
        "https://example.invalid/license",
        4096,
    )
    download = ModelDownload(artifact, tmp_path / "model.gguf")
    download.cancel()
    assert download.snapshot.state == DownloadState.CANCELLED


@pytest.mark.parametrize(
    ("control", "expected_state"),
    (("pause", DownloadState.PAUSED), ("cancel", DownloadState.CANCELLED)),
)
def test_control_invalidates_a_claimed_start_before_worker_scheduling(
    tmp_path: Path, control: str, expected_state: DownloadState
) -> None:
    data = b"tiny model"
    artifact = _remote_artifact(data)
    transport = _ControlledTransport(data)
    download = ModelDownload(
        artifact,
        tmp_path / artifact.filename,
        opener=transport.open,
        io_timeout_seconds=0.02,
        chunk_size=4,
    )

    claimed_start = download.run()
    getattr(download, control)()
    interrupted = asyncio.run(claimed_start)

    assert interrupted.state == expected_state
    assert not transport.resolve_started.is_set()
    assert asyncio.run(download.run()).state == DownloadState.COMPLETED
    assert download.destination.read_bytes() == data


def test_pause_interrupts_stalled_read_and_resume_keeps_one_writer(tmp_path: Path) -> None:
    data = b"abcdefghijkl"
    artifact = _remote_artifact(data)
    transport = _ControlledTransport(data, stall_after=4)
    download = ModelDownload(
        artifact,
        tmp_path / artifact.filename,
        opener=transport.open,
        io_timeout_seconds=0.02,
        chunk_size=4,
    )

    async def exercise() -> None:
        task = asyncio.create_task(download.run())
        await _wait_for_signal(transport.read_stalled)
        download.pause()
        with pytest.raises(RuntimeError, match="already running"):
            await download.run()
        paused = await asyncio.wait_for(task, timeout=0.5)
        assert paused.state == DownloadState.PAUSED
        assert paused.bytes_downloaded == 4
        assert download.partial.read_bytes() == data[:4]
        retained_size = download.partial.stat().st_size
        await asyncio.sleep(0.05)
        assert download.partial.stat().st_size == retained_size

        transport.stall_after = None
        completed = await asyncio.wait_for(download.run(), timeout=0.5)
        assert completed.state == DownloadState.COMPLETED

    asyncio.run(exercise())

    assert download.destination.read_bytes() == data
    assert transport.max_active_responses == 1


def test_cancel_interrupts_stalled_read_and_allows_fresh_retry(tmp_path: Path) -> None:
    data = b"abcdefghijkl"
    artifact = _remote_artifact(data)
    transport = _ControlledTransport(data, stall_after=4)
    download = ModelDownload(
        artifact,
        tmp_path / artifact.filename,
        opener=transport.open,
        io_timeout_seconds=0.02,
        chunk_size=4,
    )

    async def exercise() -> None:
        task = asyncio.create_task(download.run())
        await _wait_for_signal(transport.read_stalled)
        download.cancel()
        cancelled = await asyncio.wait_for(task, timeout=0.5)
        assert cancelled.state == DownloadState.CANCELLED
        assert cancelled.bytes_downloaded == 0
        assert not download.partial.exists()

        transport.stall_after = None
        completed = await asyncio.wait_for(download.run(), timeout=0.5)
        assert completed.state == DownloadState.COMPLETED

    asyncio.run(exercise())

    assert download.destination.read_bytes() == data
    assert transport.max_active_responses == 1


def test_cancel_from_paused_removes_retained_partial(tmp_path: Path) -> None:
    data = b"abcdefghijkl"
    artifact = _remote_artifact(data)
    transport = _ControlledTransport(data, stall_after=4)
    download = ModelDownload(
        artifact,
        tmp_path / artifact.filename,
        opener=transport.open,
        io_timeout_seconds=0.02,
        chunk_size=4,
    )

    async def pause() -> None:
        task = asyncio.create_task(download.run())
        await _wait_for_signal(transport.read_stalled)
        download.pause()
        assert (await asyncio.wait_for(task, timeout=0.5)).state == DownloadState.PAUSED

    asyncio.run(pause())
    assert download.partial.read_bytes() == data[:4]

    download.cancel()

    assert download.snapshot.state == DownloadState.CANCELLED
    assert download.snapshot.bytes_downloaded == 0
    assert not download.partial.exists()


@pytest.mark.parametrize(
    ("control", "expected_state"),
    (("pause", DownloadState.PAUSED), ("cancel", DownloadState.CANCELLED)),
)
def test_controls_interrupt_stalled_resolution_and_retry(
    tmp_path: Path, control: str, expected_state: DownloadState
) -> None:
    data = b"tiny model"
    artifact = _remote_artifact(data)
    transport = _ControlledTransport(data, stall_resolving=True)
    download = ModelDownload(
        artifact,
        tmp_path / artifact.filename,
        opener=transport.open,
        io_timeout_seconds=0.02,
        chunk_size=4,
    )

    async def exercise() -> None:
        task = asyncio.create_task(download.run())
        await _wait_for_signal(transport.resolve_started)
        getattr(download, control)()
        interrupted = await asyncio.wait_for(task, timeout=0.5)
        assert interrupted.state == expected_state
        assert not download.partial.exists()

        transport.stall_resolving = False
        completed = await asyncio.wait_for(download.run(), timeout=0.5)
        assert completed.state == DownloadState.COMPLETED

    asyncio.run(exercise())
    assert download.destination.read_bytes() == data


@pytest.mark.parametrize(
    ("control", "expected_state", "keeps_partial"),
    (
        ("pause", DownloadState.PAUSED, True),
        ("cancel", DownloadState.CANCELLED, False),
    ),
)
def test_controls_are_honored_during_verification(
    tmp_path: Path,
    control: str,
    expected_state: DownloadState,
    keeps_partial: bool,
) -> None:
    data = b"verification bytes"
    artifact = _remote_artifact(data)
    transport = _ControlledTransport(data)
    verification_checks = 0

    class VerificationControlledDownload(ModelDownload):
        def _raise_if_controlled(self) -> None:
            nonlocal verification_checks
            if self.snapshot.state == DownloadState.VERIFYING:
                verification_checks += 1
                if verification_checks == 2:
                    getattr(self, control)()
            super()._raise_if_controlled()

    download = VerificationControlledDownload(
        artifact,
        tmp_path / artifact.filename,
        opener=transport.open,
        io_timeout_seconds=0.02,
        chunk_size=4,
    )
    interrupted = asyncio.run(download.run())

    assert interrupted.state == expected_state
    assert download.partial.exists() is keeps_partial
    assert not download.destination.exists()
    assert asyncio.run(download.run()).state == DownloadState.COMPLETED
    assert download.destination.read_bytes() == data


def test_final_checksum_failure_has_explicit_integrity_state(tmp_path: Path) -> None:
    source = tmp_path / "corrupt.gguf"
    source.write_bytes(b"wrong")
    artifact = ModelArtifact(
        "tiny",
        "Tiny",
        "tiny",
        1,
        "Q4_K_M",
        5,
        hashlib.sha256(b"right").hexdigest(),
        (source.as_uri(),),
        "installed.gguf",
        "Apache-2.0",
        "https://example.invalid/license",
        4096,
    )

    result = asyncio.run(ModelDownload(artifact, tmp_path / "models" / artifact.filename).run())

    assert result.state == DownloadState.FAILED
    assert result.error_code == "integrity_failed"
    assert "checksum mismatch" in (result.error_detail or "")
    assert not (tmp_path / "models" / "installed.gguf.part").exists()


def test_completed_download_recovery_defers_digest_until_a_trust_boundary(
    tmp_path: Path, monkeypatch: MonkeyPatch
) -> None:
    source = tmp_path / "source.gguf"
    artifact = _tiny_artifact(source)
    destination = tmp_path / "models" / artifact.filename
    first = ModelDownload(artifact, destination)
    assert asyncio.run(first.run()).state == DownloadState.COMPLETED

    def unexpected_startup_digest(_download: ModelDownload, _path: Path) -> None:
        raise AssertionError("completed downloads must not be rehashed during startup recovery")

    monkeypatch.setattr(downloads_module.CheckedDownload, "_verify", unexpected_startup_digest)
    recovered = ModelDownload(artifact, destination)

    assert recovered.snapshot.state == DownloadState.COMPLETED


def test_completed_download_recovery_rejects_missing_or_wrong_sized_destination(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.gguf"
    artifact = _tiny_artifact(source)
    destination = tmp_path / "models" / artifact.filename
    first = ModelDownload(artifact, destination)
    assert asyncio.run(first.run()).state == DownloadState.COMPLETED

    destination.write_bytes(b"wrong size")

    assert ModelDownload(artifact, destination).snapshot.state == DownloadState.QUEUED


def test_recovered_completed_model_rejects_same_size_tampering_at_registration(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.gguf"
    artifact = _tiny_artifact(source)
    store = InstalledModelStore(tmp_path / "models")
    destination = artifact.target(store.root)
    first = ModelDownload(artifact, destination)
    assert asyncio.run(first.run()).state == DownloadState.COMPLETED

    destination.write_bytes(b"x" * artifact.size_bytes)
    assert ModelDownload(artifact, destination).snapshot.state == DownloadState.COMPLETED

    with pytest.raises(ValueError, match="checksum mismatch"):
        store.register(artifact, destination)


def test_recovered_completed_runtime_rejects_same_size_tampering_at_install(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.zip"
    executable = b"verified llama server"
    with zipfile.ZipFile(source, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("llama-server.exe", executable)
    source_bytes = source.read_bytes()
    artifact = RuntimePackArtifact(
        id="llama:test:windows-x64-cpu",
        version="test",
        backend=RuntimeBackend.CPU,
        platform="windows",
        architecture="x64",
        size_bytes=len(source_bytes),
        sha256=hashlib.sha256(source_bytes).hexdigest(),
        urls=(source.as_uri(),),
        filename="runtime.zip",
        executable="llama-server.exe",
        files={"llama-server.exe": hashlib.sha256(executable).hexdigest()},
        source_revision="test-revision",
    )
    destination = tmp_path / "downloads" / artifact.filename
    first = RuntimePackDownload(artifact, destination)
    assert asyncio.run(first.run()).state == DownloadState.COMPLETED

    tampered = bytearray(destination.read_bytes())
    tampered[-1] ^= 1
    destination.write_bytes(tampered)
    assert RuntimePackDownload(artifact, destination).snapshot.state == DownloadState.COMPLETED

    with pytest.raises(RuntimePackIntegrityError, match="archive checksum does not match"):
        RuntimePackStore(tmp_path / "runtime").install(artifact, destination)
