#!/usr/bin/env python3
"""Stage the pinned Cupcake Local CPU baseline for a Windows x64 RC package.

This script never downloads model weights. It accepts only the committed,
local-RC-signed runtime catalog and extracts the exact pinned llama.cpp ZIP
after both archive-level and per-file SHA-256 verification.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "services" / "runtime" / "src"))

from cupcake_runtime.local_models import (
    LlamaCppSupervisor,
    RuntimeBackend,
    RuntimePackDownload,
    RuntimePackStore,
    SignedRuntimeCatalog,
    sha256_file,
)
from cupcake_runtime.local_models.types import (
    DownloadState,
    RuntimePackArtifact,
)

DEFAULT_CATALOG = REPO_ROOT / "packaging" / "catalogs" / "cupcake-local-runtime-v1.json"
DEFAULT_KEYS = REPO_ROOT / "packaging" / "catalogs" / "cupcake-local-public-keys.json"
DEFAULT_CACHE = REPO_ROOT / "out" / "download-cache" / "cupcake-local"
DEFAULT_OUTPUT = (
    REPO_ROOT / "out" / "sidecars" / "win32-x64" / "sidecars" / "cupcake-local"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--keys", type=Path, default=DEFAULT_KEYS)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    return parser.parse_args()


def checked_output(path: Path) -> Path:
    resolved = path.resolve()
    out_root = (REPO_ROOT / "out").resolve()
    if out_root not in resolved.parents or resolved == out_root:
        raise ValueError(
            "Cupcake Local output must be a non-root child of repository out/"
        )
    return resolved


def load_catalog(
    catalog_path: Path, keys_path: Path
) -> tuple[dict[str, Any], SignedRuntimeCatalog]:
    document = json.loads(catalog_path.read_text(encoding="utf-8"))
    key_document = json.loads(keys_path.read_text(encoding="utf-8"))
    if key_document.get("environment") != "local-release-candidate":
        raise ValueError(
            "only the explicit local-release-candidate trust root is accepted"
        )
    if key_document.get("productionTrustRoot") is not False:
        raise ValueError("the RC catalog must not claim production signing")
    keys = {
        str(key_id): base64.b64decode(value, validate=True)
        for key_id, value in key_document["keys"].items()
    }
    catalog = SignedRuntimeCatalog.verify_and_load(document, keys)
    provenance = document["payload"].get("provenance", {})
    if (
        provenance.get("environment") != "local-release-candidate"
        or provenance.get("production_signing") is not False
    ):
        raise ValueError("runtime catalog provenance is not marked local RC")
    return document, catalog


def cpu_baseline(catalog: SignedRuntimeCatalog) -> RuntimePackArtifact:
    matches = tuple(
        runtime
        for runtime in catalog.runtimes
        if runtime.platform == "windows"
        and runtime.architecture == "x64"
        and runtime.backend == RuntimeBackend.CPU
    )
    if len(matches) != 1:
        raise ValueError(
            "runtime catalog must contain exactly one Windows x64 CPU baseline"
        )
    return matches[0]


def archive_valid(path: Path, artifact: RuntimePackArtifact) -> bool:
    return (
        path.is_file()
        and path.stat().st_size == artifact.size_bytes
        and sha256_file(path).lower() == artifact.sha256.lower()
    )


async def obtain_archive(
    artifact: RuntimePackArtifact, cache_dir: Path, *, offline: bool
) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    archive = cache_dir / artifact.filename
    if archive_valid(archive, artifact):
        return archive
    if offline:
        raise FileNotFoundError(
            f"verified cached runtime archive is unavailable: {archive}"
        )
    archive.unlink(missing_ok=True)
    archive.with_suffix(archive.suffix + ".part").unlink(missing_ok=True)
    archive.with_suffix(archive.suffix + ".download.json").unlink(missing_ok=True)
    result = await RuntimePackDownload(artifact, archive).run()
    if result.state != DownloadState.COMPLETED or not archive_valid(archive, artifact):
        raise RuntimeError(
            f"runtime download failed: {result.error_code}: {result.error_detail}"
        )
    return archive


def verify_executable(artifact: RuntimePackArtifact, executable: Path) -> str:
    if sys.platform != "win32":
        raise RuntimeError("Cupcake Local executable verification requires Windows x64")
    reported = LlamaCppSupervisor(executable).version()
    expected_build = artifact.version.removeprefix("b")
    if expected_build not in reported and artifact.source_revision[:7] not in reported:
        raise RuntimeError(f"llama.cpp version mismatch: {reported[:200]}")
    return reported


def stage(
    document: dict[str, Any],
    artifact: RuntimePackArtifact,
    archive: Path,
    output: Path,
    catalog_path: Path,
    keys_path: Path,
) -> None:
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    archive_directory = output / "archive"
    archive_directory.mkdir()
    staged_archive = archive_directory / artifact.filename
    shutil.copy2(archive, staged_archive)
    with tempfile.TemporaryDirectory(prefix="cupcake-local-verify-") as temporary:
        store = RuntimePackStore(Path(temporary) / "runtime")
        installed = store.install(artifact, staged_archive)
        reported = verify_executable(artifact, Path(installed.executable))
    shutil.copy2(catalog_path, output / catalog_path.name)
    shutil.copy2(keys_path, output / keys_path.name)
    staged_files = tuple(path for path in output.rglob("*") if path.is_file())
    if any(path.suffix.casefold() == ".gguf" for path in staged_files):
        raise RuntimeError(
            "model weights must never be staged in Cupcake Local baseline"
        )
    manifest = {
        "schemaVersion": 1,
        "environment": "local-release-candidate",
        "productionSigning": False,
        "modelWeightsBundled": False,
        "catalogKeyId": document["key_id"],
        "catalogSha256": sha256_file(catalog_path),
        "runtimeId": artifact.id,
        "runtimeVersion": artifact.version,
        "sourceRevision": artifact.source_revision,
        "archiveSha256": artifact.sha256,
        "archiveBytes": artifact.size_bytes,
        "runtimeFileCount": len(artifact.files),
        "reportedVersion": reported,
    }
    (output / "cupcake-local.manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def verify_stage(artifact: RuntimePackArtifact, output: Path) -> None:
    archive = output / "archive" / artifact.filename
    if not archive_valid(archive, artifact):
        raise RuntimeError("staged Cupcake Local archive is missing or corrupt")
    with tempfile.TemporaryDirectory(prefix="cupcake-local-verify-") as temporary:
        store = RuntimePackStore(Path(temporary) / "runtime")
        installed = store.install(artifact, archive)
        verify_executable(artifact, Path(installed.executable))
    if any(
        path.suffix.casefold() == ".gguf"
        for path in output.rglob("*")
        if path.is_file()
    ):
        raise RuntimeError("staged Cupcake Local directory contains model weights")
    manifest = json.loads(
        (output / "cupcake-local.manifest.json").read_text(encoding="utf-8")
    )
    if manifest.get("modelWeightsBundled") is not False:
        raise RuntimeError(
            "Cupcake Local manifest must explicitly exclude model weights"
        )


def main() -> None:
    args = parse_args()
    output = checked_output(args.out_dir)
    document, catalog = load_catalog(args.catalog.resolve(), args.keys.resolve())
    artifact = cpu_baseline(catalog)
    if args.verify_only:
        verify_stage(artifact, output)
    else:
        archive = asyncio.run(
            obtain_archive(artifact, args.cache_dir.resolve(), offline=args.offline)
        )
        stage(
            document,
            artifact,
            archive,
            output,
            args.catalog.resolve(),
            args.keys.resolve(),
        )
        verify_stage(artifact, output)
    print(
        f"Verified Cupcake Local {artifact.version} CPU baseline "
        f"({artifact.size_bytes} archive bytes, {len(artifact.files)} files, no weights)."
    )


if __name__ == "__main__":
    main()
