from __future__ import annotations

import hashlib
import json
import os
import secrets
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any, Literal, Protocol

from cupcake_runtime.backup.service import BackupInspection, BackupService
from cupcake_runtime.domain.errors import IntegrityViolation
from cupcake_runtime.domain.ids import new_id

MARKER_NAME = "clear-operation.json"
PREPARATION_TTL = timedelta(minutes=10)
PURGE_APPROVAL_TTL = timedelta(minutes=5)
DATABASE_SIDECARS = ("-wal", "-shm", "-journal")
FORBIDDEN_SECURITY_TOKENS = (
    "credential",
    "dpapi",
    "security",
    "secret",
    "vault",
)


class ClearDataError(RuntimeError):
    pass


class InventoryChangedError(ClearDataError):
    pass


class BackupVerificationError(ClearDataError):
    pass


class RecoveryConflictError(ClearDataError):
    pass


class FreshApprovalRequiredError(ClearDataError):
    pass


class ProfileLifecycle(Protocol):
    """Runtime-owned lifecycle hooks used after broker approval.

    ``checkpoint_and_close`` must stop task/DBOS writers, checkpoint every open
    SQLite database, and close all handles before returning. ``create_fresh``
    must initialize and activate a new profile at ``data_dir``. The clear core
    validates that it created only configured product-data targets.
    """

    def checkpoint_and_close(self) -> Mapping[str, int] | None: ...

    def create_fresh(self, data_dir: Path) -> Sequence[str | Path]: ...

    def activate_existing(self, data_dir: Path) -> None: ...


@dataclass(frozen=True, slots=True)
class DataTarget:
    category: str
    relative_path: str


@dataclass(frozen=True, slots=True)
class ProfileDataLayout:
    data_dir: Path
    product_database: str = "cupcake.db"
    runtime_databases: tuple[str, ...] = (
        "cupcake-runtime.db",
        "cupcake-dbos-system.db",
        "developer-traces.db",
    )
    object_directories: tuple[str, ...] = ("objects",)
    index_directories: tuple[str, ...] = ("indexes", "semantic-indexes")
    quarantine_directory: str = "clear-quarantine"

    def __post_init__(self) -> None:
        root = self.data_dir.resolve()
        object.__setattr__(self, "data_dir", root)
        _validate_relative(self.quarantine_directory)
        targets = self.targets()
        paths = [PurePosixPath(target.relative_path) for target in targets]
        if len(paths) != len(set(paths)):
            raise ValueError("profile clear layout contains duplicate targets")
        for index, path in enumerate(paths):
            for other in paths[index + 1 :]:
                if path in other.parents or other in path.parents:
                    raise ValueError("profile clear targets must not overlap")

    def targets(self) -> tuple[DataTarget, ...]:
        targets: list[DataTarget] = []
        targets.extend(_database_targets("product_database", self.product_database))
        for name in self.runtime_databases:
            targets.extend(_database_targets("runtime_database", name))
        targets.extend(DataTarget("objects", value) for value in self.object_directories)
        targets.extend(DataTarget("indexes", value) for value in self.index_directories)
        for target in targets:
            _validate_relative(target.relative_path)
            lowered = target.relative_path.casefold()
            if any(token in lowered for token in FORBIDDEN_SECURITY_TOKENS):
                raise ValueError("broker security and credential paths cannot be clear targets")
            if target.relative_path == self.quarantine_directory:
                raise ValueError("quarantine directory cannot be a clear target")
        return tuple(targets)

    @property
    def quarantine_root(self) -> Path:
        return self.data_dir / self.quarantine_directory


@dataclass(frozen=True, slots=True)
class InventoryItem:
    category: str
    relative_path: str
    kind: Literal["file", "directory"]
    file_count: int
    directory_count: int
    byte_size: int


@dataclass(frozen=True, slots=True)
class InventoryCategory:
    category: str
    target_count: int
    file_count: int
    directory_count: int
    byte_size: int


@dataclass(frozen=True, slots=True)
class LocalDataInventory:
    items: tuple[InventoryItem, ...]
    categories: tuple[InventoryCategory, ...]
    entity_counts: Mapping[str, int]
    target_count: int
    file_count: int
    directory_count: int
    byte_size: int
    digest: str
    captured_at: datetime

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["captured_at"] = _iso(self.captured_at)
        return value


@dataclass(frozen=True, slots=True)
class VerifiedBackupMetadata:
    archive_path: Path
    archive_sha256: str
    archive_byte_size: int
    archive_modified_ns: int
    product_version: str
    schema_version: int
    manifest_created_at: datetime
    manifest_entry_count: int
    verified_entry_count: int
    verified_content_bytes: int
    verified_at: datetime

    def public_dict(self) -> dict[str, Any]:
        return {
            "archive_name": self.archive_path.name,
            "archive_sha256": self.archive_sha256,
            "archive_byte_size": self.archive_byte_size,
            "product_version": self.product_version,
            "schema_version": self.schema_version,
            "manifest_created_at": _iso(self.manifest_created_at),
            "manifest_entry_count": self.manifest_entry_count,
            "verified_entry_count": self.verified_entry_count,
            "verified_content_bytes": self.verified_content_bytes,
            "verified_at": _iso(self.verified_at),
        }


@dataclass(frozen=True, slots=True)
class ClearPreparation:
    preparation_id: str
    session_id: str
    inventory: LocalDataInventory
    backup: VerifiedBackupMetadata
    prepared_at: datetime
    expires_at: datetime

    def public_dict(self) -> dict[str, Any]:
        return {
            "preparation_id": self.preparation_id,
            "inventory": self.inventory.to_dict(),
            "backup": self.backup.public_dict(),
            "prepared_at": _iso(self.prepared_at),
            "expires_at": _iso(self.expires_at),
        }


@dataclass(frozen=True, slots=True)
class ClearResult:
    operation_id: str
    state: Literal["fresh", "restored"]
    inventory: LocalDataInventory
    quarantine_path: Path
    undo_available: bool

    def public_dict(self) -> dict[str, Any]:
        return {
            "operation_id": self.operation_id,
            "state": self.state,
            "inventory": self.inventory.to_dict(),
            "undo_available": self.undo_available,
        }


@dataclass(frozen=True, slots=True)
class PurgeIntent:
    operation_id: str
    approval_nonce: str
    intent_digest: str
    byte_size: int
    file_count: int
    issued_at: datetime
    expires_at: datetime

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["issued_at"] = _iso(self.issued_at)
        value["expires_at"] = _iso(self.expires_at)
        return value


@dataclass(frozen=True, slots=True)
class PurgeAuthorization:
    operation_id: str
    approval_nonce: str
    intent_digest: str
    approved_at: datetime


@dataclass(frozen=True, slots=True)
class RecoveryResult:
    operation_id: str
    action: Literal["restored", "purged"]


EntityCounter = Callable[[], Mapping[str, int]]
FaultInjector = Callable[[str], None]


class LocalDataClearService:
    """Journaled, reversible clear of profile data selected by an exact layout.

    This service never enumerates arbitrary top-level files. In particular,
    broker security databases and DPAPI credential material cannot be included
    in a layout and are left for the broker's separate policy boundary.
    """

    def __init__(
        self,
        layout: ProfileDataLayout,
        *,
        entity_counter: EntityCounter | None = None,
        session_id: str | None = None,
        fault_injector: FaultInjector | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.layout = layout
        self.entity_counter = entity_counter
        self.session_id = session_id or new_id()
        self._fault_injector = fault_injector
        self._now = now or (lambda: datetime.now(UTC))
        self._quiesced_preparations: set[str] = set()

    def inventory(
        self, *, entity_counts: Mapping[str, int] | None = None
    ) -> LocalDataInventory:
        items = tuple(
            item
            for target in self.layout.targets()
            if (item := self._inventory_target(target)) is not None
        )
        supplied_entities = (
            entity_counts
            if entity_counts is not None
            else self.entity_counter()
            if self.entity_counter
            else {}
        )
        entities = dict(sorted(supplied_entities.items()))
        if any(not isinstance(value, int) or value < 0 for value in entities.values()):
            raise ValueError("entity counts must be non-negative integers")
        category_names = sorted({target.category for target in self.layout.targets()})
        categories = tuple(
            InventoryCategory(
                category=name,
                target_count=sum(item.category == name for item in items),
                file_count=sum(item.file_count for item in items if item.category == name),
                directory_count=sum(
                    item.directory_count for item in items if item.category == name
                ),
                byte_size=sum(item.byte_size for item in items if item.category == name),
            )
            for name in category_names
        )
        digest_payload = {
            "items": [asdict(item) for item in items],
            "categories": [asdict(category) for category in categories],
            "entity_counts": entities,
        }
        return LocalDataInventory(
            items=items,
            categories=categories,
            entity_counts=entities,
            target_count=len(items),
            file_count=sum(item.file_count for item in items),
            directory_count=sum(item.directory_count for item in items),
            byte_size=sum(item.byte_size for item in items),
            digest=hashlib.sha256(_json_bytes(digest_payload)).hexdigest(),
            captured_at=self._now(),
        )

    def verify_backup(self, archive_path: Path) -> VerifiedBackupMetadata:
        if archive_path.is_symlink():
            raise BackupVerificationError("backup symlinks are not accepted")
        archive = archive_path.resolve(strict=True)
        if not archive.is_file():
            raise BackupVerificationError("backup must be a regular local archive")
        inspection = BackupService.inspect(archive)
        stat = archive.stat()
        return self._backup_metadata(archive, stat, inspection)

    def prepare_clear(
        self,
        backup: VerifiedBackupMetadata,
        lifecycle: ProfileLifecycle,
    ) -> ClearPreparation:
        self._reverify_backup(backup)
        fallback_counts = self.entity_counter() if self.entity_counter else {}
        try:
            lifecycle_counts = lifecycle.checkpoint_and_close()
            inventory = self.inventory(
                entity_counts=lifecycle_counts
                if lifecycle_counts is not None
                else fallback_counts
            )
            now = self._now()
            preparation = ClearPreparation(
                preparation_id=new_id(),
                session_id=self.session_id,
                inventory=inventory,
                backup=backup,
                prepared_at=now,
                expires_at=now + PREPARATION_TTL,
            )
            self._quiesced_preparations.add(preparation.preparation_id)
            return preparation
        except BaseException:
            lifecycle.activate_existing(self.layout.data_dir)
            raise

    def cancel_preparation(
        self, preparation: ClearPreparation, lifecycle: ProfileLifecycle
    ) -> None:
        self._validate_preparation(preparation, allow_expired=True)
        if preparation.preparation_id in self._quiesced_preparations:
            lifecycle.activate_existing(self.layout.data_dir)
            self._quiesced_preparations.remove(preparation.preparation_id)

    def execute_clear(
        self,
        preparation: ClearPreparation,
        lifecycle: ProfileLifecycle,
    ) -> ClearResult:
        self._validate_preparation(preparation)
        if preparation.preparation_id not in self._quiesced_preparations:
            raise ClearDataError("clear preparation is not quiesced in this process")
        self._reverify_backup(preparation.backup)
        current = self.inventory(entity_counts=preparation.inventory.entity_counts)
        if current.digest != preparation.inventory.digest:
            lifecycle.activate_existing(self.layout.data_dir)
            self._quiesced_preparations.remove(preparation.preparation_id)
            raise InventoryChangedError("local data changed after clear preparation")

        operation_id = new_id()
        operation_dir = self.layout.quarantine_root / f"clear-{operation_id}"
        operation_dir.mkdir(parents=True, exist_ok=False)
        marker = self._new_marker(operation_id, preparation)
        self._write_marker(operation_dir, marker)
        self._fault("after_marker")
        try:
            marker = self._move_originals(operation_dir, marker)
            marker = self._set_state(operation_dir, marker, "creating_fresh")
            self._fault("before_create_fresh")
            created = lifecycle.create_fresh(self.layout.data_dir)
            fresh_targets = self._validate_fresh_paths(created)
            marker["fresh_targets"] = list(fresh_targets)
            marker = self._set_state(operation_dir, marker, "fresh")
            self._fault("after_fresh")
        except Exception:
            self._rollback_operation(operation_dir, marker)
            lifecycle.activate_existing(self.layout.data_dir)
            self._quiesced_preparations.remove(preparation.preparation_id)
            raise
        self._quiesced_preparations.remove(preparation.preparation_id)
        return ClearResult(operation_id, "fresh", current, operation_dir, True)

    def undo(self, operation_id: str, lifecycle: ProfileLifecycle) -> ClearResult:
        operation_dir, marker = self._load_operation(operation_id)
        if marker["session_id"] != self.session_id:
            raise ClearDataError("undo is available only until this app session exits")
        if marker["state"] != "fresh":
            raise ClearDataError(f"operation cannot be undone from state {marker['state']}")
        lifecycle.checkpoint_and_close()
        try:
            marker = self._set_state(operation_dir, marker, "undoing")
            self._discard_current_targets(operation_dir, marker, "discarded-fresh")
            self._restore_originals(operation_dir, marker)
            marker = self._set_state(operation_dir, marker, "restored")
            lifecycle.activate_existing(self.layout.data_dir)
        except BaseException:
            # Startup recovery will finish an interrupted undo before databases open.
            raise
        inventory = _inventory_from_marker(marker["inventory"])
        return ClearResult(operation_id, "restored", inventory, operation_dir, False)

    def prepare_purge(self, operation_id: str) -> PurgeIntent:
        operation_dir, marker = self._load_operation(operation_id)
        if marker["state"] not in {"fresh", "restored"}:
            raise ClearDataError(f"operation cannot be purged from state {marker['state']}")
        file_count, byte_size = _measure_tree(operation_dir)
        now = self._now()
        nonce = secrets.token_urlsafe(24)
        digest = _purge_digest(operation_id, nonce, file_count, byte_size)
        marker["purge_intent"] = {
            "approval_nonce": nonce,
            "intent_digest": digest,
            "file_count": file_count,
            "byte_size": byte_size,
            "issued_at": _iso(now),
            "expires_at": _iso(now + PURGE_APPROVAL_TTL),
        }
        self._write_marker(operation_dir, marker)
        return PurgeIntent(
            operation_id,
            nonce,
            digest,
            byte_size,
            file_count,
            now,
            now + PURGE_APPROVAL_TTL,
        )

    def purge(self, authorization: PurgeAuthorization) -> None:
        operation_dir, marker = self._load_operation(authorization.operation_id)
        intent = marker.get("purge_intent")
        if not isinstance(intent, dict):
            raise FreshApprovalRequiredError("a fresh purge preflight is required")
        now = self._now()
        approved_at = _utc(authorization.approved_at)
        expires_at = _parse_time(intent["expires_at"])
        expected = _purge_digest(
            authorization.operation_id,
            authorization.approval_nonce,
            int(intent["file_count"]),
            int(intent["byte_size"]),
        )
        if (
            authorization.approval_nonce != intent["approval_nonce"]
            or authorization.intent_digest != intent["intent_digest"]
            or not secrets.compare_digest(expected, authorization.intent_digest)
            or approved_at > now
            or now - approved_at > PURGE_APPROVAL_TTL
            or now > expires_at
        ):
            raise FreshApprovalRequiredError("purge authorization is stale or does not match")

        receipts = self.layout.quarantine_root / "purge-receipts"
        receipts.mkdir(parents=True, exist_ok=True)
        receipt = receipts / f"{authorization.operation_id}.json"
        _atomic_json(
            receipt,
            {
                "operation_id": authorization.operation_id,
                "intent_digest": authorization.intent_digest,
                "approved_at": _iso(approved_at),
                "state": "authorized",
            },
        )
        purging = self.layout.quarantine_root / f".purging-{authorization.operation_id}"
        os.replace(operation_dir, purging)
        _sync_directory(self.layout.quarantine_root)
        _remove_tree_exact(purging)
        _atomic_json(
            receipt,
            {
                "operation_id": authorization.operation_id,
                "intent_digest": authorization.intent_digest,
                "approved_at": _iso(approved_at),
                "state": "purged",
                "purged_at": _iso(self._now()),
            },
        )

    def recover_incomplete(self) -> tuple[RecoveryResult, ...]:
        root = self.layout.quarantine_root
        if not root.exists():
            return ()
        if root.is_symlink() or not root.is_dir():
            raise RecoveryConflictError("clear quarantine root is unsafe")
        results: list[RecoveryResult] = []
        for path in sorted(root.glob(".purging-*")):
            operation_id = path.name.removeprefix(".purging-")
            receipt = root / "purge-receipts" / f"{operation_id}.json"
            if not receipt.is_file():
                raise RecoveryConflictError("purge staging has no approval receipt")
            _remove_tree_exact(path)
            results.append(RecoveryResult(operation_id, "purged"))
        for operation_dir in sorted(root.glob("clear-*")):
            if operation_dir.is_symlink() or not operation_dir.is_dir():
                raise RecoveryConflictError("clear operation path is unsafe")
            marker = self._read_marker(operation_dir)
            state = marker["state"]
            if state in {"moving", "quarantined", "creating_fresh"}:
                self._rollback_operation(operation_dir, marker)
                results.append(RecoveryResult(marker["operation_id"], "restored"))
            elif state == "undoing":
                self._discard_current_targets(operation_dir, marker, "discarded-fresh")
                self._restore_originals(operation_dir, marker)
                self._set_state(operation_dir, marker, "restored")
                results.append(RecoveryResult(marker["operation_id"], "restored"))
        return tuple(results)

    def _inventory_target(self, target: DataTarget) -> InventoryItem | None:
        path = _resolved_target(self.layout.data_dir, target.relative_path)
        if not path.exists():
            return None
        files, directories, size, kind = _measure_path(path)
        return InventoryItem(
            target.category,
            target.relative_path,
            kind,
            files,
            directories,
            size,
        )

    def _validate_preparation(
        self, preparation: ClearPreparation, *, allow_expired: bool = False
    ) -> None:
        if preparation.session_id != self.session_id:
            raise ClearDataError("clear preparation belongs to another app session")
        if not allow_expired and self._now() > preparation.expires_at:
            raise ClearDataError("clear preparation expired")

    def _reverify_backup(self, expected: VerifiedBackupMetadata) -> None:
        try:
            actual = self.verify_backup(expected.archive_path)
        except (OSError, ValueError, IntegrityViolation) as exc:
            raise BackupVerificationError("verified backup is no longer available") from exc
        comparable = (
            "archive_sha256",
            "archive_byte_size",
            "archive_modified_ns",
            "product_version",
            "schema_version",
            "manifest_entry_count",
            "verified_entry_count",
            "verified_content_bytes",
        )
        if any(getattr(actual, name) != getattr(expected, name) for name in comparable):
            raise BackupVerificationError("backup changed after it was verified")

    def _new_marker(
        self, operation_id: str, preparation: ClearPreparation
    ) -> dict[str, Any]:
        return {
            "format_version": 1,
            "operation_id": operation_id,
            "session_id": self.session_id,
            "preparation_id": preparation.preparation_id,
            "state": "moving",
            "created_at": _iso(self._now()),
            "backup": preparation.backup.public_dict(),
            "inventory": preparation.inventory.to_dict(),
            "items": [
                {
                    "category": item.category,
                    "relative_path": item.relative_path,
                    "quarantine_relative_path": f"original/{item.relative_path}",
                    "moved": False,
                }
                for item in preparation.inventory.items
            ],
            "fresh_targets": [],
        }

    def _move_originals(
        self, operation_dir: Path, marker: dict[str, Any]
    ) -> dict[str, Any]:
        for index, item in enumerate(marker["items"]):
            source = _resolved_target(self.layout.data_dir, item["relative_path"])
            destination = _resolved_target(operation_dir, item["quarantine_relative_path"])
            if not source.exists():
                raise InventoryChangedError(f"clear target disappeared: {item['relative_path']}")
            measured = _measure_path(source)
            expected = next(
                value
                for value in marker["inventory"]["items"]
                if value["relative_path"] == item["relative_path"]
            )
            if (
                measured[0] != expected["file_count"]
                or measured[1] != expected["directory_count"]
                or measured[2] != expected["byte_size"]
                or measured[3] != expected["kind"]
            ):
                raise InventoryChangedError(
                    f"clear target changed before quarantine: {item['relative_path']}"
                )
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source, destination)
            _sync_directory(source.parent)
            _sync_directory(destination.parent)
            self._fault(f"after_move:{index}")
            item["moved"] = True
            self._write_marker(operation_dir, marker)
        return self._set_state(operation_dir, marker, "quarantined")

    def _rollback_operation(self, operation_dir: Path, marker: dict[str, Any]) -> None:
        previous_state = marker["state"]
        marker = self._set_state(operation_dir, marker, "rolling_back")
        original_paths = {item["relative_path"] for item in marker["items"]}
        if previous_state in {"creating_fresh", "fresh"}:
            for target in self.layout.targets():
                if target.relative_path in original_paths:
                    continue
                source = _resolved_target(self.layout.data_dir, target.relative_path)
                if source.exists():
                    destination = _resolved_target(
                        operation_dir, f"failed-fresh/{target.relative_path}"
                    )
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(source, destination)
        for item in marker["items"]:
            original = _resolved_target(
                operation_dir, item["quarantine_relative_path"]
            )
            current = _resolved_target(self.layout.data_dir, item["relative_path"])
            if original.exists() and current.exists():
                destination = _resolved_target(
                    operation_dir, f"failed-fresh/{item['relative_path']}"
                )
                if destination.exists():
                    raise RecoveryConflictError(
                        f"failed-profile destination exists: {item['relative_path']}"
                    )
                destination.parent.mkdir(parents=True, exist_ok=True)
                os.replace(current, destination)
            elif not original.exists() and not current.exists():
                raise RecoveryConflictError(
                    f"clear target is missing from profile and quarantine: "
                    f"{item['relative_path']}"
                )
        self._restore_originals(operation_dir, marker)
        self._set_state(operation_dir, marker, "restored")

    def _discard_current_targets(
        self, operation_dir: Path, marker: Mapping[str, Any], bucket: str
    ) -> None:
        for target in self.layout.targets():
            source = _resolved_target(self.layout.data_dir, target.relative_path)
            if not source.exists():
                continue
            destination = _resolved_target(operation_dir, f"{bucket}/{target.relative_path}")
            if destination.exists():
                raise RecoveryConflictError(f"discard destination already exists: {destination}")
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source, destination)

    def _restore_originals(
        self, operation_dir: Path, marker: Mapping[str, Any]
    ) -> None:
        for item in marker["items"]:
            source = _resolved_target(operation_dir, item["quarantine_relative_path"])
            destination = _resolved_target(self.layout.data_dir, item["relative_path"])
            if source.exists() and destination.exists():
                raise RecoveryConflictError(
                    f"both original and restore target exist: {item['relative_path']}"
                )
            if source.exists():
                destination.parent.mkdir(parents=True, exist_ok=True)
                os.replace(source, destination)
            elif not destination.exists():
                raise RecoveryConflictError(
                    f"original clear target is missing: {item['relative_path']}"
                )
        _sync_directory(self.layout.data_dir)

    def _validate_fresh_paths(self, created: Sequence[str | Path]) -> tuple[str, ...]:
        allowed = {target.relative_path for target in self.layout.targets()}
        normalized: set[str] = set()
        for value in created:
            path = Path(value)
            if path.is_absolute():
                try:
                    relative = path.resolve().relative_to(self.layout.data_dir).as_posix()
                except ValueError as exc:
                    raise ClearDataError("fresh profile returned a path outside data_dir") from exc
            else:
                relative = PurePosixPath(path.as_posix()).as_posix()
            if relative not in allowed:
                raise ClearDataError(f"fresh profile returned an unconfigured path: {relative}")
            target = _resolved_target(self.layout.data_dir, relative)
            _measure_path(target)
            normalized.add(relative)
        if self.layout.product_database not in normalized:
            raise ClearDataError("fresh profile did not create the product database")
        return tuple(sorted(normalized))

    def _load_operation(self, operation_id: str) -> tuple[Path, dict[str, Any]]:
        if not operation_id or any(
            character not in "0123456789abcdef-_" for character in operation_id
        ):
            raise ValueError("invalid clear operation id")
        operation_dir = self.layout.quarantine_root / f"clear-{operation_id}"
        if not operation_dir.is_dir() or operation_dir.is_symlink():
            raise KeyError(operation_id)
        marker = self._read_marker(operation_dir)
        if marker.get("operation_id") != operation_id:
            raise RecoveryConflictError("clear marker identity does not match its directory")
        return operation_dir, marker

    def _read_marker(self, operation_dir: Path) -> dict[str, Any]:
        marker_path = operation_dir / MARKER_NAME
        if marker_path.is_symlink() or not marker_path.is_file():
            raise RecoveryConflictError("clear operation marker is missing or unsafe")
        value = json.loads(marker_path.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or value.get("format_version") != 1:
            raise RecoveryConflictError("clear operation marker is unsupported")
        return value

    def _write_marker(self, operation_dir: Path, marker: Mapping[str, Any]) -> None:
        _atomic_json(operation_dir / MARKER_NAME, marker)

    def _set_state(
        self, operation_dir: Path, marker: dict[str, Any], state: str
    ) -> dict[str, Any]:
        marker["state"] = state
        marker["updated_at"] = _iso(self._now())
        self._write_marker(operation_dir, marker)
        return marker

    def _backup_metadata(
        self, archive: Path, stat: os.stat_result, inspection: BackupInspection
    ) -> VerifiedBackupMetadata:
        return VerifiedBackupMetadata(
            archive_path=archive,
            archive_sha256=_sha256_file(archive),
            archive_byte_size=stat.st_size,
            archive_modified_ns=stat.st_mtime_ns,
            product_version=inspection.manifest.product_version,
            schema_version=inspection.manifest.schema_version,
            manifest_created_at=inspection.manifest.created_at,
            manifest_entry_count=len(inspection.manifest.entries),
            verified_entry_count=inspection.verified_entries,
            verified_content_bytes=inspection.total_bytes,
            verified_at=self._now(),
        )

    def _fault(self, name: str) -> None:
        if self._fault_injector is not None:
            self._fault_injector(name)


def _database_targets(category: str, value: str) -> tuple[DataTarget, ...]:
    return (
        DataTarget(category, value),
        *(DataTarget(category, f"{value}{suffix}") for suffix in DATABASE_SIDECARS),
    )


def _validate_relative(value: str) -> None:
    path = PurePosixPath(value)
    if (
        not value
        or path.is_absolute()
        or path.as_posix() != value.replace("\\", "/")
        or ".." in path.parts
        or "." in path.parts
    ):
        raise ValueError(f"unsafe profile-relative path: {value!r}")


def _resolved_target(root: Path, relative: str) -> Path:
    _validate_relative(relative)
    root = root.resolve()
    target = root.joinpath(*PurePosixPath(relative).parts)
    try:
        parent = target.parent.resolve()
        parent.relative_to(root)
    except (OSError, ValueError) as exc:
        raise RecoveryConflictError(f"target escapes profile root: {relative}") from exc
    return target


def _measure_path(path: Path) -> tuple[int, int, int, Literal["file", "directory"]]:
    if path.is_symlink():
        raise RecoveryConflictError(f"profile data target is a symlink: {path}")
    if path.is_file():
        return 1, 0, path.stat().st_size, "file"
    if not path.is_dir():
        raise RecoveryConflictError(f"profile data target is not regular: {path}")
    file_count = 0
    directory_count = 1
    byte_size = 0
    for root, directories, files in os.walk(path, followlinks=False):
        root_path = Path(root)
        for name in directories:
            child = root_path / name
            if child.is_symlink():
                raise RecoveryConflictError(f"profile data contains a symlink: {child}")
            directory_count += 1
        for name in files:
            child = root_path / name
            if child.is_symlink() or not child.is_file():
                raise RecoveryConflictError(f"profile data contains an unsafe file: {child}")
            file_count += 1
            byte_size += child.stat().st_size
    return file_count, directory_count, byte_size, "directory"


def _measure_tree(path: Path) -> tuple[int, int]:
    files, _, size, _ = _measure_path(path)
    return files, size


def _inventory_from_marker(value: Mapping[str, Any]) -> LocalDataInventory:
    return LocalDataInventory(
        items=tuple(InventoryItem(**item) for item in value["items"]),
        categories=tuple(InventoryCategory(**item) for item in value["categories"]),
        entity_counts=dict(value["entity_counts"]),
        target_count=int(value["target_count"]),
        file_count=int(value["file_count"]),
        directory_count=int(value["directory_count"]),
        byte_size=int(value["byte_size"]),
        digest=str(value["digest"]),
        captured_at=_parse_time(value["captured_at"]),
    )


def _purge_digest(operation_id: str, nonce: str, file_count: int, byte_size: int) -> str:
    payload = f"cupcake-purge-v1\0{operation_id}\0{nonce}\0{file_count}\0{byte_size}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )
    try:
        with temporary.open("xb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        _sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _remove_tree_exact(path: Path) -> None:
    if path.is_symlink() or not path.is_dir():
        raise RecoveryConflictError(f"refusing to purge unsafe path: {path}")
    for root, directories, files in os.walk(path, topdown=False, followlinks=False):
        root_path = Path(root)
        for name in files:
            child = root_path / name
            if child.is_symlink() or not child.is_file():
                raise RecoveryConflictError(f"refusing to purge unsafe file: {child}")
            child.unlink()
        for name in directories:
            child = root_path / name
            if child.is_symlink() or not child.is_dir():
                raise RecoveryConflictError(f"refusing to purge unsafe directory: {child}")
            child.rmdir()
    path.rmdir()


def _sync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def _json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )


def _iso(value: datetime) -> str:
    return _utc(value).isoformat().replace("+00:00", "Z")


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("timestamps must be timezone-aware")
    return value.astimezone(UTC)
