import base64
import json
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from cupcake_runtime.local_models.catalog import (
    CatalogSignatureError,
    PinnedCatalogTrustStore,
    SignedModelCatalog,
    canonical_json,
    load_pinned_catalog_bundle,
    verify_artifact,
)


def _payload(sha256: str, size: int) -> dict[str, Any]:
    return {
        "version": 1,
        "generated_at": "2026-08-28T00:00:00Z",
        "models": [
            {
                "id": "tiny:q4",
                "display_name": "Tiny",
                "family": "tiny",
                "parameter_billions": 1.0,
                "quantization": "Q4_K_M",
                "size_bytes": size,
                "sha256": sha256,
                "urls": ["https://example.invalid/tiny.gguf"],
                "filename": "tiny.gguf",
                "license": "Apache-2.0",
                "license_url": "https://example.invalid/license",
                "context_window": 4096,
                "architecture": "qwen2",
                "min_runtime_version": "b10679",
                "source": "Hugging Face test fixture",
                "source_revision": "0123456789abcdef",
                "context_choices": [2048, 4096],
                "capability_tags": ["text", "tools"],
                "task_tags": ["chat"],
                "runtime_requirements": ["llama.cpp test build or newer"],
            }
        ],
    }


def test_signed_catalog_and_artifact_checksum(tmp_path: Path) -> None:
    data = b"gguf fixture"
    import hashlib

    payload = _payload(hashlib.sha256(data).hexdigest(), len(data))
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes_raw()
    signature = base64.b64encode(private.sign(canonical_json(payload))).decode()
    catalog = SignedModelCatalog.verify_and_load(
        {"key_id": "test", "payload": payload, "signature": signature}, {"test": public}
    )
    path = tmp_path / "tiny.gguf"
    path.write_bytes(data)
    verify_artifact(path, catalog.get("tiny:q4"))


def test_catalog_tampering_is_rejected() -> None:
    private = Ed25519PrivateKey.generate()
    payload = _payload("0" * 64, 0)
    signature = base64.b64encode(private.sign(canonical_json(payload))).decode()
    payload["version"] = 2
    with pytest.raises(CatalogSignatureError):
        SignedModelCatalog.verify_and_load(
            {"key_id": "test", "payload": payload, "signature": signature},
            {"test": private.public_key().public_bytes_raw()},
        )


def test_pinned_catalog_bundle_reads_only_packaged_trust_store(tmp_path: Path) -> None:
    data = b"catalog artifact"
    import hashlib

    private = Ed25519PrivateKey.generate()
    payload = _payload(hashlib.sha256(data).hexdigest(), len(data))
    document = {
        "key_id": "packaged-test",
        "payload": payload,
        "signature": base64.b64encode(private.sign(canonical_json(payload))).decode(),
    }
    (tmp_path / "cupcake-local-public-keys.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "environment": "unit-test",
                "productionTrustRoot": False,
                "minimumCatalogVersions": {"models": 1, "runtimes": 1},
                "keys": {
                    "packaged-test": base64.b64encode(
                        private.public_key().public_bytes_raw()
                    ).decode()
                },
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "cupcake-local-models-v1.json").write_text(json.dumps(document), encoding="utf-8")

    bundle = load_pinned_catalog_bundle(
        tmp_path,
        expected_environment="unit-test",
        require_models=True,
        require_runtimes=False,
    )

    assert bundle.models is not None
    assert bundle.models.get("tiny:q4").source_revision == "0123456789abcdef"
    assert bundle.runtimes is None


def test_pinned_catalog_rejects_non_ed25519_key(tmp_path: Path) -> None:
    (tmp_path / "cupcake-local-public-keys.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "environment": "unit-test",
                "productionTrustRoot": False,
                "minimumCatalogVersions": {"models": 2, "runtimes": 1},
                "keys": {"short": base64.b64encode(b"too short").decode()},
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="Ed25519"):
        PinnedCatalogTrustStore.from_packaged_directory(tmp_path)


def test_pinned_catalog_rejects_version_rollback(tmp_path: Path) -> None:
    private = Ed25519PrivateKey.generate()
    payload = _payload("0" * 64, 10)
    document = {
        "key_id": "test",
        "payload": payload,
        "signature": base64.b64encode(private.sign(canonical_json(payload))).decode(),
    }
    (tmp_path / "cupcake-local-public-keys.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "environment": "unit-test",
                "productionTrustRoot": False,
                "minimumCatalogVersions": {"models": 2, "runtimes": 1},
                "keys": {
                    "test": base64.b64encode(private.public_key().public_bytes_raw()).decode()
                },
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "cupcake-local-models-v1.json").write_text(json.dumps(document), encoding="utf-8")

    with pytest.raises(ValueError, match="older than pinned minimum"):
        load_pinned_catalog_bundle(
            tmp_path,
            expected_environment="unit-test",
            require_runtimes=False,
        )


def test_signed_model_catalog_rejects_unknown_or_unsafe_metadata() -> None:
    private = Ed25519PrivateKey.generate()
    payload = _payload("0" * 64, 10)
    payload["models"][0]["surprise"] = "not allowed"
    document = {
        "key_id": "test",
        "payload": payload,
        "signature": base64.b64encode(private.sign(canonical_json(payload))).decode(),
    }
    with pytest.raises(ValueError, match="unknown fields"):
        SignedModelCatalog.verify_and_load(
            document, {"test": private.public_key().public_bytes_raw()}
        )
