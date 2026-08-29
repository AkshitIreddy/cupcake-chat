from __future__ import annotations

import hashlib
import os
import tempfile
from collections.abc import Collection, Iterator
from contextlib import contextmanager, suppress
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"CUPOBJ\x01"
NONCE_SIZE = 12
TAG_SIZE = 16


class ObjectCorruptionError(RuntimeError):
    pass


class EncryptedObjectStore:
    """Immutable AES-GCM object store addressed by plaintext SHA-256."""

    def __init__(self, root: Path, encryption_key: bytes) -> None:
        if len(encryption_key) != 32:
            raise ValueError("object encryption key must be exactly 32 bytes")
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._cipher = AESGCM(encryption_key)

    def put(self, content: bytes) -> str:
        object_id = hashlib.sha256(content).hexdigest()
        destination = self.path_for(object_id)
        if destination.exists():
            # Validate the existing immutable object rather than trusting a race
            # or a partially copied backup.
            if self.get(object_id) != content:
                raise ObjectCorruptionError(f"existing object is corrupt: {object_id}")
            return object_id
        destination.parent.mkdir(parents=True, exist_ok=True)
        nonce = os.urandom(NONCE_SIZE)
        encrypted = self._cipher.encrypt(nonce, content, object_id.encode("ascii"))
        payload = MAGIC + nonce + encrypted
        descriptor, temporary_name = tempfile.mkstemp(prefix=".cup-object-", dir=destination.parent)
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            with suppress(FileExistsError):
                # Hard-link publication is atomic and never replaces an immutable
                # object produced by another process.
                os.link(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
        if self.get(object_id) != content:
            raise ObjectCorruptionError(f"object failed post-write verification: {object_id}")
        return object_id

    def get(self, object_id: str) -> bytes:
        path = self.path_for(object_id)
        try:
            payload = path.read_bytes()
        except FileNotFoundError:
            raise FileNotFoundError(f"object does not exist: {object_id}") from None
        minimum = len(MAGIC) + NONCE_SIZE + TAG_SIZE
        if len(payload) < minimum or not payload.startswith(MAGIC):
            raise ObjectCorruptionError(f"invalid encrypted object header: {object_id}")
        nonce_offset = len(MAGIC)
        nonce = payload[nonce_offset : nonce_offset + NONCE_SIZE]
        encrypted = payload[nonce_offset + NONCE_SIZE :]
        try:
            plaintext = self._cipher.decrypt(nonce, encrypted, object_id.encode("ascii"))
        except InvalidTag as exc:
            raise ObjectCorruptionError(f"object authentication failed: {object_id}") from exc
        if hashlib.sha256(plaintext).hexdigest() != object_id:
            raise ObjectCorruptionError(f"object content hash failed: {object_id}")
        return plaintext

    def exists(self, object_id: str) -> bool:
        return self.path_for(object_id).is_file()

    def verify(self, object_id: str) -> int:
        return len(self.get(object_id))

    def delete_unreferenced(self, object_id: str, *, referenced_ids: Collection[str]) -> bool:
        """Garbage-collect an object after an authoritative reachability snapshot."""
        if object_id in referenced_ids:
            raise PermissionError(f"cannot delete referenced object: {object_id}")
        path = self.path_for(object_id)
        if not path.exists():
            return False
        path.unlink()
        for parent in (path.parent, path.parent.parent):
            try:
                parent.rmdir()
            except OSError:
                break
        return True

    def iter_ids(self) -> Iterator[str]:
        for path in sorted(self.root.glob("*/*/*.cupobj")):
            object_id = path.stem
            if len(object_id) == 64 and all(
                character in "0123456789abcdef" for character in object_id
            ):
                yield object_id

    def path_for(self, object_id: str) -> Path:
        if len(object_id) != 64 or any(c not in "0123456789abcdef" for c in object_id):
            raise ValueError("object_id must be a lowercase SHA-256 digest")
        return self.root / object_id[:2] / object_id[2:4] / f"{object_id}.cupobj"

    @contextmanager
    def open_plaintext(self, object_id: str) -> Iterator[bytes]:
        """Compatibility seam for consumers that require a scoped read."""
        plaintext = self.get(object_id)
        try:
            yield plaintext
        finally:
            # Bytes are immutable; consumers must not retain them when their
            # grant scope ends. This interface intentionally never exposes a path.
            del plaintext
