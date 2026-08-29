"""Resumable, checksummed GGUF download state machine."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import threading
from collections.abc import Callable, Sequence
from dataclasses import asdict, replace
from pathlib import Path
from typing import Protocol, cast
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from pydantic import TypeAdapter

from .catalog import sha256_file
from .types import (
    DownloadSnapshot,
    DownloadState,
    ModelArtifact,
    RuntimeCompanionArtifact,
    RuntimePackArtifact,
)

_DOWNLOAD_SNAPSHOT_ADAPTER = TypeAdapter(DownloadSnapshot)


class DownloadCancelled(Exception):
    pass


class DownloadPaused(Exception):
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


ALLOWED_TRANSITIONS: dict[DownloadState, frozenset[DownloadState]] = {
    DownloadState.QUEUED: frozenset({DownloadState.RESOLVING, DownloadState.CANCELLED}),
    DownloadState.RESOLVING: frozenset(
        {DownloadState.DOWNLOADING, DownloadState.FAILED, DownloadState.CANCELLED}
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
        {DownloadState.COMPLETED, DownloadState.FAILED, DownloadState.CANCELLED}
    ),
    DownloadState.FAILED: frozenset({DownloadState.RESOLVING, DownloadState.CANCELLED}),
    DownloadState.COMPLETED: frozenset(),
    DownloadState.CANCELLED: frozenset(),
}


class CheckedDownload:
    """Crash-recoverable byte download with signed size and digest validation."""

    def __init__(self, artifact: DownloadableArtifact, destination: Path):
        self.artifact = artifact
        self.destination = destination
        self.partial = destination.with_suffix(destination.suffix + ".part")
        self.state_file = destination.with_suffix(destination.suffix + ".download.json")
        self._pause = threading.Event()
        self._cancel = threading.Event()
        self._listeners: list[Callable[[DownloadSnapshot], None]] = []
        initial = DownloadSnapshot(
            artifact.id, DownloadState.QUEUED, str(destination), bytes_total=artifact.size_bytes
        )
        self.snapshot = self._recover(initial)

    def subscribe(self, listener: Callable[[DownloadSnapshot], None]) -> None:
        self._listeners.append(listener)

    def _transition(self, state: DownloadState, **changes: object) -> None:
        if state not in ALLOWED_TRANSITIONS[self.snapshot.state]:
            raise RuntimeError(
                f"invalid download transition {self.snapshot.state.value} -> {state.value}"
            )
        values = asdict(self.snapshot)
        values.update(changes)
        values["state"] = state
        self.snapshot = DownloadSnapshot(**values)
        self._persist()
        for listener in tuple(self._listeners):
            try:
                listener(self.snapshot)
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
        os.replace(temporary, self.state_file)

    def pause(self) -> None:
        self._pause.set()

    def cancel(self) -> None:
        self._cancel.set()
        if self.snapshot.state in {
            DownloadState.QUEUED,
            DownloadState.PAUSED,
            DownloadState.FAILED,
        }:
            self.partial.unlink(missing_ok=True)
            self._transition(DownloadState.CANCELLED, bytes_downloaded=0)

    async def run(self) -> DownloadSnapshot:
        if self.snapshot.state not in {
            DownloadState.QUEUED,
            DownloadState.PAUSED,
            DownloadState.FAILED,
        }:
            raise RuntimeError(f"cannot run download in {self.snapshot.state.value}")
        self._pause.clear()
        self._cancel.clear()
        self._transition(
            DownloadState.RESOLVING,
            attempt=self.snapshot.attempt + 1,
            error_code=None,
            error_detail=None,
        )
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
            return self.snapshot
        errors: list[str] = []
        for index, url in enumerate(self.artifact.urls):
            try:
                await asyncio.to_thread(self._download_one, url)
                if self._cancel.is_set():
                    raise DownloadCancelled
                self._transition(DownloadState.VERIFYING)
                await asyncio.to_thread(self._verify, self.partial)
                if self._cancel.is_set():
                    raise DownloadCancelled
                os.replace(self.partial, self.destination)
                self._transition(DownloadState.COMPLETED, bytes_downloaded=self.artifact.size_bytes)
                return self.snapshot
            except DownloadPaused:
                self._transition(DownloadState.PAUSED)
                return self.snapshot
            except DownloadCancelled:
                self.partial.unlink(missing_ok=True)
                self._transition(DownloadState.CANCELLED, bytes_downloaded=0)
                return self.snapshot
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
                    break
        if self.snapshot.state != DownloadState.FAILED:
            self._transition(
                DownloadState.FAILED, error_code="download_failed", error_detail="; ".join(errors)
            )
        return self.snapshot

    def _download_one(self, url: str) -> None:
        self.destination.parent.mkdir(parents=True, exist_ok=True)
        requested_scheme = urlsplit(url).scheme.lower()
        if requested_scheme not in {"https", "file"}:
            raise ValueError("model downloads require HTTPS")
        offset = self.partial.stat().st_size if self.partial.exists() else 0
        headers = {"Range": f"bytes={offset}-"} if offset else {}
        request = Request(url, headers=headers)
        with urlopen(request, timeout=60) as response:
            final_scheme = urlsplit(cast(str, response.geturl())).scheme.lower()
            if requested_scheme == "https" and final_scheme != "https":
                raise ValueError("download redirect downgraded HTTPS")
            status = getattr(response, "status", 200)
            if offset and status != 206:
                offset = 0
                mode = "wb"
            else:
                mode = "ab" if offset else "wb"
            content_range = response.headers.get("Content-Range")
            if offset and status == 206 and not str(content_range).startswith(f"bytes {offset}-"):
                raise ValueError("server returned an invalid byte range")
            content_length = response.headers.get("Content-Length")
            total = offset + int(content_length) if content_length else self.artifact.size_bytes
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
                while chunk := response.read(1024 * 1024):
                    if self._cancel.is_set():
                        raise DownloadCancelled
                    if self._pause.is_set():
                        raise DownloadPaused
                    output.write(chunk)
                    downloaded += len(chunk)
                    if downloaded > self.artifact.size_bytes:
                        raise ValueError("download exceeds signed artifact size")
                    # Update persisted progress at chunk boundaries so recovery is
                    # precise without making correctness depend on UI callbacks.
                    self.snapshot = replace(self.snapshot, bytes_downloaded=downloaded)
                    self._persist()
                    for listener in tuple(self._listeners):
                        try:
                            listener(self.snapshot)
                        except Exception:
                            # Presentation callbacks do not own download correctness.
                            continue

    def _verify(self, path: Path) -> None:
        if not path.is_file() or path.stat().st_size != self.artifact.size_bytes:
            raise ValueError(f"size mismatch for {self.artifact.id}")
        if sha256_file(path).lower() != self.artifact.sha256.lower():
            raise ValueError(f"checksum mismatch for {self.artifact.id}")

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
                self._verify(self.destination)
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
    def __init__(self, artifact: ModelArtifact, destination: Path):
        super().__init__(artifact, destination)


class RuntimePackDownload(CheckedDownload):
    def __init__(self, artifact: RuntimePackArtifact | RuntimeCompanionArtifact, destination: Path):
        super().__init__(artifact, destination)


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
