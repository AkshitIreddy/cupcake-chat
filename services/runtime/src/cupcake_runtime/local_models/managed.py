"""Cupcake Local: app-owned llama.cpp runtime and GGUF lifecycle."""

from __future__ import annotations

import asyncio
from dataclasses import asdict, replace
from pathlib import Path
from typing import Any

from .catalog import (
    PinnedCatalogBundle,
    SignedModelCatalog,
    SignedRuntimeCatalog,
    load_pinned_catalog_bundle,
)
from .downloads import CheckedDownload, ModelDownload, RuntimePackDownload
from .hardware import detect_hardware
from .manager import LlamaCppSupervisor, LlamaServerConfig
from .model_store import InstalledModelStore
from .recommendations import rank_catalog, rank_runtime_packs
from .runtime_packs import RuntimePackIntegrityError, RuntimePackStore
from .types import (
    DownloadSnapshot,
    DownloadState,
    InstalledModel,
    InstalledRuntimePack,
    ModelArtifact,
    PerformanceMeasurement,
    RuntimeBackend,
    RuntimeCompanionArtifact,
    RuntimeEndpoint,
    RuntimeKind,
    RuntimePackArtifact,
    RuntimeState,
)


class LicenseAcceptanceRequired(PermissionError):
    def __init__(self, license_urls: tuple[str, ...]):
        self.license_urls = license_urls
        super().__init__("accept required runtime licenses before downloading")


class CupcakeLocalManager:
    """Authoritative facade for the app-managed local-model subsystem.

    No model weights are part of the application. Only catalog-selected GGUF
    files enter ``models`` and every load re-verifies the immutable artifact.
    Runtime packs are independent, signed acceleration components installed
    side-by-side under ``runtime/versions``.
    """

    def __init__(self, root: Path):
        self.root = root
        self.models = InstalledModelStore(root / "models")
        self.runtimes = RuntimePackStore(root / "runtime")
        self.downloads = root / "downloads"
        self._supervisor: LlamaCppSupervisor | None = None
        self._runtime_id: str | None = None
        self._downloads: dict[str, CheckedDownload] = {}
        self._model_catalog: SignedModelCatalog | None = None
        self._runtime_catalog: SignedRuntimeCatalog | None = None
        self._activation_history: list[tuple[str, RuntimeBackend]] = []

    def configure_catalogs(
        self,
        *,
        models: SignedModelCatalog | None = None,
        runtimes: SignedRuntimeCatalog | None = None,
    ) -> None:
        if models is not None:
            self._model_catalog = models
        if runtimes is not None:
            self._runtime_catalog = runtimes
        self._rehydrate_downloads()

    def configure_pinned_catalogs(
        self,
        directory: Path,
        *,
        expected_environment: str | None = None,
        require_production: bool = False,
        require_models: bool = True,
        require_runtimes: bool = True,
    ) -> PinnedCatalogBundle:
        """Load fixed packaged catalogs through their pinned Ed25519 trust store."""

        bundle = load_pinned_catalog_bundle(
            directory,
            expected_environment=expected_environment,
            require_production=require_production,
            require_models=require_models,
            require_runtimes=require_runtimes,
        )
        self.configure_catalogs(models=bundle.models, runtimes=bundle.runtimes)
        return bundle

    def seed_packaged_baseline(self, baseline_dir: Path) -> InstalledRuntimePack | None:
        """Install the signed CPU pack and activate it only as a safe default.

        A missing optional resource returns ``None`` for source/developer runs.
        Once the directory exists, missing files, malformed provenance, an
        invalid Ed25519 signature, archive/file checksum drift, or executable
        version drift fail closed with their specific exception.
        """

        if not baseline_dir.is_dir():
            return None
        bundle = self.configure_pinned_catalogs(
            baseline_dir,
            expected_environment="local-release-candidate",
            require_production=False,
            require_models=False,
            require_runtimes=True,
        )
        catalog = bundle.runtimes
        if catalog is None:
            raise ValueError("packaged Cupcake Local runtime catalog is missing")
        if bundle.trust.production_trust_root:
            raise ValueError("packaged local RC trust root must not claim production status")
        import json

        document = json.loads(
            (baseline_dir / "cupcake-local-runtime-v1.json").read_text(encoding="utf-8")
        )
        provenance = document["payload"].get("provenance", {})
        if (
            provenance.get("environment") != "local-release-candidate"
            or provenance.get("production_signing") is not False
        ):
            raise ValueError("packaged Cupcake Local catalog is not marked local RC")
        candidates = tuple(
            runtime
            for runtime in catalog.runtimes
            if runtime.platform == "windows"
            and runtime.architecture == "x64"
            and runtime.backend == RuntimeBackend.CPU
        )
        if len(candidates) != 1:
            raise ValueError("packaged catalog must contain exactly one Windows x64 CPU baseline")
        artifact = candidates[0]
        archive = baseline_dir / "archive" / artifact.filename
        installed = self.install_runtime(
            artifact,
            archive,
            activate=self.runtimes.active() is None,
        )
        return installed

    async def download_runtime_by_id(
        self,
        runtime_id: str,
        *,
        activate: bool = True,
        accepted_license_urls: tuple[str, ...] = (),
    ) -> tuple[DownloadSnapshot, InstalledRuntimePack | None]:
        if self._runtime_catalog is None:
            raise RuntimeError("a verified runtime catalog is not configured")
        return await self.download_runtime(
            self._runtime_catalog.get(runtime_id),
            activate=activate,
            accepted_license_urls=accepted_license_urls,
        )

    def model_artifact(self, model_id: str) -> ModelArtifact:
        if self._model_catalog is None:
            raise RuntimeError("a verified model catalog is not configured")
        return self._model_catalog.get(model_id)

    def runtime_artifact(self, runtime_id: str) -> RuntimePackArtifact:
        if self._runtime_catalog is None:
            raise RuntimeError("a verified runtime catalog is not configured")
        return self._runtime_catalog.get(runtime_id)

    async def download_model_by_id(
        self, model_id: str
    ) -> tuple[DownloadSnapshot, InstalledModel | None]:
        if self._model_catalog is None:
            raise RuntimeError("a verified model catalog is not configured")
        return await self.download_model(self._model_catalog.get(model_id))

    def status(self, *, verify_integrity: bool = False) -> dict[str, Any]:
        active_runtime = self.runtimes.active()
        supervisor = self._supervisor
        if supervisor is not None:
            endpoint = supervisor.endpoint()
        elif active_runtime is not None:
            endpoint = RuntimeEndpoint(
                id=f"{RuntimeKind.CUPCAKE_LLAMA_CPP.value}:managed",
                kind=RuntimeKind.CUPCAKE_LLAMA_CPP,
                base_url="",
                state=RuntimeState.STOPPED,
                version=active_runtime.version,
                managed=True,
                metadata={"backend": active_runtime.backend.value},
            )
        else:
            endpoint = RuntimeEndpoint(
                id=f"{RuntimeKind.CUPCAKE_LLAMA_CPP.value}:managed",
                kind=RuntimeKind.CUPCAKE_LLAMA_CPP,
                base_url="",
                state=RuntimeState.ABSENT,
                managed=True,
                detail="install the verified Cupcake Local CPU runtime pack",
            )
        installed_packs = tuple(
            item.backend.value for item in self.runtimes.list() if item.integrity_verified
        )
        hardware = detect_hardware(self.root, installed_acceleration_packs=installed_packs)
        available_models = self._model_catalog.models if self._model_catalog else ()
        recommendations = rank_catalog(available_models, hardware) if available_models else ()
        available_runtimes = self._runtime_catalog.runtimes if self._runtime_catalog else ()
        runtime_recommendations = (
            rank_runtime_packs(available_runtimes, hardware) if available_runtimes else ()
        )
        return {
            "endpoint": asdict(endpoint),
            "hardware": asdict(hardware),
            "activeRuntime": asdict(active_runtime) if active_runtime else None,
            "runtimes": [asdict(item) for item in self.runtimes.list()],
            "models": [asdict(item) for item in self.models.list(verify=verify_integrity)],
            "downloads": [asdict(item) for item in self.download_snapshots()],
            "availableRuntimes": [asdict(item) for item in available_runtimes],
            "runtimeRecommendations": [asdict(item) for item in runtime_recommendations],
            "availableModels": [asdict(item) for item in available_models],
            "recommendations": [asdict(item) for item in recommendations],
            "activeModelId": self._active_model_id(),
            "modelWeightsBundled": False,
        }

    async def download_runtime(
        self,
        artifact: RuntimePackArtifact,
        *,
        activate: bool = True,
        accepted_license_urls: tuple[str, ...] = (),
    ) -> tuple[DownloadSnapshot, InstalledRuntimePack | None]:
        download = self.begin_runtime_download(
            artifact, accepted_license_urls=accepted_license_urls
        )
        snapshot = await self.resume_download(artifact.id)
        if snapshot.state != DownloadState.COMPLETED:
            return snapshot, None
        companion_archives: dict[str, Path] = {}
        for companion in artifact.companions:
            companion_download = self.begin_runtime_companion_download(companion)
            companion_snapshot = await self.resume_download(companion.id)
            if companion_snapshot.state != DownloadState.COMPLETED:
                return companion_snapshot, None
            companion_archives[companion.id] = companion_download.destination
        installed = self.install_runtime(
            artifact,
            download.destination,
            companion_archives=companion_archives,
            activate=activate,
        )
        return snapshot, installed

    def install_runtime(
        self,
        artifact: RuntimePackArtifact,
        archive: Path,
        *,
        companion_archives: dict[str, Path] | None = None,
        activate: bool = True,
    ) -> InstalledRuntimePack:
        installed = self.runtimes.install(artifact, archive, companion_archives=companion_archives)
        supervisor = LlamaCppSupervisor(Path(installed.executable))
        reported = supervisor.version()
        expected = artifact.version.removeprefix("b")
        if expected not in reported and artifact.source_revision[:7] not in reported:
            # The archive and files may be intact but not the version promised
            # by the signed catalog. Do not make it active.
            raise RuntimePackIntegrityError(
                f"llama.cpp executable reports an unexpected version: {reported[:200]}"
            )
        if activate:
            installed = self.activate_runtime(artifact.version, artifact.backend)
        return installed

    def activate_runtime(self, version: str, backend: RuntimeBackend) -> InstalledRuntimePack:
        if self._supervisor and self._supervisor.state not in {
            RuntimeState.STOPPED,
            RuntimeState.ABSENT,
            RuntimeState.FAILED,
        }:
            raise RuntimeError("unload the active model before changing runtime packs")
        previous = self.runtimes.active()
        installed = self.runtimes.activate(version, backend)
        if previous and (previous.version, previous.backend) != (version, backend):
            self._activation_history.append((previous.version, previous.backend))
        self._supervisor = None
        self._runtime_id = None
        return installed

    def rollback_runtime(self) -> InstalledRuntimePack:
        if self._supervisor and self._supervisor.state not in {
            RuntimeState.STOPPED,
            RuntimeState.ABSENT,
            RuntimeState.FAILED,
        }:
            raise RuntimeError("unload the active model before rolling back the runtime")
        while self._activation_history:
            version, backend = self._activation_history.pop()
            try:
                installed = self.runtimes.activate(version, backend)
            except (FileNotFoundError, RuntimePackIntegrityError):
                continue
            self._supervisor = None
            self._runtime_id = None
            return installed
        raise RuntimeError("no verified runtime rollback target is available")

    def remove_runtime(self, version: str, backend: RuntimeBackend) -> None:
        self.runtimes.remove(version, backend)

    async def download_model(
        self, artifact: ModelArtifact
    ) -> tuple[DownloadSnapshot, InstalledModel | None]:
        destination = artifact.target(self.models.root)
        self.begin_model_download(artifact)
        snapshot = await self.resume_download(artifact.id)
        if snapshot.state != DownloadState.COMPLETED:
            return snapshot, None
        return snapshot, self.models.register(artifact, destination)

    def begin_model_download(self, artifact: ModelArtifact) -> DownloadSnapshot:
        existing = self._downloads.get(artifact.id)
        if existing is not None:
            return existing.snapshot
        download = ModelDownload(artifact, artifact.target(self.models.root))
        self._downloads[artifact.id] = download
        return download.snapshot

    def begin_runtime_download(
        self,
        artifact: RuntimePackArtifact,
        *,
        accepted_license_urls: tuple[str, ...] = (),
    ) -> RuntimePackDownload:
        required = tuple(
            companion.license_url
            for companion in artifact.companions
            if companion.license_requires_acceptance
            and companion.license_url not in accepted_license_urls
        )
        if required:
            raise LicenseAcceptanceRequired(required)
        existing = self._downloads.get(artifact.id)
        if existing is not None:
            if not isinstance(existing, RuntimePackDownload):
                raise ValueError(f"artifact id is already used by a model download: {artifact.id}")
            return existing
        download = RuntimePackDownload(artifact, self.downloads / "runtime" / artifact.filename)
        self._downloads[artifact.id] = download
        return download

    def begin_runtime_companion_download(
        self, artifact: RuntimeCompanionArtifact
    ) -> RuntimePackDownload:
        existing = self._downloads.get(artifact.id)
        if existing is not None:
            if not isinstance(existing, RuntimePackDownload):
                raise ValueError(f"artifact id is already used by a model download: {artifact.id}")
            return existing
        download = RuntimePackDownload(artifact, self.downloads / "runtime" / artifact.filename)
        self._downloads[artifact.id] = download
        return download

    async def resume_download(self, artifact_id: str) -> DownloadSnapshot:
        download = self._downloads[artifact_id]
        if download.snapshot.state == DownloadState.COMPLETED:
            return download.snapshot
        return await download.run()

    def pause_download(self, artifact_id: str) -> DownloadSnapshot:
        download = self._downloads[artifact_id]
        download.pause()
        return download.snapshot

    def cancel_download(self, artifact_id: str) -> DownloadSnapshot:
        download = self._downloads[artifact_id]
        download.cancel()
        return download.snapshot

    def download_status(self, artifact_id: str) -> DownloadSnapshot:
        return self._downloads[artifact_id].snapshot

    def download_snapshots(self) -> tuple[DownloadSnapshot, ...]:
        return tuple(download.snapshot for download in self._downloads.values())

    def reset_download(self, artifact_id: str) -> None:
        download = self._downloads[artifact_id]
        if download.snapshot.state not in {
            DownloadState.COMPLETED,
            DownloadState.CANCELLED,
            DownloadState.FAILED,
        }:
            raise RuntimeError("only terminal downloads can be reset")
        download.partial.unlink(missing_ok=True)
        download.state_file.unlink(missing_ok=True)
        del self._downloads[artifact_id]

    def register_model(self, artifact: ModelArtifact, path: Path) -> InstalledModel:
        return self.models.register(artifact, path)

    async def load(
        self,
        model_id: str,
        *,
        config: LlamaServerConfig | None = None,
        timeout_seconds: float = 180.0,
    ) -> RuntimeEndpoint:
        model = self.models.get(model_id, verify=True)
        if not model.integrity_verified:
            raise RuntimePackIntegrityError("refusing to load a corrupt GGUF artifact")
        runtime = self.runtimes.active()
        if runtime is None:
            raise FileNotFoundError("no active Cupcake Local runtime pack")
        if not runtime.integrity_verified:
            raise RuntimePackIntegrityError("refusing to load with a corrupt runtime pack")
        selected = config or self._baseline_config(runtime.backend)
        selected.validate()
        if selected.context_size > model.context_window:
            raise ValueError(
                f"requested context {selected.context_size} exceeds "
                f"model limit {model.context_window}"
            )
        if self._supervisor is not None and self._supervisor.state not in {
            RuntimeState.STOPPED,
            RuntimeState.ABSENT,
            RuntimeState.FAILED,
        }:
            await self._supervisor.stop()
        supervisor = LlamaCppSupervisor(
            Path(runtime.executable),
            port=0,
            log_directory=self.root / "logs",
        )
        supervisor.start(
            Path(model.path),
            context_size=selected.context_size,
            gpu_layers=selected.gpu_layers,
            threads=selected.threads,
            device=selected.device,
            parallel=selected.parallel,
            batch_size=selected.batch_size,
            ubatch_size=selected.ubatch_size,
        )
        self._supervisor = supervisor
        self._runtime_id = runtime.id
        try:
            endpoint = await supervisor.wait_until_ready(timeout_seconds=timeout_seconds)
        except BaseException:
            await supervisor.stop()
            self._supervisor = None
            self._runtime_id = None
            raise
        return replace(
            endpoint,
            version=runtime.version,
            models=(model.id,),
            metadata={
                **endpoint.metadata,
                "backend": runtime.backend.value,
                "runtimeId": runtime.id,
                "modelPathPrivate": True,
            },
        )

    async def unload(self) -> RuntimeEndpoint:
        supervisor = self._supervisor
        if supervisor is not None:
            await supervisor.stop()
        self._supervisor = None
        self._runtime_id = None
        active = self.runtimes.active()
        return RuntimeEndpoint(
            id=f"{RuntimeKind.CUPCAKE_LLAMA_CPP.value}:managed",
            kind=RuntimeKind.CUPCAKE_LLAMA_CPP,
            base_url="",
            state=RuntimeState.STOPPED if active else RuntimeState.ABSENT,
            version=active.version if active else None,
            managed=True,
        )

    async def benchmark(self, *, max_tokens: int = 32) -> PerformanceMeasurement:
        supervisor = self._supervisor
        model_id = self._active_model_id()
        if supervisor is None or model_id is None or self._runtime_id is None:
            raise RuntimeError("load a verified model before running a benchmark")
        return await supervisor.benchmark(
            runtime_id=self._runtime_id,
            model_id=model_id,
            max_tokens=max_tokens,
        )

    def remove_model(self, model_id: str) -> None:
        self.models.remove(model_id, active_model_id=self._active_model_id())

    def version(self) -> str | None:
        active = self.runtimes.active()
        if active is None:
            return None
        supervisor = LlamaCppSupervisor(Path(active.executable))
        return supervisor.version()

    def devices(self) -> tuple[str, ...]:
        active = self.runtimes.active()
        if active is None:
            return ()
        supervisor = LlamaCppSupervisor(Path(active.executable))
        return supervisor.list_devices()

    async def close(self) -> None:
        await self.unload()

    def _active_model_id(self) -> str | None:
        supervisor = self._supervisor
        if supervisor is None or supervisor.active_model is None:
            return None
        active_path = supervisor.active_model.resolve()
        for model in self.models.list():
            if Path(model.path).resolve() == active_path:
                return model.id
        return None

    def _rehydrate_downloads(self) -> None:
        """Reconstruct crash-recoverable downloads after catalogs are restored."""

        if self._model_catalog is not None:
            for artifact in self._model_catalog.models:
                destination = artifact.target(self.models.root)
                self._rehydrate_one(artifact.id, ModelDownload(artifact, destination))
        if self._runtime_catalog is not None:
            for artifact in self._runtime_catalog.runtimes:
                destination = self.downloads / "runtime" / artifact.filename
                self._rehydrate_one(artifact.id, RuntimePackDownload(artifact, destination))
                for companion in artifact.companions:
                    companion_destination = self.downloads / "runtime" / companion.filename
                    self._rehydrate_one(
                        companion.id,
                        RuntimePackDownload(companion, companion_destination),
                    )

    def _rehydrate_one(self, artifact_id: str, download: CheckedDownload) -> None:
        if artifact_id in self._downloads:
            return
        if (
            download.state_file.is_file()
            or download.partial.is_file()
            or download.snapshot.state == DownloadState.COMPLETED
        ):
            self._downloads[artifact_id] = download

    @staticmethod
    def _baseline_config(backend: RuntimeBackend) -> LlamaServerConfig:
        if backend == RuntimeBackend.CPU:
            return LlamaServerConfig(gpu_layers=0, device="none", parallel=1)
        return LlamaServerConfig(gpu_layers="auto", device=None, parallel=1)


def run(coroutine: Any) -> Any:
    """Synchronous runtime-protocol adapter for desktop RPC handlers."""

    return asyncio.run(coroutine)
