from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path
from typing import Any, cast
from uuid import UUID

import pytest

from cupcake_runtime.backup.portable import (
    MANIFEST_PATH,
    NONPORTABLE_DPAPI_NOTICE,
    PortablePassphraseProtection,
    SameUserDpapiProtection,
    authenticated_metadata,
    inspect_archive,
    validate_manifest_bytes,
)
from cupcake_runtime.domain.errors import IntegrityViolation

BACKUP_ID = UUID("018f47bc-7f0c-7a3d-8b9f-1234567890ab")
PRODUCT_VERSION = "2.0.0-rc.1"


def _entry(path: str, role: str, body: bytes, *, object_id: str | None = None) -> dict[str, object]:
    entry: dict[str, object] = {
        "path": path,
        "role": role,
        "sha256": hashlib.sha256(body).hexdigest(),
        "byteSize": len(body),
    }
    if object_id is not None:
        entry["objectId"] = object_id
    return entry


def _envelope() -> dict[str, object]:
    aad_hash = hashlib.sha256(authenticated_metadata(BACKUP_ID, PRODUCT_VERSION)).hexdigest()
    return {
        "format": "cupcake-profile-key-envelope",
        "formatVersion": 1,
        "cipher": "aes-256-gcm",
        "kdf": {
            "algorithm": "argon2id",
            "version": 19,
            "memoryKiB": 32768,
            "iterations": 2,
            "parallelism": 1,
            "outputBytes": 32,
            "saltBase64": "AwMDAwMDAwMDAwMDAwMDAw",
        },
        "nonceBase64": "BQUFBQUFBQUFBQUF",
        "wrappedKeyBase64": "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH",
        "aadSha256": aad_hash,
    }


def _payloads() -> dict[str, bytes]:
    object_id = "b" * 64
    return {
        "database/product.sqlite": b"product snapshot",
        "database/dbos.sqlite": b"dbos snapshot",
        "database/security.sqlite": b"security snapshot without credentials",
        f"objects/{object_id}.cupobj": b"encrypted reachable object",
    }


def _manifest(*, portable: bool = True) -> dict[str, object]:
    payloads = _payloads()
    roles = {
        "database/product.sqlite": "productDatabase",
        "database/dbos.sqlite": "dbosDatabase",
        "database/security.sqlite": "securityDatabase",
    }
    entries: list[dict[str, object]] = []
    for path, body in payloads.items():
        if path.startswith("objects/"):
            entries.append(_entry(path, "encryptedObject", body, object_id="b" * 64))
        else:
            entries.append(_entry(path, roles[path], body))
    protection: dict[str, object]
    if portable:
        protection = {
            "mode": "passphrase-portable",
            "crossUser": True,
            "keyEnvelope": _envelope(),
        }
    else:
        protection = {
            "mode": "windows-dpapi-current-user",
            "crossUser": False,
            "notice": NONPORTABLE_DPAPI_NOTICE,
        }
    return {
        "format": "cupcake-portable-backup",
        "formatVersion": 1,
        "backupId": str(BACKUP_ID),
        "productVersion": PRODUCT_VERSION,
        "createdAt": "2026-08-28T12:00:00Z",
        "protection": protection,
        "entries": entries,
    }


def _archive(path: Path, manifest: dict[str, object], payloads: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(MANIFEST_PATH, json.dumps(manifest, separators=(",", ":")))
        for name, body in payloads.items():
            archive.writestr(name, body)


def test_accepts_rust_shaped_portable_manifest_and_binary_aad() -> None:
    manifest = validate_manifest_bytes(json.dumps(_manifest()).encode())
    assert manifest.is_cross_user_portable
    assert isinstance(manifest.protection, PortablePassphraseProtection)
    assert authenticated_metadata(BACKUP_ID, PRODUCT_VERSION).hex() == (
        "43555043414b4541474900706f727461626c652d6261636b75702d6b65792d656e76656c6f7065"
        "00763100018f47bc7f0c7a3d8b9f1234567890ab0000000a322e302e302d72632e31"
    )


def test_inspects_all_snapshot_and_reachable_object_digests(tmp_path: Path) -> None:
    archive = tmp_path / "portable.cupcake-backup"
    _archive(archive, _manifest(), _payloads())
    inspection = inspect_archive(archive)
    assert inspection.verified_entries == 4
    assert inspection.total_bytes == sum(map(len, _payloads().values()))


def test_wrong_metadata_or_tampered_payload_fails_closed(tmp_path: Path) -> None:
    changed = _manifest()
    changed["productVersion"] = "2.0.0-final"
    with pytest.raises(IntegrityViolation):
        validate_manifest_bytes(json.dumps(changed).encode())

    archive = tmp_path / "tampered.cupcake-backup"
    payloads = _payloads()
    _archive(archive, _manifest(), {**payloads, "database/product.sqlite": b"tampered"})
    with pytest.raises(IntegrityViolation):
        inspect_archive(archive)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("memoryKiB", 262145),
        ("memoryKiB", 1024),
        ("iterations", 9),
        ("parallelism", 5),
    ],
)
def test_rejects_unsafe_argon2_work_factors(field: str, value: int) -> None:
    manifest = _manifest()
    protection = manifest["protection"]
    assert isinstance(protection, dict)
    protection = cast(dict[str, Any], protection)
    envelope = protection["keyEnvelope"]
    assert isinstance(envelope, dict)
    envelope = cast(dict[str, Any], envelope)
    kdf = envelope["kdf"]
    assert isinstance(kdf, dict)
    kdf = cast(dict[str, Any], kdf)
    kdf[field] = value
    with pytest.raises(IntegrityViolation):
        validate_manifest_bytes(json.dumps(manifest).encode())


def test_dpapi_mode_is_explicitly_nonportable() -> None:
    manifest = validate_manifest_bytes(json.dumps(_manifest(portable=False)).encode())
    assert not manifest.is_cross_user_portable
    assert isinstance(manifest.protection, SameUserDpapiProtection)
    assert manifest.protection.notice == NONPORTABLE_DPAPI_NOTICE


def test_rejects_unknown_fields_missing_snapshots_and_unsafe_paths() -> None:
    unknown = _manifest()
    unknown["futureField"] = True
    with pytest.raises(IntegrityViolation):
        validate_manifest_bytes(json.dumps(unknown).encode())

    missing_dbos = _manifest()
    entries = missing_dbos["entries"]
    assert isinstance(entries, list)
    entries = cast(list[dict[str, object]], entries)
    missing_dbos["entries"] = [entry for entry in entries if entry["role"] != "dbosDatabase"]
    with pytest.raises(IntegrityViolation):
        validate_manifest_bytes(json.dumps(missing_dbos).encode())

    traversal = _manifest()
    traversal_entries = traversal["entries"]
    assert isinstance(traversal_entries, list)
    traversal_entries = cast(list[dict[str, object]], traversal_entries)
    traversal_entries[0]["path"] = "../product.sqlite"
    with pytest.raises(IntegrityViolation):
        validate_manifest_bytes(json.dumps(traversal).encode())
