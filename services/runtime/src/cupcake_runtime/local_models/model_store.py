"""Installed GGUF registry backed by immutable signed catalog metadata."""

from __future__ import annotations

import json
import os
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

from .catalog import verify_artifact
from .types import InstalledModel, ModelArtifact


class ModelInUseError(RuntimeError):
    pass


class InstalledModelStore:
    def __init__(self, root: Path):
        self.root = root
        self.manifests = root / ".manifests"

    def register(self, artifact: ModelArtifact, path: Path) -> InstalledModel:
        expected = artifact.target(self.root)
        if path.resolve() != expected.resolve():
            raise ValueError("model must be installed at its catalog-owned destination")
        verify_artifact(path, artifact)
        model = InstalledModel(
            id=artifact.id,
            display_name=artifact.display_name,
            filename=artifact.filename,
            path=str(path),
            size_bytes=artifact.size_bytes,
            sha256=artifact.sha256.lower(),
            quantization=artifact.quantization,
            context_window=artifact.context_window,
            license=artifact.license,
            installed_at=datetime.now(UTC).isoformat(),
            integrity_verified=True,
        )
        self._write_manifest(model)
        return model

    def get(self, model_id: str, *, verify: bool = True) -> InstalledModel:
        path = self._manifest_path(model_id)
        value = json.loads(path.read_text(encoding="utf-8"))
        model = InstalledModel(**value)
        integrity = self.verify(model) if verify else model.integrity_verified
        return InstalledModel(**{**asdict(model), "integrity_verified": integrity})

    def list(self, *, verify: bool = False) -> tuple[InstalledModel, ...]:
        if not self.manifests.is_dir():
            return ()
        models: list[InstalledModel] = []
        for path in sorted(self.manifests.glob("*.json")):
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
                model = InstalledModel(**value)
                integrity = self.verify(model) if verify else Path(model.path).is_file()
                models.append(InstalledModel(**{**asdict(model), "integrity_verified": integrity}))
            except (OSError, TypeError, ValueError, json.JSONDecodeError):
                continue
        return tuple(models)

    def verify(self, model: InstalledModel) -> bool:
        path = Path(model.path)
        try:
            return (
                path.resolve().parent == self.root.resolve()
                and path.name == model.filename
                and path.is_file()
                and path.stat().st_size == model.size_bytes
                and self._sha256(path).lower() == model.sha256.lower()
            )
        except OSError:
            return False

    def remove(self, model_id: str, *, active_model_id: str | None = None) -> None:
        if model_id == active_model_id:
            raise ModelInUseError("unload the active model before removing it")
        model = self.get(model_id, verify=False)
        Path(model.path).unlink(missing_ok=True)
        self._manifest_path(model_id).unlink(missing_ok=True)

    def _manifest_path(self, model_id: str) -> Path:
        # Catalog ids are opaque product identifiers, so the filename is a
        # digest instead of interpolating an untrusted id into a path.
        import hashlib

        return self.manifests / f"{hashlib.sha256(model_id.encode()).hexdigest()}.json"

    def _write_manifest(self, model: InstalledModel) -> None:
        self.manifests.mkdir(parents=True, exist_ok=True)
        destination = self._manifest_path(model.id)
        temporary = destination.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(asdict(model), indent=2, sort_keys=True), encoding="utf-8")
        os.replace(temporary, destination)

    @staticmethod
    def _sha256(path: Path) -> str:
        from .catalog import sha256_file

        return sha256_file(path)
