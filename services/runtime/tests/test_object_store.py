from pathlib import Path

import pytest

from cupcake_runtime.object_store.store import EncryptedObjectStore, ObjectCorruptionError


def test_objects_are_encrypted_deduplicated_and_verified(tmp_path: Path) -> None:
    store = EncryptedObjectStore(tmp_path / "objects", b"o" * 32)
    content = b"private cupcake artifact\x00" * 100
    first = store.put(content)
    second = store.put(content)
    assert first == second
    assert list(store.iter_ids()) == [first]
    assert store.get(first) == content
    assert content not in store.path_for(first).read_bytes()
    assert store.verify(first) == len(content)


def test_tampered_object_fails_authentication(tmp_path: Path) -> None:
    store = EncryptedObjectStore(tmp_path / "objects", b"o" * 32)
    object_id = store.put(b"hello")
    path = store.path_for(object_id)
    payload = bytearray(path.read_bytes())
    payload[-1] ^= 1
    path.write_bytes(payload)
    with pytest.raises(ObjectCorruptionError, match="authentication"):
        store.get(object_id)


def test_object_ids_cannot_escape_store(tmp_path: Path) -> None:
    store = EncryptedObjectStore(tmp_path / "objects", b"o" * 32)
    with pytest.raises(ValueError):
        store.path_for("../outside")


def test_referenced_objects_cannot_be_garbage_collected(tmp_path: Path) -> None:
    store = EncryptedObjectStore(tmp_path / "objects", b"o" * 32)
    object_id = store.put(b"keep me")
    with pytest.raises(PermissionError):
        store.delete_unreferenced(object_id, referenced_ids={object_id})
    assert store.delete_unreferenced(object_id, referenced_ids=set())
    assert not store.exists(object_id)
