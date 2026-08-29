import asyncio
import hashlib
from pathlib import Path

from cupcake_runtime.local_models.downloads import ModelDownload
from cupcake_runtime.local_models.types import DownloadState, ModelArtifact


def test_file_download_completes_and_verifies(tmp_path: Path) -> None:
    source = tmp_path / "source.gguf"
    source.write_bytes(b"valid model bytes")
    data = source.read_bytes()
    artifact = ModelArtifact(
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
    download = ModelDownload(artifact, tmp_path / "models" / artifact.filename)
    result = asyncio.run(download.run())
    assert result.state == DownloadState.COMPLETED
    assert (tmp_path / "models" / artifact.filename).read_bytes() == data


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
