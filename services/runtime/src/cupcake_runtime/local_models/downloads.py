"""Resumable, checksummed GGUF download state machine."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import threading
import time
from collections.abc import Callable, Coroutine, Mapping, Sequence
from dataclasses import asdict, replace
from pathlib import Path
from types import TracebackType
from typing import Any, Protocol, Self, cast
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from pydantic import TypeAdapter

from .types import (
    DownloadSnapshot,
    DownloadState,
    ModelArtifact,
    RuntimeCompanionArtifact,
    RuntimePackArtifact,
)

_DOWNLOAD_SNAPSHOT_ADAPTER = TypeAdapter(DownloadSnapshot)
_ATOMIC_REPLACE_RETRY_DELAYS = (0.01, 0.025, 0.05, 0.1, 0.2, 0.25, 0.25)
_DEFAULT_IO_TIMEOUT_SECONDS = 1.0
_DEFAULT_CHUNK_SIZE = 64 * 1024
# Keep one-second control polling without treating a brief CDN/Wi-Fi stall as a
# failed multi-gigabyte transfer. Pause/cancel is checked after every timeout.
_MAX_CONSECUTIVE_IO_TIMEOUTS = 30
_PROGRESS_PERSIST_BYTES = 4 * 1024 * 1024
_PROGRESS_PERSIST_SECONDS = 0.25


class DownloadCancelled(Exception):
    pass


class DownloadPaused(Exception):
    pass


class DownloadIntegrityError(ValueError):
    """The received bytes do not match immutable signed catalog metadata."""

    pass


class DownloadableArtifact(Protocol):
    @property
    def id(self) -> str: ...

    @property
    def size_bytes(self) -> int: ...

    @property
    def sha256(self) -> str: ...

    @property
    def urls(self) -> Sequence[str]: ...


class DownloadResponse(Protocol):
    @property
    def headers(self) -> Mapping[str, str]: ...

    @property
    def status(self) -> int | None: ...

    def __enter__(self) -> Self: ...

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None: ...

    def geturl(self) -> str: ...

    def read(self, amount: int = -1) -> bytes: ...


class DownloadOpener(Protocol):
    def __call__(self, request: Request, *, timeout: float) -> DownloadResponse: ...


ALLOWED_TRANSITIONS: dict[DownloadState, frozenset[DownloadState]] = {
    DownloadState.QUEUED: frozenset(
        {DownloadState.RESOLVING, DownloadState.PAUSED, DownloadState.CANCELLED}
    ),
    DownloadState.RESOLVING: frozenset(
        {
            DownloadState.DOWNLOADING,
            DownloadState.PAUSED,
            DownloadState.VERIFYING,
            DownloadState.FAILED,
            DownloadState.CANCELLED,
        }
    ),
    DownloadState.DOWNLOADING: frozenset(
        {
            DownloadState.DOWNLOADING,
            DownloadState.PAUSED,
            DownloadState.VERIFYING,
            DownloadState.FAILED,
            DownloadState.CANCELLED,
        }
    ),
    DownloadState.PAUSED: frozenset({DownloadState.RESOLVING, DownloadState.CANCELLED}),
    DownloadState.VERIFYING: frozenset(
        {
            DownloadState.COMPLETED,
            DownloadState.PAUSED,
            DownloadState.FAILED,
            DownloadState.CANCELLED,
        }
    ),
    DownloadState.FAILED: frozenset({DownloadState.RESOLVING, DownloadState.CANCELLED}),
    DownloadState.COMPLETED: frozenset(),
    DownloadState.CANCELLED: frozenset({DownloadState.RESOLVING}),
}


class CheckedDownload:
    """Crash-recoverable byte download with signed size and digest validation."""

    def __init__(
        self,
        artifact: DownloadableArtifact,
        destination: Path,
        *,
        opener: DownloadOpener | None = None,
        io_timeout_seconds: float = _DEFAULT_IO_TIMEOUT_SECONDS,
        chunk_size: int = _DEFAULT_CHUNK_SIZE,
    ):
        if io_timeout_seconds <= 0:
            raise ValueError("download I/O timeout must be positive")
        if chunk_size <= 0:
            raise ValueError("download chunk size must be positive")
        self.artifact = artifact
        self.destination = destination
        self.partial = destination.with_suffix(destination.suffix + ".part")
        self.state_file = destination.with_suffix(destination.suffix + ".download.json")
        self._opener = opener or cast(DownloadOpener, urlopen)
        self._io_timeout_seconds = io_timeout_seconds
        self._chunk_size = chunk_size
        self._pause = threading.Event()
        self._cancel = threading.Event()
        self._run_lock = threading.Lock()
        self._state_lock = threading.RLock()
        self._running = False
        self._control_generation = 0
        self._listeners: list[Callable[[DownloadSnapshot], None]] = []
        initial = DownloadSnapshot(
            artifact.id, DownloadState.QUEUED, str(destination), bytes_total=artifact.size_bytes
        )
        self.snapshot = self._recover(initial)

    def subscribe(self, listener: Callable[[DownloadSnapshot], None]) -> None:
        self._listeners.append(listener)

    def _transition(self, state: DownloadState, **changes: object) -> None:
        with self._state_lock:
            if state not in ALLOWED_TRANSITIONS[self.snapshot.state]:
                raise RuntimeError(
                    f"invalid download transition {self.snapshot.state.value} -> {state.value}"
                )
            values = asdict(self.snapshot)
            values.update(changes)
            values["state"] = state
            self.snapshot = DownloadSnapshot(**values)
            self._persist()
            snapshot = self.snapshot
        self._notify(snapshot)

    def _notify(self, snapshot: DownloadSnapshot) -> None:
        for listener in tuple(self._listeners):
            try:
                listener(snapshot)
            except Exception:
                continue

    def _persist(self) -> None:
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_file.with_suffix(self.state_file.suffix + ".tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(
                {**asdict(self.snapshot), "state": self.snapshot.state.value}, handle, indent=2
            )
            handle.flush()
            os.fsync(handle.fileno())
        for delay in (*_ATOMIC_REPLACE_RETRY_DELAYS, None):
            try:
                os.replace(temporary, self.state_file)
                break
            except PermissionError:
                # Windows readers and security scanners can briefly open the
                # destination without FILE_SHARE_DELETE. Preserve atomic state
                # promotion while tolerating that transient sharing violation.
                if delay is None:
                    raise
                time.sleep(delay)

    def pause(self) -> None:
        with self._state_lock:
            self._control_generation += 1
            self._pause.set()
            if not self._running and self.snapshot.state == DownloadState.QUEUED:
                self._transition(DownloadState.PAUSED)

    def cancel(self) -> None:
        with self._state_lock:
            self._control_generation += 1
            self._cancel.set()
            if not self._running and self.snapshot.state in {
                DownloadState.QUEUED,
                DownloadState.PAUSED,
                DownloadState.FAILED,
            }:
                self.partial.unlink(missing_ok=True)
                self._transition(DownloadState.CANCELLED, bytes_downloaded=0)

    def run(self) -> Coroutine[Any, Any, DownloadSnapshot]:
        # Claim intent synchronously. A control that lands after the caller has
        # obtained this coroutine invalidates that older start before _run can
        # clear events or open a transport.
        with self._state_lock:
            start_generation = self._control_generation
        return self._run(start_generation)

    async def _run(self, start_generation: int) -> DownloadSnapshot:
        if not self._run_lock.acquire(blocking=False):
            raise RuntimeError(f"download already running: {self.artifact.id}")
        try:
            with self._state_lock:
                if start_generation != self._control_generation:
                    return self.snapshot
                if self.snapshot.state not in {
                    DownloadState.QUEUED,
                    DownloadState.PAUSED,
                    DownloadState.FAILED,
                    DownloadState.CANCELLED,
                }:
                    raise RuntimeError(f"cannot run download in {self.snapshot.state.value}")
                self._running = True
                self._pause.clear()
                self._cancel.clear()
                self._transition(
                    DownloadState.RESOLVING,
                    attempt=self.snapshot.attempt + 1,
                    bytes_downloaded=(
                        0
                        if self.snapshot.state == DownloadState.CANCELLED
                        else self.snapshot.bytes_downloaded
                    ),
                    error_code=None,
                    error_detail=None,
                )
            await self._run_owned()
        finally:
            with self._state_lock:
                self._running = False
                if self._cancel.is_set() and self.snapshot.state in {
                    DownloadState.RESOLVING,
                    DownloadState.DOWNLOADING,
                    DownloadState.PAUSED,
                    DownloadState.VERIFYING,
                    DownloadState.FAILED,
                }:
                    self.partial.unlink(missing_ok=True)
                    self._transition(DownloadState.CANCELLED, bytes_downloaded=0)
            self._run_lock.release()
        return self.snapshot

    async def _run_owned(self) -> None:
        try:
            self._raise_if_controlled()
            await self._transfer_and_verify()
        except DownloadPaused:
            self._transition(DownloadState.PAUSED)
        except DownloadCancelled:
            self.partial.unlink(missing_ok=True)
            self._transition(DownloadState.CANCELLED, bytes_downloaded=0)

    async def _transfer_and_verify(self) -> None:
        self.destination.parent.mkdir(parents=True, exist_ok=True)
        existing = self.partial.stat().st_size if self.partial.exists() else 0
        if existing > self.artifact.size_bytes:
            self.partial.unlink(missing_ok=True)
            existing = 0
        free = shutil.disk_usage(self.destination.parent).free
        required = max(0, self.artifact.size_bytes - existing)
        if free < required:
            self._transition(
                DownloadState.FAILED,
                error_code="insufficient_disk",
                error_detail=f"requires {required} bytes but only {free} are free",
            )
            return
        errors: list[str] = []
        for index, url in enumerate(self.artifact.urls):
            try:
                self._raise_if_controlled()
                existing = self.partial.stat().st_size if self.partial.exists() else 0
                if existing < self.artifact.size_bytes:
                    await asyncio.to_thread(self._download_one, url)
                self._raise_if_controlled()
                self._transition(DownloadState.VERIFYING)
                await asyncio.to_thread(self._verify, self.partial)
                with self._state_lock:
                    self._raise_if_controlled()
                    os.replace(self.partial, self.destination)
                    self._transition(
                        DownloadState.COMPLETED, bytes_downloaded=self.artifact.size_bytes
                    )
                return
            except (DownloadPaused, DownloadCancelled):
                raise
            except Exception as exc:
                origin = urlsplit(url)
                safe_source = f"{origin.scheme}://{origin.hostname or 'local'}"
                errors.append(f"{safe_source}: {exc}")
                if self.snapshot.state == DownloadState.VERIFYING:
                    self.partial.unlink(missing_ok=True)
                    if index + 1 < len(self.artifact.urls):
                        self._transition(
                            DownloadState.FAILED,
                            error_code="integrity_failed",
                            error_detail=str(exc),
                        )
                        self._transition(
                            DownloadState.RESOLVING,
                            attempt=self.snapshot.attempt + 1,
                            error_code=None,
                            error_detail=None,
                        )
                        continue
                    self._transition(
                        DownloadState.FAILED,
                        error_code="integrity_failed",
                        error_detail=str(exc),
                    )
                    break
        if self.snapshot.state != DownloadState.FAILED:
            self._transition(
                DownloadState.FAILED, error_code="download_failed", error_detail="; ".join(errors)
            )

    def _download_one(self, url: str) -> None:
        self.destination.parent.mkdir(parents=True, exist_ok=True)
        requested_scheme = urlsplit(url).scheme.lower()
        if requested_scheme not in {"https", "file"}:
            raise ValueError("model downloads require HTTPS")
        consecutive_timeouts = 0
        while True:
            self._raise_if_controlled()
            offset = self.partial.stat().st_size if self.partial.exists() else 0
            headers = {"Range": f"bytes={offset}-"} if offset else {}
            request = Request(url, headers=headers)
            try:
                with self._opener(request, timeout=self._io_timeout_seconds) as response:
                    self._raise_if_controlled()
                    final_scheme = urlsplit(response.geturl()).scheme.lower()
                    if requested_scheme == "https" and final_scheme != "https":
                        raise ValueError("download redirect downgraded HTTPS")
                    status = response.status
                    if offset and status != 206:
                        offset = 0
                        mode = "wb"
                    else:
                        mode = "ab" if offset else "wb"
                    content_range = response.headers.get("Content-Range")
                    if (
                        offset
                        and status == 206
                        and not str(content_range).startswith(f"bytes {offset}-")
                    ):
                        raise ValueError("server returned an invalid byte range")
                    content_length = response.headers.get("Content-Length")
                    total = (
                        offset + int(content_length) if content_length else self.artifact.size_bytes
                    )
                    if total > self.artifact.size_bytes:
                        raise ValueError("server response exceeds signed artifact size")
                    self._transition(
                        DownloadState.DOWNLOADING,
                        source_url=url,
                        bytes_downloaded=offset,
                        bytes_total=total,
                    )
                    with self.partial.open(mode) as output:
                        downloaded = offset
                        persisted_downloaded = offset
                        persisted_at = time.monotonic()
                        while True:
                            self._raise_if_controlled()
                            try:
                                chunk = response.read(self._chunk_size)
                            except TimeoutError:
                                self._raise_if_controlled()
                                consecutive_timeouts += 1
                                if consecutive_timeouts >= _MAX_CONSECUTIVE_IO_TIMEOUTS:
                                    raise
                                break
                            self._raise_if_controlled()
                            if not chunk:
                                return
                            consecutive_timeouts = 0
                            output.write(chunk)
                            downloaded += len(chunk)
                            if downloaded > self.artifact.size_bytes:
                                raise ValueError("download exceeds signed artifact size")
                            now = time.monotonic()
                            publish_progress = (
                                downloaded - persisted_downloaded >= _PROGRESS_PERSIST_BYTES
                                or now - persisted_at >= _PROGRESS_PERSIST_SECONDS
                            )
                            with self._state_lock:
                                self.snapshot = replace(self.snapshot, bytes_downloaded=downloaded)
                                if publish_progress:
                                    self._persist()
                                snapshot = self.snapshot
                            if publish_progress:
                                persisted_downloaded = downloaded
                                persisted_at = now
                                self._notify(snapshot)
            except TimeoutError:
                self._raise_if_controlled()
                consecutive_timeouts += 1
                if consecutive_timeouts >= _MAX_CONSECUTIVE_IO_TIMEOUTS:
                    raise
            except URLError as exc:
                self._raise_if_controlled()
                if not isinstance(exc.reason, TimeoutError):
                    raise
                consecutive_timeouts += 1
                if consecutive_timeouts >= _MAX_CONSECUTIVE_IO_TIMEOUTS:
                    raise
            except Exception:
                # Closing a response after a transport failure can surface as
                # OSError. A concurrent user control still owns the resulting state.
                self._raise_if_controlled()
                raise

    def _verify(self, path: Path) -> None:
        if not path.is_file() or path.stat().st_size != self.artifact.size_bytes:
            raise DownloadIntegrityError(f"size mismatch for {self.artifact.id}")
        digest = hashlib.sha256()
        with path.open("rb", buffering=0) as handle:
            while True:
                self._raise_if_controlled()
                chunk = handle.read(self._chunk_size)
                self._raise_if_controlled()
                if not chunk:
                    break
                digest.update(chunk)
        if digest.hexdigest().lower() != self.artifact.sha256.lower():
            raise DownloadIntegrityError(f"checksum mismatch for {self.artifact.id}")

    def _raise_if_controlled(self) -> None:
        if self._cancel.is_set():
            raise DownloadCancelled
        if self._pause.is_set():
            raise DownloadPaused

    def _recover(self, fallback: DownloadSnapshot) -> DownloadSnapshot:
        try:
            snapshot = _DOWNLOAD_SNAPSHOT_ADAPTER.validate_json(
                self.state_file.read_text(encoding="utf-8")
            )
            if snapshot.model_id != self.artifact.id or snapshot.destination != str(
                self.destination
            ):
                return fallback
            if snapshot.state == DownloadState.COMPLETED:
                # Recovery is presentation state, not an execution trust boundary. A
                # completed model or acceleration pack can be several gigabytes; hashing
                # every retained download while the product runtime starts made ordinary
                # launches scale with the user's local-model library. Keep cheap structural
                # checks here. Model registration, runtime-pack installation and every
                # model/runtime activation still perform the full signed digest check before
                # the bytes can be trusted or executed.
                if (
                    snapshot.bytes_downloaded != self.artifact.size_bytes
                    or snapshot.bytes_total != self.artifact.size_bytes
                    or not self.destination.is_file()
                    or self.destination.stat().st_size != self.artifact.size_bytes
                ):
                    return fallback
                return snapshot
            if snapshot.state == DownloadState.CANCELLED:
                return snapshot
            if self.partial.is_file():
                return replace(
                    snapshot,
                    state=DownloadState.PAUSED,
                    bytes_downloaded=min(self.partial.stat().st_size, self.artifact.size_bytes),
                    error_code=None,
                    error_detail=None,
                )
        except (OSError, TypeError, ValueError, KeyError, json.JSONDecodeError):
            pass
        return fallback


class ModelDownload(CheckedDownload):
    def __init__(
        self,
        artifact: ModelArtifact,
        destination: Path,
        *,
        opener: DownloadOpener | None = None,
        io_timeout_seconds: float = _DEFAULT_IO_TIMEOUT_SECONDS,
        chunk_size: int = _DEFAULT_CHUNK_SIZE,
    ):
        super().__init__(
            artifact,
            destination,
            opener=opener,
            io_timeout_seconds=io_timeout_seconds,
            chunk_size=chunk_size,
        )


class RuntimePackDownload(CheckedDownload):
    def __init__(
        self,
        artifact: RuntimePackArtifact | RuntimeCompanionArtifact,
        destination: Path,
        *,
        opener: DownloadOpener | None = None,
        io_timeout_seconds: float = _DEFAULT_IO_TIMEOUT_SECONDS,
        chunk_size: int = _DEFAULT_CHUNK_SIZE,
    ):
        super().__init__(
            artifact,
            destination,
            opener=opener,
            io_timeout_seconds=io_timeout_seconds,
            chunk_size=chunk_size,
        )


class DownloadManager:
    def __init__(self):
        self._downloads: dict[str, ModelDownload] = {}

    def create(self, artifact: ModelArtifact, destination: Path) -> ModelDownload:
        current = self._downloads.get(artifact.id)
        if current and current.snapshot.state not in {
            DownloadState.COMPLETED,
            DownloadState.CANCELLED,
            DownloadState.FAILED,
        }:
            raise ValueError(f"download already active: {artifact.id}")
        download = ModelDownload(artifact, destination)
        self._downloads[artifact.id] = download
        return download

    def get(self, model_id: str) -> ModelDownload:
        return self._downloads[model_id]

    def snapshots(self) -> tuple[DownloadSnapshot, ...]:
        return tuple(download.snapshot for download in self._downloads.values())
