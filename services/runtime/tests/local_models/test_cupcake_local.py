from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import subprocess
import zipfile
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from cupcake_runtime.local_models.catalog import (
    SignedModelCatalog,
    SignedRuntimeCatalog,
    canonical_json,
)
from cupcake_runtime.local_models.downloads import ModelDownload
from cupcake_runtime.local_models.managed import (
    CupcakeLocalManager,
    LicenseAcceptanceRequired,
)
from cupcake_runtime.local_models.manager import LlamaCppSupervisor, LlamaServerConfig
from cupcake_runtime.local_models.model_store import InstalledModelStore, ModelInUseError
from cupcake_runtime.local_models.recommendations import rank_runtime_packs
from cupcake_runtime.local_models.runtime_packs import (
    RuntimePackIntegrityError,
    RuntimePackStore,
)
from cupcake_runtime.local_models.types import (
    DownloadState,
    HardwareProfile,
    ModelArtifact,
    RuntimeBackend,
    RuntimeCompanionArtifact,
    RuntimeEndpoint,
    RuntimeKind,
    RuntimePackArtifact,
    RuntimeState,
)


def _runtime_artifact(archive: Path, files: dict[str, bytes]) -> RuntimePackArtifact:
    return RuntimePackArtifact(
        id="llama-b10672-cpu",
        version="b10672",
        backend=RuntimeBackend.CPU,
        platform="windows",
        architecture="x64",
        size_bytes=archive.stat().st_size,
        sha256=_digest(archive.read_bytes()),
        urls=("https://example.invalid/llama-b10672-bin-win-cpu-x64.zip",),
        filename="llama-b10672-bin-win-cpu-x64.zip",
        executable="llama-server.exe",
        files={name: _digest(content) for name, content in files.items()},
        source_revision="511f9c1",
    )


def _zip(path: Path, files: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for name, content in files.items():
            bundle.writestr(name, content)


def _digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _model_artifact(data: bytes) -> ModelArtifact:
    return ModelArtifact(
        "qwen:8b-q4",
        "Qwen 8B",
        "qwen",
        8,
        "Q4_K_M",
        len(data),
        _digest(data),
        ("https://example.invalid/qwen.gguf",),
        "qwen.gguf",
        "Apache-2.0",
        "https://example.invalid/license",
        32768,
    )


def test_signed_runtime_catalog_accepts_only_windows_x64_manifest() -> None:
    payload: dict[str, Any] = {
        "version": 1,
        "generated_at": "2026-08-28T00:00:00Z",
        "runtimes": [
            {
                "id": "llama-b10672-cpu",
                "version": "b10672",
                "backend": "cpu",
                "platform": "windows",
                "architecture": "x64",
                "size_bytes": 10,
                "sha256": "1" * 64,
                "urls": ["https://github.com/ggml-org/llama.cpp/releases/download/b10672/a.zip"],
                "filename": "a.zip",
                "executable": "llama-server.exe",
                "files": {"llama-server.exe": "2" * 64},
                "source_revision": "511f9c1",
            }
        ],
    }
    private = Ed25519PrivateKey.generate()
    document: dict[str, Any] = {
        "key_id": "release-1",
        "payload": payload,
        "signature": base64.b64encode(private.sign(canonical_json(payload))).decode(),
    }
    catalog = SignedRuntimeCatalog.verify_and_load(
        document, {"release-1": private.public_key().public_bytes_raw()}
    )
    assert catalog.get("llama-b10672-cpu").backend == RuntimeBackend.CPU

    payload["runtimes"][0]["architecture"] = "arm64"
    document["signature"] = base64.b64encode(private.sign(canonical_json(payload))).decode()
    with pytest.raises(ValueError, match="Windows x64"):
        SignedRuntimeCatalog.verify_and_load(
            document, {"release-1": private.public_key().public_bytes_raw()}
        )

    payload["runtimes"][0]["architecture"] = "x64"
    payload["runtimes"][0]["executable"] = "..\\llama-server.exe"
    payload["runtimes"][0]["files"] = {"..\\llama-server.exe": "2" * 64}
    document["signature"] = base64.b64encode(private.sign(canonical_json(payload))).decode()
    with pytest.raises(ValueError, match="unsafe runtime executable"):
        SignedRuntimeCatalog.verify_and_load(
            document, {"release-1": private.public_key().public_bytes_raw()}
        )


def test_committed_local_rc_runtime_catalog_signature_and_provenance() -> None:
    root = Path(__file__).resolve().parents[4]
    document = json.loads(
        (root / "packaging/catalogs/cupcake-local-runtime-v1.json").read_text(encoding="utf-8")
    )
    key_document = json.loads(
        (root / "packaging/catalogs/cupcake-local-public-keys.json").read_text(encoding="utf-8")
    )
    keys = {key_id: base64.b64decode(encoded) for key_id, encoded in key_document["keys"].items()}
    catalog = SignedRuntimeCatalog.verify_and_load(document, keys)
    runtime = catalog.get("llama.cpp:b10679:windows-x64-cpu")
    assert runtime.sha256 == "c0dec4dfb52919e17f0a108a94bfbe877c67d77825145079e7703fc84f63986e"
    assert runtime.source_revision == "50f068ffffc3e0e4c9c2e4139281c6075224f429"
    assert len(runtime.files) == 51
    assert runtime.bundled_by_default is True
    assert len(catalog.runtimes) == 4
    vulkan = catalog.get("llama.cpp:b10679:windows-x64-vulkan")
    cuda = catalog.get("llama.cpp:b10679:windows-x64-cuda-12.4")
    cuda_13 = catalog.get("llama.cpp:b10679:windows-x64-cuda-13.3")
    assert vulkan.bundled_by_default is False
    assert vulkan.hardware_compatibility["api"] == "vulkan"
    assert cuda.total_download_bytes == 641981732
    assert cuda.companions[0].license == "NVIDIA CUDA Toolkit EULA"
    assert cuda.hardware_compatibility["minimum_windows_driver"] == "551.61"
    assert cuda_13.total_download_bytes == 537489729
    assert cuda_13.companions[0].files["cudart64_13.dll"] == (
        "b00ca6f53699120da815bf3e06e2e4285fae2f201235b883dcbb50eec51e2a2a"
    )
    assert cuda_13.hardware_compatibility["minimum_windows_driver"] == "580.00"
    assert key_document["productionTrustRoot"] is False
    assert document["payload"]["provenance"]["production_signing"] is False


def test_runtime_pack_install_activate_verify_and_detect_tampering(tmp_path: Path) -> None:
    files = {
        "llama-server.exe": b"signed executable",
        "ggml.dll": b"signed dependency",
        "LICENSE": b"MIT",
    }
    archive = tmp_path / "runtime.zip"
    _zip(archive, files)
    artifact = _runtime_artifact(archive, files)
    store = RuntimePackStore(tmp_path / "runtime")

    installed = store.install(artifact, archive)
    assert installed.integrity_verified is True
    assert installed.active is False
    active = store.activate(artifact.version, artifact.backend)
    assert active.active is True
    assert store.active() is not None

    Path(active.executable).write_bytes(b"tampered")
    metadata_only = store.active(verify_integrity=False)
    assert metadata_only is not None
    assert metadata_only.active is True
    assert metadata_only.integrity_verified is False
    assert store.list(verify_integrity=False)[0].integrity_verified is False
    assert store.verify(active) is False
    with pytest.raises(RuntimePackIntegrityError, match="corrupt"):
        store.activate(artifact.version, artifact.backend)

    metadata_path = Path(active.directory, store.METADATA_NAME)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["files"]["llama-server.exe"] = _digest(b"tampered")
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    assert store.verify(active) is True
    assert store.verify_against_artifact(active, artifact) is False


def test_acceleration_pack_companion_install_and_rollback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cpu_files = {"llama-server.exe": b"server-cpu", "ggml.dll": b"common-cpu"}
    cpu_archive = tmp_path / "cpu.zip"
    _zip(cpu_archive, cpu_files)
    cpu = _runtime_artifact(cpu_archive, cpu_files)

    cuda_files = {"llama-server.exe": b"server-cuda", "ggml-cuda.dll": b"cuda"}
    cuda_archive = tmp_path / "cuda.zip"
    _zip(cuda_archive, cuda_files)
    companion_files = {"cudart64_12.dll": b"cudart"}
    companion_archive = tmp_path / "cudart.zip"
    _zip(companion_archive, companion_files)
    companion = RuntimeCompanionArtifact(
        "nvidia:cudart:test",
        companion_archive.stat().st_size,
        _digest(companion_archive.read_bytes()),
        ("https://example.invalid/cudart.zip",),
        "cudart.zip",
        {name: _digest(content) for name, content in companion_files.items()},
        "NVIDIA CUDA Toolkit EULA",
        "https://docs.nvidia.com/cuda/eula/index.html",
    )
    cuda = RuntimePackArtifact(
        "llama-b10672-cuda",
        "b10672",
        RuntimeBackend.CUDA_12,
        "windows",
        "x64",
        cuda_archive.stat().st_size,
        _digest(cuda_archive.read_bytes()),
        ("https://example.invalid/cuda.zip",),
        "cuda.zip",
        "llama-server.exe",
        {name: _digest(content) for name, content in cuda_files.items()},
        "511f9c1",
        companions=(companion,),
        hardware_compatibility={
            "api": "cuda",
            "minimum_windows_driver": "551.61",
        },
        prerequisites=("NVIDIA driver 551.61 or newer",),
    )
    monkeypatch.setattr("cupcake_runtime.local_models.managed.LlamaCppSupervisor", _FakeSupervisor)
    manager = CupcakeLocalManager(tmp_path / "profile")
    manager.configure_catalogs(
        runtimes=SignedRuntimeCatalog(1, "2026-09-05T00:00:00Z", (cpu, cuda), "test")
    )
    manager.install_runtime(cpu, cpu_archive)
    with pytest.raises(RuntimePackIntegrityError, match="companion archive set"):
        manager.install_runtime(cuda, cuda_archive)
    active = manager.runtimes.active()
    assert active is not None
    assert active.backend == RuntimeBackend.CPU

    accelerated = manager.install_runtime(
        cuda,
        cuda_archive,
        companion_archives={companion.id: companion_archive},
    )
    assert accelerated.backend == RuntimeBackend.CUDA_12
    assert accelerated.integrity_verified is True
    assert Path(accelerated.directory, "cudart64_12.dll").is_file()
    rolled_back = manager.rollback_runtime()
    assert rolled_back.backend == RuntimeBackend.CPU


def test_runtime_pack_selection_respects_driver_and_falls_back() -> None:
    root = Path(__file__).resolve().parents[4]
    document = json.loads(
        (root / "packaging/catalogs/cupcake-local-runtime-v1.json").read_text(encoding="utf-8")
    )
    key_document = json.loads(
        (root / "packaging/catalogs/cupcake-local-public-keys.json").read_text(encoding="utf-8")
    )
    keys = {key_id: base64.b64decode(encoded) for key_id, encoded in key_document["keys"].items()}
    runtimes = SignedRuntimeCatalog.verify_and_load(document, keys).runtimes

    modern_nvidia = HardwareProfile(
        32, 24, "NVIDIA GeForce RTX 4070", 12, 16, ("cuda", "vulkan"), 100, "580.00"
    )
    ranked = rank_runtime_packs(runtimes, modern_nvidia)
    assert ranked[0].runtime_id.endswith("cuda-13.3")
    assert ranked[0].recommended is True

    cuda_12_driver = HardwareProfile(
        32, 24, "NVIDIA GeForce RTX 4070", 12, 16, ("cuda", "vulkan"), 100, "551.61"
    )
    ranked = rank_runtime_packs(runtimes, cuda_12_driver)
    assert ranked[0].runtime_id.endswith("cuda-12.4")
    assert ranked[0].recommended is True

    old_driver = HardwareProfile(
        32, 24, "NVIDIA GeForce RTX 4070", 12, 16, ("cuda", "vulkan"), 100, "546.12"
    )
    ranked = rank_runtime_packs(runtimes, old_driver)
    assert ranked[0].runtime_id.endswith("vulkan")
    cuda = next(item for item in ranked if item.runtime_id.endswith("cuda-12.4"))
    assert cuda.compatible is False
    assert "551.61" in " ".join(cuda.reasons)

    cpu_only = HardwareProfile(16, 12, None, None, 8, (), 100)
    ranked = rank_runtime_packs(runtimes, cpu_only)
    assert ranked[0].runtime_id.endswith("cpu")


def test_cuda_companion_license_requires_explicit_acceptance(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[4]
    document = json.loads(
        (root / "packaging/catalogs/cupcake-local-runtime-v1.json").read_text(encoding="utf-8")
    )
    key_document = json.loads(
        (root / "packaging/catalogs/cupcake-local-public-keys.json").read_text(encoding="utf-8")
    )
    keys = {key_id: base64.b64decode(encoded) for key_id, encoded in key_document["keys"].items()}
    catalog = SignedRuntimeCatalog.verify_and_load(document, keys)
    cuda = catalog.get("llama.cpp:b10679:windows-x64-cuda-12.4")
    manager = CupcakeLocalManager(tmp_path)
    with pytest.raises(LicenseAcceptanceRequired) as required:
        manager.begin_runtime_download(cuda)
    assert required.value.license_urls == ("https://docs.nvidia.com/cuda/eula/index.html",)
    download = manager.begin_runtime_download(
        cuda, accepted_license_urls=required.value.license_urls
    )
    assert download.snapshot.state == DownloadState.QUEUED


def test_runtime_pack_rejects_unsigned_and_traversal_members(tmp_path: Path) -> None:
    files = {"llama-server.exe": b"server"}
    archive = tmp_path / "unsafe.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("llama-server.exe", files["llama-server.exe"])
        bundle.writestr("../escape.dll", b"escape")
    artifact = _runtime_artifact(archive, files)
    with pytest.raises(RuntimePackIntegrityError, match="unsafe archive member"):
        RuntimePackStore(tmp_path / "runtime").install(artifact, archive)
    assert not (tmp_path / "escape.dll").exists()


def test_installed_model_store_rechecks_checksum_and_blocks_active_removal(tmp_path: Path) -> None:
    data = b"small deterministic GGUF fixture"
    artifact = _model_artifact(data)
    store = InstalledModelStore(tmp_path / "models")
    destination = artifact.target(store.root)
    destination.parent.mkdir(parents=True)
    destination.write_bytes(data)
    store.register(artifact, destination)
    assert store.get(artifact.id).integrity_verified is True
    assert store.get(artifact.id, verify=False).integrity_verified is False
    assert store.list(verify=False)[0].integrity_verified is False
    assert store.verify_against_artifact(store.get(artifact.id, verify=False), artifact) is True
    with pytest.raises(ModelInUseError):
        store.remove(artifact.id, active_model_id=artifact.id)
    destination.write_bytes(b"tampered")
    assert store.get(artifact.id).integrity_verified is False


def test_signed_model_binding_rejects_a_self_consistent_mutable_receipt(tmp_path: Path) -> None:
    original = b"signed model bytes"
    replacement = b"forged model bytes"
    assert len(original) == len(replacement)
    artifact = _model_artifact(original)
    store = InstalledModelStore(tmp_path / "models")
    destination = artifact.target(store.root)
    destination.parent.mkdir(parents=True)
    destination.write_bytes(original)
    store.register(artifact, destination)

    destination.write_bytes(replacement)
    manifest_path = store.manifests / f"{hashlib.sha256(artifact.id.encode()).hexdigest()}.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["sha256"] = _digest(replacement)
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    forged = store.get(artifact.id)

    assert forged.integrity_verified is True
    assert store.verify_against_artifact(forged, artifact) is False

    manager = CupcakeLocalManager(tmp_path)
    manager.configure_catalogs(
        models=SignedModelCatalog(1, "2026-09-05T00:00:00Z", (artifact,), "test")
    )
    assert manager.status()["models"][0]["integrity_verified"] is False
    assert manager.status(verify_integrity=True)["models"][0]["integrity_verified"] is False
    with pytest.raises(RuntimePackIntegrityError, match="corrupt GGUF"):
        asyncio.run(manager.load(artifact.id))

    manager_without_catalog = CupcakeLocalManager(tmp_path)
    with pytest.raises(RuntimeError, match="verified model catalog"):
        asyncio.run(manager_without_catalog.load(artifact.id))


class _InterruptedModelDownload(ModelDownload):
    """Expose a test seam for simulating a crash between persisted states."""

    def mark_downloading(self, *, bytes_downloaded: int) -> None:
        self._transition(DownloadState.RESOLVING)
        self._transition(DownloadState.DOWNLOADING, bytes_downloaded=bytes_downloaded)


def test_interrupted_download_recovers_as_paused(tmp_path: Path) -> None:
    data = b"complete model bytes"
    artifact = _model_artifact(data)
    destination = tmp_path / artifact.filename
    first = _InterruptedModelDownload(artifact, destination)
    first.partial.write_bytes(data[:5])
    first.mark_downloading(bytes_downloaded=5)

    recovered = ModelDownload(artifact, destination)
    assert recovered.snapshot.state == DownloadState.PAUSED
    assert recovered.snapshot.bytes_downloaded == 5


def test_manager_rehydrates_download_after_catalog_restore(tmp_path: Path) -> None:
    data = b"complete model bytes"
    artifact = _model_artifact(data)
    root = tmp_path / "cupcake-local"
    destination = artifact.target(root / "models")
    destination.parent.mkdir(parents=True)
    first = _InterruptedModelDownload(artifact, destination)
    first.partial.write_bytes(data[:5])
    first.mark_downloading(bytes_downloaded=5)
    catalog = SignedModelCatalog(
        1,
        "2026-08-29T00:00:00Z",
        (artifact,),
        "test",
    )

    recovered = CupcakeLocalManager(root)
    recovered.configure_catalogs(models=catalog)

    snapshot = recovered.download_status(artifact.id)
    assert snapshot.state == DownloadState.PAUSED
    assert snapshot.bytes_downloaded == 5
    assert recovered.begin_model_download(artifact).state == DownloadState.PAUSED


def test_status_exposes_ranked_installable_catalog(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    artifact = _model_artifact(b"model")
    catalog = SignedModelCatalog(1, "2026-08-29T00:00:00Z", (artifact,), "test")
    manager = CupcakeLocalManager(tmp_path / "cupcake-local")
    manager.configure_catalogs(models=catalog)

    def detected_hardware(*_args: object, **_kwargs: object) -> HardwareProfile:
        return HardwareProfile(32, 24, "NVIDIA GeForce RTX 4070", 12, 16, ("cuda",), 100)

    monkeypatch.setattr(
        "cupcake_runtime.local_models.managed.detect_hardware",
        detected_hardware,
    )

    status = manager.status()

    assert status["availableModels"][0]["id"] == artifact.id
    assert status["recommendations"][0]["model_id"] == artifact.id
    assert status["recommendations"][0]["label"] == "Recommended"


def test_download_uses_mirror_after_integrity_failure(tmp_path: Path) -> None:
    valid = tmp_path / "valid.gguf"
    corrupt = tmp_path / "corrupt.gguf"
    valid.write_bytes(b"model")
    corrupt.write_bytes(b"wrong")
    artifact = ModelArtifact(
        "mirror-model",
        "Mirror model",
        "test",
        1,
        "Q4_K_M",
        valid.stat().st_size,
        _digest(valid.read_bytes()),
        (corrupt.as_uri(), valid.as_uri()),
        "installed.gguf",
        "Apache-2.0",
        "https://example.invalid/license",
        4096,
    )
    result = asyncio.run(ModelDownload(artifact, tmp_path / artifact.filename).run())
    assert result.state == DownloadState.COMPLETED
    assert (tmp_path / artifact.filename).read_bytes() == valid.read_bytes()
    assert result.attempt == 2


class _FakeProcess:
    def __init__(self, args: list[str], **kwargs: Any):
        self.args = args
        self.kwargs = kwargs
        self.pid = 4321
        self.returncode: int | None = None
        self.stderr = io.BytesIO()

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.returncode = 0

    def kill(self) -> None:
        self.returncode = -9

    def wait(self, _timeout: float | None = None) -> int:
        self.returncode = 0
        return 0


def test_supervisor_uses_current_safe_server_flags_and_scrubbed_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    executable = tmp_path / "llama-server.exe"
    model = tmp_path / "model.gguf"
    executable.write_bytes(b"exe")
    model.write_bytes(b"gguf")
    captured: list[_FakeProcess] = []

    def spawn(args: list[str], **kwargs: Any) -> _FakeProcess:
        process = _FakeProcess(args, **kwargs)
        captured.append(process)
        return process

    monkeypatch.setattr(subprocess, "Popen", spawn)
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-leak")
    supervisor = LlamaCppSupervisor(executable, port=8123, log_directory=tmp_path / "logs")
    supervisor.start(model, context_size=8192, gpu_layers="auto", device=None, parallel=1)

    process = captured[0]
    assert supervisor.state == RuntimeState.STARTING
    assert "--no-ui" in process.args
    assert "--jinja" in process.args
    assert "--n-gpu-layers" in process.args
    assert "auto" in process.args
    assert process.args[process.args.index("--fit") + 1] == "on"
    assert process.args[process.args.index("--fit-target") + 1] == "1024"
    assert "--api-key" not in process.args
    assert "LLAMA_API_KEY" in process.kwargs["env"]
    assert process.kwargs["env"]["LLAMA_ARG_API_PREFIX"].startswith("/cupcake-")
    assert "OPENAI_API_KEY" not in process.kwargs["env"]
    asyncio.run(supervisor.stop())
    assert supervisor.state == RuntimeState.STOPPED


def test_supervisor_benchmark_uses_authenticated_measured_llama_timings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    executable = tmp_path / "llama-server.exe"
    executable.write_bytes(b"exe")

    class _PrimedBenchmarkSupervisor(LlamaCppSupervisor):
        def prime(self) -> None:
            self._process = _FakeProcess([])  # type: ignore[assignment]
            self._state = RuntimeState.READY
            self._api_key = "ephemeral-test-key"
            self._api_prefix = "/cupcake-test"
            self._context_size = 8192

    supervisor = _PrimedBenchmarkSupervisor(executable, port=8123)
    supervisor.prime()
    captured: list[Any] = []

    class _Response:
        def __enter__(self) -> _Response:
            return self

        def __exit__(self, *_args: Any) -> None:
            return None

        def read(self, _limit: int) -> bytes:
            return json.dumps(
                {
                    "usage": {"prompt_tokens": 12, "completion_tokens": 24},
                    "timings": {
                        "prompt_n": 12,
                        "prompt_ms": 120,
                        "predicted_n": 24,
                        "predicted_ms": 800,
                    },
                }
            ).encode()

    def fake_urlopen(request: Any, *, timeout: float) -> _Response:
        captured.append((request, timeout))
        return _Response()

    monkeypatch.setattr("cupcake_runtime.local_models.manager.urlopen", fake_urlopen)

    measurement = asyncio.run(
        supervisor.benchmark(runtime_id="runtime-test", model_id="model-test", max_tokens=24)
    )

    request, timeout = captured[0]
    assert request.full_url == "http://127.0.0.1:8123/cupcake-test/v1/chat/completions"
    assert request.headers["Authorization"] == "Bearer ephemeral-test-key"
    assert timeout == 120.0
    assert measurement.prompt_tokens_per_second == 100
    assert measurement.generated_tokens_per_second == 30
    assert measurement.context_size == 8192
    assert measurement.measurement_source == "llama.cpp timings"


def test_supervisor_health_probe_uses_ephemeral_server_authentication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    executable = tmp_path / "llama-server.exe"
    executable.write_bytes(b"exe")
    supervisor = LlamaCppSupervisor(executable, port=8123)
    supervisor._api_key = "ephemeral-health-key"  # pyright: ignore[reportPrivateUsage]
    supervisor._api_prefix = "/cupcake-test"  # pyright: ignore[reportPrivateUsage]
    captured: list[Any] = []

    class _Response:
        status = 200

        def __enter__(self) -> _Response:
            return self

        def __exit__(self, *_args: Any) -> None:
            return None

        def read(self, _limit: int) -> bytes:
            return b'{"status":"ok"}'

    def fake_urlopen(request: Any, *, timeout: float) -> _Response:
        captured.append((request, timeout))
        return _Response()

    monkeypatch.setattr("cupcake_runtime.local_models.manager.urlopen", fake_urlopen)
    status, payload = supervisor._health_request()  # pyright: ignore[reportPrivateUsage]

    request, timeout = captured[0]
    assert status == 200
    assert payload == {"status": "ok"}
    assert request.full_url == "http://127.0.0.1:8123/cupcake-test/health"
    assert request.headers["Authorization"] == "Bearer ephemeral-health-key"
    assert timeout == 1.0


def test_runtime_inspection_processes_stay_hidden_on_windows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    executable = tmp_path / "llama-server.exe"
    executable.write_bytes(b"exe")
    captured: list[dict[str, Any]] = []

    def run(args: list[str], **kwargs: Any) -> Any:
        captured.append(kwargs)
        output = b"CUDA0: Test GPU\n" if "--list-devices" in args else b"version b10672\n"
        return type("Result", (), {"returncode": 0, "stdout": output, "stderr": b""})()

    monkeypatch.setattr("cupcake_runtime.local_models.manager.subprocess.run", run)
    monkeypatch.setattr("cupcake_runtime.local_models.manager.sys.platform", "win32")
    monkeypatch.setattr(
        "cupcake_runtime.local_models.manager.subprocess.CREATE_NO_WINDOW", 0x08000000
    )
    supervisor = LlamaCppSupervisor(executable)

    assert "b10672" in supervisor.version()
    assert supervisor.list_devices() == ("CUDA0: Test GPU",)
    assert len(captured) == 2
    assert all(call["creationflags"] == 0x08000000 for call in captured)


def test_server_configuration_bounds_are_explicit() -> None:
    LlamaServerConfig(gpu_layers="auto", device=None).validate()
    LlamaServerConfig(gpu_layers="all", device=None).validate()
    with pytest.raises(ValueError, match="gpu_layers"):
        LlamaServerConfig(gpu_layers="magic").validate()
    with pytest.raises(ValueError, match="context_size"):
        LlamaServerConfig(context_size=128).validate()


class _FakeSupervisor:
    def __init__(self, executable: Path, **_kwargs: Any):
        self.executable = executable
        self.state = RuntimeState.STOPPED
        self.active_model: Path | None = None

    def version(self) -> str:
        return "llama.cpp version: 10672 (511f9c1)"

    def list_devices(self) -> tuple[str, ...]:
        return ("CUDA0: Test NVIDIA GPU", "Vulkan0: Test Vulkan GPU")

    def start(self, model: Path, **_kwargs: Any) -> int:
        self.active_model = model
        self.state = RuntimeState.STARTING
        return 1234

    async def wait_until_ready(self, **_kwargs: Any) -> RuntimeEndpoint:
        self.state = RuntimeState.READY
        return self.endpoint()

    def endpoint(self) -> RuntimeEndpoint:
        return RuntimeEndpoint(
            id="cupcake_llama_cpp:fake",
            kind=RuntimeKind.CUPCAKE_LLAMA_CPP,
            base_url="http://127.0.0.1:49152",
            state=self.state,
            managed=True,
        )

    async def stop(self) -> None:
        self.state = RuntimeState.STOPPED
        self.active_model = None


def test_signed_runtime_gate_rejects_tampering_before_any_runtime_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    files = {"llama-server.exe": b"server", "ggml.dll": b"dll"}
    archive = tmp_path / "runtime.zip"
    _zip(archive, files)
    artifact = _runtime_artifact(archive, files)
    model_data = b"verified model"
    model_artifact = _model_artifact(model_data)
    calls = {"version": 0, "devices": 0, "start": 0}

    class _ProcessSpy(_FakeSupervisor):
        def version(self) -> str:
            calls["version"] += 1
            return super().version()

        def list_devices(self) -> tuple[str, ...]:
            calls["devices"] += 1
            return super().list_devices()

        def start(self, model: Path, **kwargs: Any) -> int:
            calls["start"] += 1
            return super().start(model, **kwargs)

    monkeypatch.setattr("cupcake_runtime.local_models.managed.LlamaCppSupervisor", _ProcessSpy)
    manager = CupcakeLocalManager(tmp_path / "profile")
    manager.configure_catalogs(
        models=SignedModelCatalog(1, "2026-09-05T00:00:00Z", (model_artifact,), "test"),
        runtimes=SignedRuntimeCatalog(1, "2026-09-05T00:00:00Z", (artifact,), "test"),
    )
    installed = manager.install_runtime(artifact, archive)
    model_path = model_artifact.target(manager.models.root)
    model_path.parent.mkdir(parents=True)
    model_path.write_bytes(model_data)
    manager.register_model(model_artifact, model_path)

    def assert_all_entry_points_refuse_before_process() -> None:
        calls.update(version=0, devices=0, start=0)
        operations = (
            lambda: manager.verify_runtime_for_execution(installed),
            lambda: manager.activate_runtime(artifact.version, artifact.backend),
            manager.version,
            manager.devices,
            lambda: asyncio.run(manager.load(model_artifact.id)),
        )
        for operation in operations:
            with pytest.raises(RuntimePackIntegrityError, match="corrupt runtime pack"):
                operation()
        assert calls == {"version": 0, "devices": 0, "start": 0}

    executable = Path(installed.executable)
    executable.write_bytes(b"tampered")
    assert_all_entry_points_refuse_before_process()

    metadata_path = Path(installed.directory, manager.runtimes.METADATA_NAME)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["files"]["llama-server.exe"] = _digest(b"tampered")
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    assert manager.runtimes.verify(installed) is True
    assert manager.status(verify_integrity=True)["runtimes"][0]["integrity_verified"] is False
    assert_all_entry_points_refuse_before_process()


def test_accelerated_runtime_activation_requires_matching_live_device_probe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    files = {"llama-server.exe": b"server-cuda", "ggml-cuda.dll": b"cuda"}
    archive = tmp_path / "cuda.zip"
    _zip(archive, files)
    artifact = replace(
        _runtime_artifact(archive, files),
        id="llama-b10672-cuda",
        backend=RuntimeBackend.CUDA_12,
        hardware_compatibility={"api": "cuda", "minimum_windows_driver": "551.61"},
        prerequisites=("NVIDIA driver 551.61 or newer",),
    )

    class _NoCudaSupervisor(_FakeSupervisor):
        def list_devices(self) -> tuple[str, ...]:
            return ("Vulkan0: Test Vulkan GPU",)

    monkeypatch.setattr(
        "cupcake_runtime.local_models.managed.LlamaCppSupervisor", _NoCudaSupervisor
    )
    manager = CupcakeLocalManager(tmp_path / "profile")
    manager.configure_catalogs(
        runtimes=SignedRuntimeCatalog(1, "2026-09-05T00:00:00Z", (artifact,), "test")
    )
    manager.install_runtime(artifact, archive, activate=False)

    with pytest.raises(RuntimePackIntegrityError, match="CUDA device"):
        manager.activate_runtime(artifact.version, artifact.backend)

    assert manager.runtimes.active() is None


def test_cupcake_local_installs_loads_unloads_and_removes_without_bundled_weights(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    files = {"llama-server.exe": b"server", "ggml.dll": b"dll"}
    archive = tmp_path / "runtime.zip"
    _zip(archive, files)
    runtime_artifact = _runtime_artifact(archive, files)
    model_data = b"verified model"
    model_artifact = _model_artifact(model_data)

    monkeypatch.setattr("cupcake_runtime.local_models.managed.LlamaCppSupervisor", _FakeSupervisor)
    manager = CupcakeLocalManager(tmp_path / "cupcake-local")
    manager.configure_catalogs(
        models=SignedModelCatalog(
            version=1,
            generated_at="2026-09-05T00:00:00Z",
            models=(model_artifact,),
            key_id="local-test",
        ),
        runtimes=SignedRuntimeCatalog(
            version=1,
            generated_at="2026-09-05T00:00:00Z",
            runtimes=(runtime_artifact,),
            key_id="local-test",
        ),
    )
    runtime = manager.install_runtime(runtime_artifact, archive)
    assert runtime.active is True
    assert manager.status()["modelWeightsBundled"] is False

    model_path = model_artifact.target(manager.models.root)
    model_path.parent.mkdir(parents=True)
    model_path.write_bytes(model_data)
    manager.register_model(model_artifact, model_path)
    endpoint = asyncio.run(manager.load(model_artifact.id))
    assert endpoint.state == RuntimeState.READY
    assert manager.status()["activeModelId"] == model_artifact.id
    with pytest.raises(ModelInUseError):
        manager.remove_model(model_artifact.id)

    asyncio.run(manager.unload())
    manager.remove_model(model_artifact.id)
    assert manager.models.list() == ()


def test_cupcake_local_download_lifecycle_can_cancel_and_reset(tmp_path: Path) -> None:
    manager = CupcakeLocalManager(tmp_path / "cupcake-local")
    artifact = _model_artifact(b"model")
    queued = manager.begin_model_download(artifact)
    assert queued.state == DownloadState.QUEUED
    cancelled = manager.cancel_download(artifact.id)
    assert cancelled.state == DownloadState.CANCELLED
    assert manager.download_status(artifact.id).state == DownloadState.CANCELLED
    manager.reset_download(artifact.id)
    assert manager.download_snapshots() == ()
    assert manager.begin_model_download(artifact).state == DownloadState.QUEUED


def test_seed_packaged_baseline_verifies_catalog_archive_and_activates_idempotently(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    baseline = tmp_path / "baseline"
    archive_directory = baseline / "archive"
    archive_directory.mkdir(parents=True)
    files = {"llama-server.exe": b"server", "ggml.dll": b"dll"}
    archive = archive_directory / "llama-b10672-bin-win-cpu-x64.zip"
    _zip(archive, files)
    artifact = _runtime_artifact(archive, files)
    accelerated_artifacts = (
        replace(
            artifact,
            id="llama-b10672-cuda-12",
            backend=RuntimeBackend.CUDA_12,
            filename="llama-b10672-bin-win-cuda-12.4-x64.zip",
            hardware_compatibility={"api": "cuda", "minimum_windows_driver": "551.61"},
            prerequisites=("NVIDIA driver 551.61 or newer",),
        ),
        replace(
            artifact,
            id="llama-b10672-cuda-13",
            backend=RuntimeBackend.CUDA_13,
            filename="llama-b10672-bin-win-cuda-13.3-x64.zip",
            hardware_compatibility={"api": "cuda", "minimum_windows_driver": "580.00"},
            prerequisites=("NVIDIA driver 580.00 or newer",),
        ),
    )

    def catalog_entry(runtime: RuntimePackArtifact) -> dict[str, Any]:
        return {
            "id": runtime.id,
            "version": runtime.version,
            "backend": runtime.backend.value,
            "platform": runtime.platform,
            "architecture": runtime.architecture,
            "size_bytes": runtime.size_bytes,
            "sha256": runtime.sha256,
            "urls": list(runtime.urls),
            "filename": runtime.filename,
            "executable": runtime.executable,
            "files": dict(runtime.files),
            "source_revision": runtime.source_revision,
            "hardware_compatibility": dict(runtime.hardware_compatibility),
            "prerequisites": list(runtime.prerequisites),
        }

    payload = {
        "version": 1,
        "generated_at": "2026-08-28T00:00:00Z",
        "provenance": {
            "environment": "local-release-candidate",
            "production_signing": False,
        },
        "runtimes": [catalog_entry(item) for item in (artifact, *accelerated_artifacts)],
    }
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes_raw()
    (baseline / "cupcake-local-runtime-v1.json").write_text(
        json.dumps(
            {
                "key_id": "local-test",
                "payload": payload,
                "signature": base64.b64encode(private.sign(canonical_json(payload))).decode(),
            }
        ),
        encoding="utf-8",
    )
    (baseline / "cupcake-local-public-keys.json").write_text(
        json.dumps(
            {
                "environment": "local-release-candidate",
                "productionTrustRoot": False,
                "keys": {"local-test": base64.b64encode(public).decode()},
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr("cupcake_runtime.local_models.managed.LlamaCppSupervisor", _FakeSupervisor)
    manager = CupcakeLocalManager(tmp_path / "profile")
    configured = manager.configure_packaged_baseline(baseline)
    assert configured is not None
    assert configured.id == artifact.id
    configured_catalog = manager._runtime_catalog  # pyright: ignore[reportPrivateUsage]
    assert configured_catalog is not None
    assert [item.id for item in configured_catalog.runtimes] == [
        artifact.id,
        accelerated_artifacts[0].id,
        accelerated_artifacts[1].id,
    ]
    assert manager.runtimes.list() == ()
    status = manager.status()
    assert status["availableRuntimes"][0]["id"] == artifact.id
    assert status["activeRuntime"] is None

    installed = manager.seed_packaged_baseline(baseline)
    assert installed is not None
    assert installed.active is True
    installed_status = manager.status()
    assert installed_status["runtimes"][0]["integrity_verified"] is False
    assert installed_status["hardware"]["installed_acceleration_packs"] == ("cpu",)
    manager.verify_runtime_for_execution(installed)

    Path(installed.executable).write_bytes(b"tampered")
    with pytest.raises(RuntimePackIntegrityError, match="corrupt runtime pack"):
        manager.verify_runtime_for_execution(installed)
    Path(installed.executable).write_bytes(files["llama-server.exe"])

    gpu_artifact = accelerated_artifacts[1]
    manager.runtimes.install(gpu_artifact, archive)
    manager.activate_runtime(gpu_artifact.version, gpu_artifact.backend)
    installed_again = manager.seed_packaged_baseline(baseline)
    assert installed_again is not None
    assert installed_again.id == installed.id
    assert installed_again.active is False
    active = manager.runtimes.active()
    assert active is not None
    assert active.backend == RuntimeBackend.CUDA_13
    assert manager.seed_packaged_baseline(tmp_path / "missing") is None


def test_download_state_file_does_not_resume_another_artifact(tmp_path: Path) -> None:
    artifact = _model_artifact(b"first")
    destination = tmp_path / "model.gguf"
    state = destination.with_suffix(".gguf.download.json")
    state.write_text(
        json.dumps(
            {
                "model_id": "different",
                "state": "paused",
                "destination": str(destination),
                "bytes_downloaded": 4,
                "bytes_total": 5,
                "source_url": None,
                "error_code": None,
                "error_detail": None,
                "attempt": 1,
            }
        ),
        encoding="utf-8",
    )
    assert ModelDownload(artifact, destination).snapshot.state == DownloadState.QUEUED
