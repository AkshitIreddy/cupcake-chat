import base64
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from cupcake_runtime.local_models.catalog import (
    CatalogSignatureError,
    SignedModelCatalog,
    canonical_json,
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
