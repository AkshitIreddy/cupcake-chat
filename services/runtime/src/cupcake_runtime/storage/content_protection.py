from __future__ import annotations

import importlib
import json
import os
import shutil
import tempfile
import uuid
from collections.abc import Mapping
from contextlib import suppress
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import cast

from cupcake_runtime.object_store import EncryptedObjectStore
from cupcake_runtime.storage.database import Database, DatabaseConfig

DESCRIPTOR_VERSION = 1


class ContentProtectionMode(StrEnum):
    ENCRYPTED = "encrypted"
    PLAINTEXT = "plaintext"


@dataclass(frozen=True, slots=True)
class ContentLayout:
    mode: ContentProtectionMode
    generation: str | None
    database_path: Path
    objects_path: Path


class ContentProtectionManager:
    """Switch product content between encrypted and plaintext generations.

    A generation is published only after its database and every immutable
    object have been independently reopened and verified.  The descriptor also
    records the prior generation until the newly selected generation survives a
    complete RuntimeService startup.
    """

    def __init__(
        self,
        data_dir: Path,
        *,
        database_key: bytes,
        object_key: bytes,
        default_mode: ContentProtectionMode,
    ) -> None:
        if len(database_key) < 32 or len(object_key) != 32:
            raise ValueError("content protection keys have invalid lengths")
        self.data_dir = data_dir
        self.database_key = database_key
        self.object_key = object_key
        self.default_mode = default_mode
        self.security_dir = data_dir / "security"
        self.generations_dir = data_dir / "content-generations"
        self.descriptor_path = self.security_dir / "content-protection.json"

    def resolve_active(self) -> ContentLayout:
        descriptor = self._read_descriptor()
        if descriptor is None:
            return self._layout(self.default_mode, None)
        active = self._layout_from_ref(descriptor)
        # A finalized generation is opened and authenticated by RuntimeService;
        # walking every immutable object here would make ordinary startup scale
        # with the lifetime size of the workspace. Full-store verification is
        # reserved for the pending transition/recovery window.
        if descriptor.get("previous") is None:
            return active
        try:
            self._verify_layout(active, allow_missing=False)
            return active
        except Exception as active_error:
            previous_raw = _string_mapping(descriptor.get("previous"))
            if previous_raw is None:
                raise RuntimeError(
                    "active content generation could not be opened"
                ) from active_error
            previous = self._layout_from_ref(previous_raw)
            try:
                self._verify_layout(previous, allow_missing=False)
            except Exception as previous_error:
                raise RuntimeError(
                    "neither the active nor recovery content generation could be opened"
                ) from previous_error
            recovered = self._descriptor_for(previous)
            retained = _object_list(descriptor.get("retainedEncryptedGenerations"))
            if retained is not None:
                recovered["retainedEncryptedGenerations"] = retained
            self._write_descriptor(recovered)
            with suppress(OSError):
                self._remove_layout(active)
            return previous

    def migrate(self, source: ContentLayout, target_mode: ContentProtectionMode) -> ContentLayout:
        if source.mode == target_mode:
            return source
        self._verify_layout(source, allow_missing=False)
        generation = str(uuid.uuid4())
        target = self._layout(target_mode, generation)
        target.database_path.parent.mkdir(parents=True, exist_ok=False)
        try:
            self._export_database(source, target)
            self._copy_objects(source, target)
            self._verify_layout(target, allow_missing=False)
            descriptor = self._descriptor_for(target)
            descriptor["previous"] = self._reference(source)
            descriptor["transition"] = "pending-restart"
            current = self._read_descriptor()
            current_retained = (
                _object_list(current.get("retainedEncryptedGenerations")) if current else None
            )
            if current_retained is not None:
                descriptor["retainedEncryptedGenerations"] = current_retained
            self._write_descriptor(descriptor)
            return target
        except BaseException:
            with suppress(OSError):
                self._remove_layout(target)
            raise

    def finalize_open(self, active: ContentLayout) -> None:
        descriptor = self._read_descriptor()
        if descriptor is None or descriptor.get("previous") is None:
            return
        selected = self._layout_from_ref(descriptor)
        if selected.mode != active.mode or selected.generation != active.generation:
            return
        previous_raw = _string_mapping(descriptor.get("previous"))
        if previous_raw is None:
            raise RuntimeError("content recovery descriptor is invalid")
        previous = self._layout_from_ref(previous_raw)
        retained: list[dict[str, object]] = []
        raw_retained = _object_list(descriptor.get("retainedEncryptedGenerations"))
        if raw_retained is not None:
            retained = [
                item for value in raw_retained if (item := _string_mapping(value)) is not None
            ]
        if previous.mode == ContentProtectionMode.PLAINTEXT:
            # This removes the known live plaintext generation, but filesystem
            # deletion cannot promise forensic erasure on SSDs or snapshots.
            try:
                self._remove_layout(previous)
            except OSError:
                descriptor["transition"] = "cleanup-pending"
                self._write_descriptor(descriptor)
                return
        else:
            reference = self._reference(previous)
            if reference not in retained:
                retained.append(reference)
        finalized = self._descriptor_for(active)
        if retained:
            finalized["retainedEncryptedGenerations"] = retained
        self._write_descriptor(finalized)

    def status(self, active: ContentLayout) -> dict[str, object]:
        descriptor = self._read_descriptor() or {}
        retained = _object_list(descriptor.get("retainedEncryptedGenerations"))
        return {
            "mode": active.mode.value,
            "databaseEncrypted": active.mode == ContentProtectionMode.ENCRYPTED,
            "objectsEncrypted": active.mode == ContentProtectionMode.ENCRYPTED,
            "credentialsProtected": True,
            "credentialsProtection": "windows-dpapi-current-user",
            "requiresRestart": False,
            "transition": descriptor.get("transition") if descriptor.get("previous") else None,
            "retainedEncryptedRollbackCopies": len(retained) if retained is not None else 0,
        }

    def _layout(self, mode: ContentProtectionMode, generation: str | None) -> ContentLayout:
        if generation is None:
            return ContentLayout(
                mode,
                None,
                self.data_dir / "cupcake.db",
                self.data_dir / "objects",
            )
        try:
            canonical = str(uuid.UUID(generation))
        except ValueError as exc:
            raise RuntimeError("content generation identifier is invalid") from exc
        if canonical != generation:
            raise RuntimeError("content generation identifier is not canonical")
        root = self.generations_dir / generation
        return ContentLayout(mode, generation, root / "cupcake.db", root / "objects")

    def _layout_from_ref(self, value: Mapping[str, object]) -> ContentLayout:
        raw_mode = value.get("mode")
        if not isinstance(raw_mode, str):
            raise RuntimeError("content protection descriptor is invalid")
        try:
            mode = ContentProtectionMode(raw_mode)
        except ValueError as exc:
            raise RuntimeError("content protection descriptor is invalid") from exc
        generation = value.get("generation")
        if generation is not None and not isinstance(generation, str):
            raise RuntimeError("content protection generation is invalid")
        return self._layout(mode, generation)

    @staticmethod
    def _reference(layout: ContentLayout) -> dict[str, object]:
        return {"mode": layout.mode.value, "generation": layout.generation}

    def _descriptor_for(self, layout: ContentLayout) -> dict[str, object]:
        return {"version": DESCRIPTOR_VERSION, **self._reference(layout)}

    def _read_descriptor(self) -> dict[str, object] | None:
        try:
            decoded: object = json.loads(self.descriptor_path.read_text("utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RuntimeError("content protection descriptor is unreadable") from exc
        value = _string_mapping(decoded)
        if value is None or value.get("version") != DESCRIPTOR_VERSION:
            raise RuntimeError("content protection descriptor version is unsupported")
        return value

    def _write_descriptor(self, value: Mapping[str, object]) -> None:
        self.security_dir.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".content-protection-", suffix=".json", dir=self.security_dir
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(value, handle, sort_keys=True, separators=(",", ":"))
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.descriptor_path)
        finally:
            temporary.unlink(missing_ok=True)

    def _export_database(self, source: ContentLayout, target: ContentLayout) -> None:
        sqlcipher = importlib.import_module("sqlcipher3")
        connection = sqlcipher.connect(str(source.database_path))
        attached = False
        try:
            if source.mode == ContentProtectionMode.ENCRYPTED:
                connection.execute(f"PRAGMA key = \"x'{self.database_key.hex()}'\"")
                version = connection.execute("PRAGMA cipher_version").fetchone()
                if not version or not version[0]:
                    raise RuntimeError("SQLCipher did not activate for the source database")
            connection.execute("PRAGMA temp_store = MEMORY")
            connection.execute("PRAGMA trusted_schema = OFF")
            connection.execute("SELECT count(*) FROM sqlite_master").fetchone()
            target_key = (
                f"\"x'{self.database_key.hex()}'\""
                if target.mode == ContentProtectionMode.ENCRYPTED
                else "''"
            )
            connection.execute(
                f"ATTACH DATABASE ? AS cupcake_migrated KEY {target_key}",
                (str(target.database_path),),
            )
            attached = True
            connection.execute("SELECT sqlcipher_export('cupcake_migrated')")
            user_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            connection.execute(f"PRAGMA cupcake_migrated.user_version = {user_version}")
            connection.commit()
            connection.execute("DETACH DATABASE cupcake_migrated")
            attached = False
        finally:
            if attached:
                with suppress(Exception):
                    connection.execute("DETACH DATABASE cupcake_migrated")
            connection.close()

    def _copy_objects(self, source: ContentLayout, target: ContentLayout) -> None:
        source_store = EncryptedObjectStore(
            source.objects_path,
            self.object_key if source.mode == ContentProtectionMode.ENCRYPTED else None,
        )
        target_store = EncryptedObjectStore(
            target.objects_path,
            self.object_key if target.mode == ContentProtectionMode.ENCRYPTED else None,
        )
        object_ids = self._object_ids(source_store)
        for object_id in object_ids:
            content = source_store.get(object_id)
            if target_store.put(content) != object_id or target_store.get(object_id) != content:
                raise RuntimeError(f"object migration verification failed: {object_id}")
        if self._object_ids(target_store) != object_ids:
            raise RuntimeError("object migration produced a different object set")

    def _verify_layout(self, layout: ContentLayout, *, allow_missing: bool) -> None:
        if not layout.database_path.exists():
            if allow_missing:
                return
            raise RuntimeError("content database is missing")
        database = Database(
            DatabaseConfig(
                path=layout.database_path,
                encryption_key=(
                    self.database_key if layout.mode == ContentProtectionMode.ENCRYPTED else None
                ),
                require_sqlcipher=layout.mode == ContentProtectionMode.ENCRYPTED,
            )
        )
        try:
            if database.integrity_check() != ("ok",):
                raise RuntimeError("content database failed its integrity check")
            database.checkpoint()
        finally:
            database.close()
        store = EncryptedObjectStore(
            layout.objects_path,
            self.object_key if layout.mode == ContentProtectionMode.ENCRYPTED else None,
        )
        for object_id in self._object_ids(store):
            store.verify(object_id)

    @staticmethod
    def _object_ids(store: EncryptedObjectStore) -> tuple[str, ...]:
        discovered: list[str] = []
        for path in sorted(store.root.rglob("*.cupobj")):
            object_id = path.stem
            try:
                expected = store.path_for(object_id)
            except ValueError as exc:
                raise RuntimeError(f"invalid object path in content store: {path.name}") from exc
            if path != expected:
                raise RuntimeError(f"misplaced object in content store: {path.name}")
            discovered.append(object_id)
        if len(discovered) != len(set(discovered)):
            raise RuntimeError("duplicate immutable object identifiers")
        return tuple(discovered)

    def _remove_layout(self, layout: ContentLayout) -> None:
        if layout.generation is not None:
            root = layout.database_path.parent
            expected = self.generations_dir / layout.generation
            if root != expected:
                raise RuntimeError("refusing to remove an unexpected content generation")
            if root.exists():
                shutil.rmtree(root)
            return
        for suffix in ("", "-wal", "-shm", "-journal"):
            Path(f"{layout.database_path}{suffix}").unlink(missing_ok=True)
        if layout.objects_path.exists():
            shutil.rmtree(layout.objects_path)


def _string_mapping(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    untyped = cast(dict[object, object], value)
    if not all(isinstance(key, str) for key in untyped):
        return None
    return {cast(str, key): item for key, item in untyped.items()}


def _object_list(value: object) -> list[object] | None:
    if not isinstance(value, list):
        return None
    return cast(list[object], value)
