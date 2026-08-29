"""Signed local-model catalog loading and artifact verification."""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlparse

from .types import (
    ModelArtifact,
    RuntimeBackend,
    RuntimeCompanionArtifact,
    RuntimePackArtifact,
)


class CatalogSignatureError(ValueError):
    pass


def canonical_json(payload: Mapping[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )


@dataclass(frozen=True, slots=True)
class SignedModelCatalog:
    version: int
    generated_at: str
    models: tuple[ModelArtifact, ...]
    key_id: str

    @classmethod
    def verify_and_load(
        cls, document: Mapping[str, Any], public_keys: Mapping[str, bytes]
    ) -> SignedModelCatalog:
        signature = document.get("signature")
        key_id = str(document.get("key_id", ""))
        payload = document.get("payload")
        if not signature or not key_id or not isinstance(payload, Mapping):
            raise CatalogSignatureError("catalog requires key_id, payload, and detached signature")
        try:
            public_key = public_keys[key_id]
        except KeyError as exc:
            raise CatalogSignatureError(f"untrusted catalog signing key: {key_id}") from exc
        try:
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

            Ed25519PublicKey.from_public_bytes(public_key).verify(
                base64.b64decode(signature, validate=True), canonical_json(payload)
            )
        except ImportError as exc:
            raise RuntimeError("signed catalogs require the cryptography package") from exc
        except Exception as exc:
            raise CatalogSignatureError("catalog signature verification failed") from exc
        models = tuple(ModelArtifact(**model) for model in payload.get("models", []))
        ids = [model.id for model in models]
        filenames = [model.filename for model in models]
        if len(ids) != len(set(ids)) or len(filenames) != len(set(filenames)):
            raise ValueError("catalog contains duplicate model ids or filenames")
        for model in models:
            if Path(model.filename).name != model.filename or not model.filename.endswith(".gguf"):
                raise ValueError(f"unsafe artifact filename: {model.filename!r}")
            if len(model.sha256) != 64 or any(
                character not in "0123456789abcdefABCDEF" for character in model.sha256
            ):
                raise ValueError(f"invalid SHA-256 for {model.id}")
            if not model.urls or any(urlparse(url).scheme != "https" for url in model.urls):
                raise ValueError(f"signed catalog URLs must use HTTPS for {model.id}")
        return cls(int(payload["version"]), str(payload["generated_at"]), models, key_id)

    def get(self, model_id: str) -> ModelArtifact:
        for model in self.models:
            if model.id == model_id:
                return model
        raise KeyError(model_id)


@dataclass(frozen=True, slots=True)
class SignedRuntimeCatalog:
    """Verified catalog of Windows llama.cpp runtime packs.

    CUPCAKEAGI owns the catalog signature. Upstream GitHub release artifacts
    are inputs to the release pipeline, but a mutable URL is never a trust
    decision at runtime.
    """

    version: int
    generated_at: str
    runtimes: tuple[RuntimePackArtifact, ...]
    key_id: str

    @classmethod
    def verify_and_load(
        cls, document: Mapping[str, Any], public_keys: Mapping[str, bytes]
    ) -> SignedRuntimeCatalog:
        signature, key_id, payload = _verify_signed_document(document, public_keys)
        del signature
        runtime_values = payload.get("runtimes", [])
        if not isinstance(runtime_values, list):
            raise ValueError("runtime catalog runtimes must be an array")
        runtimes: list[RuntimePackArtifact] = []
        runtimes_by_id: dict[str, RuntimePackArtifact] = {}
        for value in runtime_values:
            if not isinstance(value, Mapping):
                raise ValueError("runtime catalog entries must be objects")
            companions = tuple(
                RuntimeCompanionArtifact(
                    id=str(companion["id"]),
                    size_bytes=int(companion["size_bytes"]),
                    sha256=str(companion["sha256"]),
                    urls=tuple(str(item) for item in companion["urls"]),
                    filename=str(companion["filename"]),
                    files={
                        str(path): str(digest) for path, digest in dict(companion["files"]).items()
                    },
                    license=str(companion["license"]),
                    license_url=str(companion["license_url"]),
                    license_requires_acceptance=bool(
                        companion.get("license_requires_acceptance", False)
                    ),
                )
                for companion in value.get("companions", [])
            )
            files = {str(path): str(digest) for path, digest in dict(value["files"]).items()}
            inherited_id = value.get("inherits_files_from")
            if inherited_id is not None:
                try:
                    inherited = runtimes_by_id[str(inherited_id)]
                except KeyError as exc:
                    raise ValueError(
                        "runtime file inheritance references an unknown earlier entry: "
                        f"{inherited_id}"
                    ) from exc
                if inherited.version != str(value["version"]):
                    raise ValueError("runtime file inheritance must remain within one build")
                inherited_files = dict(inherited.files)
                collisions = {path.casefold() for path in inherited_files} & {
                    path.casefold() for path in files
                }
                if collisions:
                    raise ValueError("runtime file inheritance may not replace signed files")
                files = {**inherited_files, **files}
            runtime = RuntimePackArtifact(
                id=str(value["id"]),
                version=str(value["version"]),
                backend=RuntimeBackend(str(value["backend"])),
                platform=str(value["platform"]),
                architecture=str(value["architecture"]),
                size_bytes=int(value["size_bytes"]),
                sha256=str(value["sha256"]),
                urls=tuple(str(item) for item in value["urls"]),
                filename=str(value["filename"]),
                executable=str(value["executable"]),
                files=files,
                source_revision=str(value["source_revision"]),
                license=str(value.get("license", "MIT")),
                license_url=str(
                    value.get(
                        "license_url",
                        "https://github.com/ggml-org/llama.cpp/blob/master/LICENSE",
                    )
                ),
                companions=companions,
                hardware_compatibility=dict(value.get("hardware_compatibility", {})),
                prerequisites=tuple(str(item) for item in value.get("prerequisites", [])),
                bundled_by_default=bool(value.get("bundled_by_default", False)),
            )
            _validate_runtime(runtime)
            runtimes.append(runtime)
            runtimes_by_id[runtime.id] = runtime
        ids = [runtime.id for runtime in runtimes]
        coordinates = [(runtime.version, runtime.backend) for runtime in runtimes]
        if len(ids) != len(set(ids)) or len(coordinates) != len(set(coordinates)):
            raise ValueError("runtime catalog contains duplicate ids or version/backend pairs")
        return cls(int(payload["version"]), str(payload["generated_at"]), tuple(runtimes), key_id)

    def get(self, runtime_id: str) -> RuntimePackArtifact:
        for runtime in self.runtimes:
            if runtime.id == runtime_id:
                return runtime
        raise KeyError(runtime_id)


def _verify_signed_document(
    document: Mapping[str, Any], public_keys: Mapping[str, bytes]
) -> tuple[str, str, Mapping[str, Any]]:
    signature = document.get("signature")
    key_id = str(document.get("key_id", ""))
    payload = document.get("payload")
    if not signature or not key_id or not isinstance(payload, Mapping):
        raise CatalogSignatureError("catalog requires key_id, payload, and detached signature")
    try:
        public_key = public_keys[key_id]
    except KeyError as exc:
        raise CatalogSignatureError(f"untrusted catalog signing key: {key_id}") from exc
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        Ed25519PublicKey.from_public_bytes(public_key).verify(
            base64.b64decode(str(signature), validate=True), canonical_json(payload)
        )
    except ImportError as exc:
        raise RuntimeError("signed catalogs require the cryptography package") from exc
    except Exception as exc:
        raise CatalogSignatureError("catalog signature verification failed") from exc
    return str(signature), key_id, payload


def _safe_relative_file(value: str) -> bool:
    path = PurePosixPath(value)
    windows_reserved = {
        "con",
        "prn",
        "aux",
        "nul",
        *(f"com{number}" for number in range(1, 10)),
        *(f"lpt{number}" for number in range(1, 10)),
    }
    return (
        bool(value)
        and not value.startswith(("/", "\\"))
        and "\\" not in value
        and not any(character in value for character in '<>:"|?*\0')
        and not path.is_absolute()
        and ".." not in path.parts
        and all(
            part
            and not part.endswith((".", " "))
            and part.split(".", 1)[0].casefold() not in windows_reserved
            for part in path.parts
        )
    )


def _valid_sha256(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdefABCDEF" for character in value)


def _validate_runtime(runtime: RuntimePackArtifact) -> None:
    if runtime.platform != "windows" or runtime.architecture != "x64":
        raise ValueError("Cupcake Local runtime packs must target Windows x64")
    if (
        runtime.size_bytes <= 0
        or runtime.size_bytes > 8 * 1024 * 1024 * 1024
        or not _valid_sha256(runtime.sha256)
    ):
        raise ValueError(f"invalid archive integrity metadata for {runtime.id}")
    if (
        not _safe_relative_file(runtime.filename)
        or "/" in runtime.filename
        or not runtime.filename.endswith(".zip")
    ):
        raise ValueError(f"unsafe runtime archive filename: {runtime.filename!r}")
    if not runtime.urls or any(urlparse(url).scheme != "https" for url in runtime.urls):
        raise ValueError(f"signed runtime URLs must use HTTPS for {runtime.id}")
    if not _safe_relative_file(runtime.executable) or not runtime.executable.lower().endswith(
        ".exe"
    ):
        raise ValueError(f"unsafe runtime executable path: {runtime.executable!r}")
    if runtime.executable not in runtime.files:
        raise ValueError(f"runtime manifest does not cover executable: {runtime.executable!r}")
    if not runtime.files:
        raise ValueError("runtime manifest must contain files")
    folded_paths = [path.casefold() for path in runtime.files]
    if len(folded_paths) != len(set(folded_paths)):
        raise ValueError("runtime manifest contains case-colliding Windows paths")
    for path, digest in runtime.files.items():
        if not _safe_relative_file(path) or not _valid_sha256(digest):
            raise ValueError(f"invalid runtime file integrity metadata: {path!r}")
    companion_ids: set[str] = set()
    companion_filenames: set[str] = set()
    combined_paths = set(folded_paths)
    for companion in runtime.companions:
        if companion.id in companion_ids or companion.filename in companion_filenames:
            raise ValueError("runtime catalog contains duplicate companion archives")
        companion_ids.add(companion.id)
        companion_filenames.add(companion.filename)
        if (
            companion.size_bytes <= 0
            or companion.size_bytes > 8 * 1024 * 1024 * 1024
            or not _valid_sha256(companion.sha256)
        ):
            raise ValueError(f"invalid companion archive metadata: {companion.id}")
        if (
            not _safe_relative_file(companion.filename)
            or "/" in companion.filename
            or not companion.filename.endswith(".zip")
        ):
            raise ValueError(f"unsafe companion archive filename: {companion.filename!r}")
        if not companion.urls or any(urlparse(url).scheme != "https" for url in companion.urls):
            raise ValueError(f"signed companion URLs must use HTTPS for {companion.id}")
        if not companion.files:
            raise ValueError(f"companion archive manifest is empty: {companion.id}")
        for path, digest in companion.files.items():
            folded = path.casefold()
            if folded in combined_paths:
                raise ValueError(f"runtime archives contain colliding file path: {path!r}")
            combined_paths.add(folded)
            if not _safe_relative_file(path) or not _valid_sha256(digest):
                raise ValueError(f"invalid companion file integrity metadata: {path!r}")
        if not companion.license.strip() or urlparse(companion.license_url).scheme != "https":
            raise ValueError(f"companion archive requires license provenance: {companion.id}")
    if runtime.backend != RuntimeBackend.CPU and not runtime.hardware_compatibility:
        raise ValueError("acceleration packs require hardware compatibility metadata")
    if runtime.backend != RuntimeBackend.CPU and not runtime.prerequisites:
        raise ValueError("acceleration packs require explicit prerequisites")


def sha256_file(path: Path, *, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def verify_artifact(path: Path, artifact: ModelArtifact) -> None:
    if not path.is_file():
        raise FileNotFoundError(path)
    if path.stat().st_size != artifact.size_bytes:
        raise ValueError(f"size mismatch for {artifact.id}")
    actual = sha256_file(path)
    if actual.lower() != artifact.sha256.lower():
        raise ValueError(f"checksum mismatch for {artifact.id}")
