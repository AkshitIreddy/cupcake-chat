"""Signed local-model catalog loading and artifact verification."""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, cast
from urllib.parse import urlparse

from .types import (
    ModelArtifact,
    RuntimeBackend,
    RuntimeCompanionArtifact,
    RuntimePackArtifact,
)


class CatalogSignatureError(ValueError):
    pass


MODEL_CATALOG_FILENAME = "cupcake-local-models-v1.json"
RUNTIME_CATALOG_FILENAME = "cupcake-local-runtime-v1.json"
CATALOG_TRUST_FILENAME = "cupcake-local-public-keys.json"


@dataclass(frozen=True, slots=True)
class PinnedCatalogTrustStore:
    """Trust roots loaded from a host-selected packaged resource directory.

    This type deliberately has no constructor that accepts base64 keys from a
    product request. The high-level loader below reads fixed filenames from a
    directory already selected by the trusted desktop host.
    """

    environment: str
    production_trust_root: bool
    keys: Mapping[str, bytes]
    minimum_model_catalog_version: int = 1
    minimum_runtime_catalog_version: int = 1

    @classmethod
    def from_packaged_directory(
        cls,
        directory: Path,
        *,
        expected_environment: str | None = None,
        require_production: bool = False,
    ) -> PinnedCatalogTrustStore:
        path = directory / CATALOG_TRUST_FILENAME
        value = _string_mapping(
            json.loads(path.read_text(encoding="utf-8")), context="catalog trust store"
        )
        if int(value.get("schemaVersion", 1)) != 1:
            raise ValueError("unsupported catalog trust-store schema")
        environment = str(value.get("environment", ""))
        if not environment:
            raise ValueError("catalog trust store requires an environment")
        if expected_environment is not None and environment != expected_environment:
            raise ValueError("catalog trust-store environment does not match the packaged app")
        production = value.get("productionTrustRoot")
        if not isinstance(production, bool):
            raise ValueError("catalog trust store must declare productionTrustRoot")
        if require_production and not production:
            raise ValueError("a production catalog trust root is required")
        encoded_keys = _string_dictionary(value.get("keys"), context="catalog trust keys")
        if not encoded_keys or len(encoded_keys) > 16:
            raise ValueError("catalog trust store must contain 1 to 16 keys")
        keys: dict[str, bytes] = {}
        for key_id, encoded in encoded_keys.items():
            if not key_id or len(key_id) > 128:
                raise ValueError("catalog signing key id is invalid")
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, TypeError) as exc:
                raise ValueError(f"catalog public key is not valid base64: {key_id}") from exc
            if len(raw) != 32:
                raise ValueError(f"catalog public key must be an Ed25519 key: {key_id}")
            keys[key_id] = raw
        minimums = _string_mapping(
            value.get("minimumCatalogVersions", {}), context="minimum catalog versions"
        )
        model_minimum = int(minimums.get("models", 1))
        runtime_minimum = int(minimums.get("runtimes", 1))
        if model_minimum < 1 or runtime_minimum < 1:
            raise ValueError("minimum catalog versions must be positive")
        return cls(environment, production, keys, model_minimum, runtime_minimum)


@dataclass(frozen=True, slots=True)
class PinnedCatalogBundle:
    trust: PinnedCatalogTrustStore
    models: SignedModelCatalog | None
    runtimes: SignedRuntimeCatalog | None


def load_pinned_catalog_bundle(
    directory: Path,
    *,
    expected_environment: str | None = None,
    require_production: bool = False,
    require_models: bool = True,
    require_runtimes: bool = True,
) -> PinnedCatalogBundle:
    """Load only the known catalog resources beside a pinned trust-root file."""

    trust = PinnedCatalogTrustStore.from_packaged_directory(
        directory,
        expected_environment=expected_environment,
        require_production=require_production,
    )
    model_path = directory / MODEL_CATALOG_FILENAME
    runtime_path = directory / RUNTIME_CATALOG_FILENAME
    if require_models and not model_path.is_file():
        raise FileNotFoundError(model_path)
    if require_runtimes and not runtime_path.is_file():
        raise FileNotFoundError(runtime_path)
    models = (
        SignedModelCatalog.verify_and_load(
            _read_catalog_document(model_path),
            trust.keys,
            minimum_version=trust.minimum_model_catalog_version,
        )
        if model_path.is_file()
        else None
    )
    runtimes = (
        SignedRuntimeCatalog.verify_and_load(
            _read_catalog_document(runtime_path),
            trust.keys,
            minimum_version=trust.minimum_runtime_catalog_version,
        )
        if runtime_path.is_file()
        else None
    )
    return PinnedCatalogBundle(trust, models, runtimes)


def _read_catalog_document(path: Path) -> Mapping[str, Any]:
    return _string_mapping(json.loads(path.read_text(encoding="utf-8")), context=path.name)


def _string_mapping(value: object, *, context: str) -> Mapping[str, Any]:
    """Validate the object boundary before using dynamic signed-catalog fields."""

    if not isinstance(value, Mapping):
        raise ValueError(f"{context} must be an object")
    mapping = cast(Mapping[object, object], value)
    if not all(isinstance(key, str) for key in mapping):
        raise ValueError(f"{context} keys must be strings")
    return cast(Mapping[str, Any], mapping)


def _object_sequence(value: object, *, context: str) -> tuple[Mapping[str, Any], ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise ValueError(f"{context} must be an array")
    items = cast(Sequence[object], value)
    return tuple(_string_mapping(item, context=f"{context} entry") for item in items)


def _string_dictionary(value: object, *, context: str) -> dict[str, str]:
    mapping = _string_mapping(value, context=context)
    if not all(isinstance(item, str) for item in mapping.values()):
        raise ValueError(f"{context} values must be strings")
    return {key: cast(str, item) for key, item in mapping.items()}


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
        cls,
        document: Mapping[str, Any],
        public_keys: Mapping[str, bytes],
        *,
        minimum_version: int = 1,
    ) -> SignedModelCatalog:
        _signature, key_id, payload = _verify_signed_document(document, public_keys)
        version, generated_at = _validate_catalog_header(payload, minimum_version=minimum_version)
        models = tuple(
            _parse_model_artifact(model)
            for model in _object_sequence(payload.get("models", ()), context="catalog models")
        )
        if not models:
            raise ValueError("model catalog must contain at least one installable model")
        ids = [model.id for model in models]
        filenames = [model.filename for model in models]
        if len(ids) != len(set(ids)) or len({name.casefold() for name in filenames}) != len(
            filenames
        ):
            raise ValueError("catalog contains duplicate model ids or filenames")
        return cls(version, generated_at, models, key_id)

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
        cls,
        document: Mapping[str, Any],
        public_keys: Mapping[str, bytes],
        *,
        minimum_version: int = 1,
    ) -> SignedRuntimeCatalog:
        signature, key_id, payload = _verify_signed_document(document, public_keys)
        del signature
        version, generated_at = _validate_catalog_header(payload, minimum_version=minimum_version)
        runtime_values = _object_sequence(
            payload.get("runtimes", ()), context="runtime catalog runtimes"
        )
        runtimes: list[RuntimePackArtifact] = []
        runtimes_by_id: dict[str, RuntimePackArtifact] = {}
        for value in runtime_values:
            companions = tuple(
                RuntimeCompanionArtifact(
                    id=str(companion["id"]),
                    size_bytes=int(companion["size_bytes"]),
                    sha256=str(companion["sha256"]),
                    urls=tuple(str(item) for item in companion["urls"]),
                    filename=str(companion["filename"]),
                    files=_string_dictionary(companion["files"], context="runtime companion files"),
                    license=str(companion["license"]),
                    license_url=str(companion["license_url"]),
                    license_requires_acceptance=bool(
                        companion.get("license_requires_acceptance", False)
                    ),
                )
                for companion in _object_sequence(
                    value.get("companions", ()), context="runtime companions"
                )
            )
            files = _string_dictionary(value["files"], context="runtime files")
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
                hardware_compatibility=dict(
                    _string_mapping(
                        value.get("hardware_compatibility", {}),
                        context="runtime hardware compatibility",
                    )
                ),
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
        return cls(version, generated_at, tuple(runtimes), key_id)

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
    raw_payload = document.get("payload")
    if not signature or not key_id or not isinstance(raw_payload, Mapping):
        raise CatalogSignatureError("catalog requires key_id, payload, and detached signature")
    payload = _string_mapping(cast(object, raw_payload), context="catalog payload")
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


def _validate_catalog_header(
    payload: Mapping[str, Any], *, minimum_version: int
) -> tuple[int, str]:
    version = int(payload.get("version", 0))
    if version < minimum_version:
        raise ValueError(
            f"catalog version {version} is older than pinned minimum {minimum_version}"
        )
    generated_at = str(payload.get("generated_at", ""))
    try:
        parsed = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("catalog generated_at must be an RFC 3339 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("catalog generated_at must include a UTC offset")
    return version, generated_at


def _parse_model_artifact(value: Mapping[str, Any]) -> ModelArtifact:
    allowed = {
        "id",
        "display_name",
        "family",
        "parameter_billions",
        "quantization",
        "size_bytes",
        "sha256",
        "urls",
        "filename",
        "license",
        "license_url",
        "context_window",
        "architecture",
        "min_runtime_version",
        "metadata",
        "source",
        "source_revision",
        "context_choices",
        "capability_tags",
        "task_tags",
        "runtime_requirements",
    }
    unknown = set(value) - allowed
    if unknown:
        raise ValueError(f"model catalog entry contains unknown fields: {sorted(unknown)!r}")
    required = {
        "id",
        "display_name",
        "family",
        "parameter_billions",
        "quantization",
        "size_bytes",
        "sha256",
        "urls",
        "filename",
        "license",
        "license_url",
        "context_window",
        "architecture",
        "min_runtime_version",
        "source",
        "source_revision",
        "context_choices",
        "capability_tags",
        "task_tags",
        "runtime_requirements",
    }
    missing = required - set(value)
    if missing:
        raise ValueError(f"model catalog entry is missing fields: {sorted(missing)!r}")
    metadata = _string_mapping(value.get("metadata", {}), context="model metadata")
    artifact = ModelArtifact(
        id=str(value["id"]),
        display_name=str(value["display_name"]),
        family=str(value["family"]),
        parameter_billions=float(value["parameter_billions"]),
        quantization=str(value["quantization"]),
        size_bytes=int(value["size_bytes"]),
        sha256=str(value["sha256"]),
        urls=tuple(str(item) for item in value["urls"]),
        filename=str(value["filename"]),
        license=str(value["license"]),
        license_url=str(value["license_url"]),
        context_window=int(value["context_window"]),
        architecture=str(value["architecture"]),
        min_runtime_version=(
            str(value["min_runtime_version"])
            if value.get("min_runtime_version") is not None
            else None
        ),
        metadata=dict(metadata),
        source=str(value["source"]),
        source_revision=str(value["source_revision"]),
        context_choices=tuple(int(item) for item in value["context_choices"]),
        capability_tags=tuple(str(item) for item in value["capability_tags"]),
        task_tags=tuple(str(item) for item in value["task_tags"]),
        runtime_requirements=tuple(str(item) for item in value["runtime_requirements"]),
    )
    _validate_model(artifact)
    return artifact


def _validate_model(model: ModelArtifact) -> None:
    if not model.id.strip() or len(model.id) > 255:
        raise ValueError("model id must contain 1 to 255 characters")
    if not model.display_name.strip() or not model.family.strip() or not model.source.strip():
        raise ValueError(f"model identity metadata is incomplete: {model.id}")
    if not model.source_revision or len(model.source_revision) > 255:
        raise ValueError(f"model source revision is required: {model.id}")
    if not 0 < model.parameter_billions <= 1_000:
        raise ValueError(f"model parameter count is outside safe bounds: {model.id}")
    if not model.quantization.strip() or len(model.quantization) > 64:
        raise ValueError(f"model quantization is invalid: {model.id}")
    if not 0 < model.size_bytes <= 1024 * 1024 * 1024 * 1024:
        raise ValueError(f"model size is outside safe bounds: {model.id}")
    if not _valid_sha256(model.sha256):
        raise ValueError(f"invalid SHA-256 for {model.id}")
    if (
        not _safe_relative_file(model.filename)
        or "/" in model.filename
        or not model.filename.casefold().endswith(".gguf")
    ):
        raise ValueError(f"unsafe artifact filename: {model.filename!r}")
    if not model.urls or len(model.urls) > 8:
        raise ValueError(f"model catalog requires 1 to 8 mirrors: {model.id}")
    for url in model.urls:
        parsed = urlparse(url)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.fragment
        ):
            raise ValueError(f"signed catalog URLs must be clean HTTPS URLs for {model.id}")
    if not model.license.strip() or urlparse(model.license_url).scheme != "https":
        raise ValueError(f"model license provenance is invalid: {model.id}")
    if not model.architecture.strip() or len(model.architecture) > 128:
        raise ValueError(f"model architecture is invalid: {model.id}")
    if not model.min_runtime_version or len(model.min_runtime_version) > 128:
        raise ValueError(f"model minimum runtime version is required: {model.id}")
    if not 512 <= model.context_window <= 2_097_152:
        raise ValueError(f"model context window is outside safe bounds: {model.id}")
    if (
        not model.context_choices
        or len(model.context_choices) > 16
        or tuple(sorted(set(model.context_choices))) != model.context_choices
        or any(choice < 512 or choice > model.context_window for choice in model.context_choices)
    ):
        raise ValueError(f"model context choices are invalid: {model.id}")
    if not model.capability_tags or not model.task_tags or not model.runtime_requirements:
        raise ValueError(
            f"model capabilities, tasks, and runtime requirements are required: {model.id}"
        )
    for label in (*model.capability_tags, *model.task_tags, *model.runtime_requirements):
        if not label.strip() or len(label) > 128:
            raise ValueError(f"model catalog tag is invalid: {model.id}")


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
