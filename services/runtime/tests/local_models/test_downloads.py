import asyncio
import hashlib
from pathlib import Path

from pytest import MonkeyPatch

import cupcake_runtime.local_models.downloads as downloads_module
from cupcake_runtime.local_models.downloads import ModelDownload
from cupcake_runtime.local_models.types import DownloadState, ModelArtifact


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
