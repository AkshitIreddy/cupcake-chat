from __future__ import annotations

import json
import posixpath
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC
from pathlib import PurePosixPath
from typing import Any, Literal

from cupcake_runtime.domain.ids import new_id
from cupcake_runtime.memory import MemoryStore
from cupcake_runtime.storage.database import Database

from .models import LegacyRecord, MigrationReport

IMPORTER_VERSION = 1
SUPPORTED_RECORD_KINDS = frozenset(
    {
        "conversation_message",
        "task",
        "personality",
        "thought",
        "emotion",
        "sense",
        "chroma_text",
    }
)
MigrationDecision = Literal["previewed", "declined"]


@dataclass(frozen=True, slots=True)
class PersistedMigration:
    migration_id: str
    importer_version: int
    source_fingerprint: str
    status: str
    report: Mapping[str, Any]
    imported_at: str


@dataclass(frozen=True, slots=True)
class PersistedMigrationDecision:
    source_fingerprint: str
    importer_version: int
    state: MigrationDecision
    report: Mapping[str, Any]
    updated_at: str


class ProductMigrationSink:
    """Atomically project a safe v1 import into the product database.

    Conversations become an immutable conversation DAG, recovered task items
    become paused historical product records, and reviewable personality,
    thought, and Chroma data becomes candidate memory with provenance. Legacy
    emotion and sense scalars remain report-only ledger records. The import
    ledger is committed in the same transaction, so a crash cannot leave a
    partially applied migration that later appears complete.

    The sink intentionally accepts only normalized records produced by
    :class:`LegacyImporter`; it never receives a source directory and therefore
    cannot open legacy files or credentials itself.
    """

    def __init__(self, database: Database) -> None:
        self.database = database
        # RuntimeService normally creates MemoryStore before this service.  This
        # defensive initialization makes the sink independently usable by the
        # first-run bootstrap and tests while keeping memory in the same
        # authoritative encrypted profile database.
        self._memory_schema = MemoryStore(database.connection)

    def close(self) -> None:
        self._memory_schema.close()

    def contains_migration(self, migration_id: str) -> bool:
        row = self.database.connection.execute(
            "SELECT 1 FROM legacy_migrations WHERE migration_id=?", (migration_id,)
        ).fetchone()
        return row is not None

    def get_migration(self, migration_id: str) -> PersistedMigration | None:
        row = self.database.connection.execute(
            "SELECT * FROM legacy_migrations WHERE migration_id=?", (migration_id,)
        ).fetchone()
        return None if row is None else self._migration(row)

    def migration_for_fingerprint(self, fingerprint: str) -> PersistedMigration | None:
        row = self.database.connection.execute(
            "SELECT * FROM legacy_migrations WHERE source_fingerprint=?", (fingerprint,)
        ).fetchone()
        return None if row is None else self._migration(row)

    def decision_for(self, fingerprint: str) -> PersistedMigrationDecision | None:
        row = self.database.connection.execute(
            "SELECT * FROM legacy_migration_decisions WHERE source_fingerprint=?",
            (fingerprint,),
        ).fetchone()
        if row is None:
            return None
        return PersistedMigrationDecision(
            source_fingerprint=row["source_fingerprint"],
            importer_version=int(row["importer_version"]),
            state=row["state"],
            report=json.loads(row["report_json"]),
            updated_at=row["updated_at"],
        )

    def record_decision(self, state: MigrationDecision, report: MigrationReport) -> None:
        if state not in {"previewed", "declined"}:
            raise ValueError(f"unsupported legacy migration decision: {state}")
        report_json = _json(report.to_dict())
        updated_at = _timestamp(report)
        with self.database.transaction() as connection:
            if connection.execute(
                "SELECT 1 FROM legacy_migrations WHERE source_fingerprint=?",
                (report.source_fingerprint,),
            ).fetchone():
                return
            connection.execute(
                """INSERT INTO legacy_migration_decisions(
                       source_fingerprint, importer_version, state, report_json, updated_at
                   ) VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(source_fingerprint) DO UPDATE SET
                       importer_version=excluded.importer_version,
                       state=excluded.state,
                       report_json=excluded.report_json,
                       updated_at=excluded.updated_at""",
                (
                    report.source_fingerprint,
                    IMPORTER_VERSION,
                    state,
                    report_json,
                    updated_at,
                ),
            )

    def apply_migration(self, report: MigrationReport, records: tuple[LegacyRecord, ...]) -> None:
        if report.status not in {"imported", "no_data"}:
            raise ValueError("only completed migration reports can be persisted")
        self._validate_batch(report, records)
        imported_at = _timestamp(report)
        with self.database.transaction() as connection:
            if connection.execute(
                "SELECT 1 FROM legacy_migrations WHERE migration_id=?",
                (report.migration_id,),
            ).fetchone():
                return

            connection.execute(
                """INSERT INTO legacy_migrations(
                       migration_id, importer_version, source_fingerprint,
                       status, report_json, imported_at
                   ) VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    report.migration_id,
                    IMPORTER_VERSION,
                    report.source_fingerprint,
                    report.status,
                    _json(report.to_dict()),
                    imported_at,
                ),
            )

            entity_ids: dict[str, str | None] = {}
            conversation_records = tuple(
                record for record in records if record.kind == "conversation_message"
            )
            if conversation_records:
                entity_ids.update(
                    self._insert_conversation(connection, report, conversation_records, imported_at)
                )

            for record in records:
                if record.kind == "conversation_message":
                    continue
                if record.kind == "task":
                    entity_ids[record.record_id] = self._insert_task(
                        connection, report, record, imported_at
                    )
                    continue
                if record.kind in {"emotion", "sense"}:
                    # These synthetic v1 scalars are preserved in the report and
                    # ledger for audit only. They must never steer 2.0 context.
                    entity_ids[record.record_id] = None
                else:
                    entity_ids[record.record_id] = self._insert_memory(
                        connection, report, record, imported_at
                    )

            for record in records:
                connection.execute(
                    """INSERT INTO legacy_migration_records(
                           migration_id, record_id, kind, source_locator,
                           entity_id, imported_at
                       ) VALUES (?, ?, ?, ?, ?, ?)""",
                    (
                        report.migration_id,
                        record.record_id,
                        record.kind,
                        record.source,
                        entity_ids.get(record.record_id),
                        imported_at,
                    ),
                )
            connection.execute(
                "DELETE FROM legacy_migration_decisions WHERE source_fingerprint=?",
                (report.source_fingerprint,),
            )

    def list_recovered_tasks(self, *, limit: int = 500) -> tuple[dict[str, Any], ...]:
        if not 1 <= limit <= 2_000:
            raise ValueError("limit must be between 1 and 2000")
        rows = self.database.connection.execute(
            """SELECT id, title, status, legacy_created_at, canonical_metadata,
                      created_at, updated_at
               FROM legacy_tasks ORDER BY updated_at DESC, id DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        return tuple(
            {
                "id": row["id"],
                "title": row["title"],
                "status": row["status"],
                "legacy_created_at": row["legacy_created_at"],
                "metadata": json.loads(row["canonical_metadata"]),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        )

    @staticmethod
    def _validate_batch(report: MigrationReport, records: tuple[LegacyRecord, ...]) -> None:
        if len(report.source_fingerprint) != 64 or any(
            character not in "0123456789abcdef" for character in report.source_fingerprint
        ):
            raise ValueError("legacy source fingerprint must be lowercase SHA-256")
        if len({record.record_id for record in records}) != len(records):
            raise ValueError("legacy migration batch contains duplicate record ids")
        counted: dict[str, int] = {}
        for record in records:
            if record.kind not in SUPPORTED_RECORD_KINDS:
                raise ValueError(f"unsupported legacy record kind: {record.kind}")
            _validate_locator(record.source)
            counted[record.kind] = counted.get(record.kind, 0) + 1
        expected = {key: int(value) for key, value in report.counts.items() if value}
        if counted != expected:
            raise ValueError("legacy report counts do not match the record batch")

    def _insert_conversation(
        self,
        connection: Any,
        report: MigrationReport,
        records: tuple[LegacyRecord, ...],
        imported_at: str,
    ) -> dict[str, str]:
        conversation_id = new_id()
        branch_id = new_id()
        title = "Imported from Cupcake 1.0"
        connection.execute(
            "INSERT INTO conversations VALUES (?, NULL, ?, 'active', ?, ?)",
            (conversation_id, title, imported_at, imported_at),
        )
        connection.execute(
            "INSERT INTO conversation_branches VALUES (?, ?, 'Imported history', NULL, NULL, ?, ?)",
            (branch_id, conversation_id, imported_at, imported_at),
        )
        self._upsert_search(
            connection,
            conversation_id,
            None,
            "conversation",
            title,
            "Recovered local conversation history from Cupcake 1.0.",
            imported_at,
        )
        head_id: str | None = None
        result: dict[str, str] = {}
        for record in records:
            content = str(record.payload.get("content", "")).strip()
            legacy_role = str(record.payload.get("role", "user"))
            role = (
                "assistant"
                if legacy_role == "assistant"
                else "system"
                if legacy_role == "summary"
                else "user"
            )
            message_id = new_id()
            metadata = {
                "legacy_import": {
                    "migration_id": report.migration_id,
                    "record_id": record.record_id,
                    "source": record.source,
                    "legacy_role": legacy_role,
                    "legacy_sender": record.payload.get("legacy_sender"),
                    "legacy_attachment_reference": record.payload.get(
                        "legacy_attachment_reference"
                    ),
                    "attachment_available": bool(record.payload.get("attachment_available", False)),
                }
            }
            connection.execute(
                """INSERT INTO messages(
                       id, conversation_id, branch_id, parent_message_id, role,
                       content, state, model_id, provider_id, run_id,
                       canonical_metadata, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, 'complete', NULL, NULL, NULL, ?, ?)""",
                (
                    message_id,
                    conversation_id,
                    branch_id,
                    head_id,
                    role,
                    content,
                    _json(metadata),
                    imported_at,
                ),
            )
            self._upsert_search(
                connection,
                message_id,
                None,
                "message",
                f"Imported {role.title()} message",
                content,
                imported_at,
            )
            head_id = message_id
            result[record.record_id] = message_id
        connection.execute(
            "UPDATE conversation_branches SET head_message_id=?, updated_at=? WHERE id=?",
            (head_id, imported_at, branch_id),
        )
        return result

    def _insert_task(
        self,
        connection: Any,
        report: MigrationReport,
        record: LegacyRecord,
        imported_at: str,
    ) -> str:
        task_id = new_id()
        title = str(record.payload.get("title", "")).strip()[:1000]
        if not title:
            raise ValueError("legacy task title is empty")
        metadata = {
            "legacy_import": {
                "migration_id": report.migration_id,
                "record_id": record.record_id,
                "source": record.source,
                "legacy_id": record.payload.get("legacy_id"),
            }
        }
        connection.execute(
            """INSERT INTO legacy_tasks(
                   id, migration_id, title, status, legacy_created_at,
                   canonical_metadata, created_at, updated_at
                ) VALUES (?, ?, ?, 'paused', ?, ?, ?, ?)""",
            (
                task_id,
                report.migration_id,
                title,
                _optional_text(record.payload.get("legacy_created_at")),
                _json(metadata),
                imported_at,
                imported_at,
            ),
        )
        self._upsert_search(
            connection,
            task_id,
            None,
            "task",
            title,
            "Recovered paused task from Cupcake 1.0.",
            imported_at,
        )
        return task_id

    def _insert_memory(
        self,
        connection: Any,
        report: MigrationReport,
        record: LegacyRecord,
        imported_at: str,
    ) -> str:
        key, content, kind, state, confidence, explicit = _memory_projection(record)
        return self._insert_memory_row(
            connection,
            report,
            record,
            imported_at,
            key=key,
            content=content,
            kind=kind,
            state=state,
            confidence=confidence,
            explicit=explicit,
            metadata={
                "legacy_import": {
                    "migration_id": report.migration_id,
                    "record_id": record.record_id,
                    "source": record.source,
                    "kind": record.kind,
                }
            },
        )

    def _insert_memory_row(
        self,
        connection: Any,
        report: MigrationReport,
        record: LegacyRecord,
        imported_at: str,
        *,
        key: str,
        content: str,
        kind: str,
        state: str,
        confidence: float,
        explicit: bool,
        metadata: Mapping[str, Any],
    ) -> str:
        memory_id = new_id()
        normalized_key = " ".join(key.strip().casefold().split())[:256]
        connection.execute(
            """INSERT INTO memories(
                   id, normalized_key, display_key, content, kind, state, scope_kind,
                   project_id, conversation_id, confidence, sensitive, explicit,
                   version, supersedes_id, created_at, updated_at, expires_at,
                   forgotten_at, metadata_json
               ) VALUES (?, ?, ?, ?, ?, ?, 'global', NULL, NULL, ?, 0, ?, 1, NULL,
                         ?, ?, NULL, NULL, ?)""",
            (
                memory_id,
                normalized_key,
                key.strip()[:256],
                content.strip(),
                kind,
                state,
                confidence,
                int(explicit),
                imported_at,
                imported_at,
                _json(metadata),
            ),
        )
        connection.execute(
            """INSERT INTO memory_evidence(
                   memory_id, source_kind, source_id, excerpt, locator_json, captured_at
               ) VALUES (?, 'legacy_import', ?, NULL, ?, ?)""",
            (
                memory_id,
                report.migration_id,
                _json({"source": record.source, "record_id": record.record_id}),
                imported_at,
            ),
        )
        return memory_id

    @staticmethod
    def _upsert_search(
        connection: Any,
        entity_id: str,
        project_id: str | None,
        entity_type: str,
        title: str,
        body: str,
        updated_at: str,
    ) -> None:
        existing = connection.execute(
            "SELECT row_id FROM search_documents WHERE entity_id=?", (entity_id,)
        ).fetchone()
        if existing is not None:
            connection.execute("DELETE FROM search_fts WHERE rowid=?", (existing["row_id"],))
        connection.execute(
            """INSERT INTO search_documents(
                   entity_id, project_id, entity_type, title, body, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(entity_id) DO UPDATE SET
                   project_id=excluded.project_id,
                   entity_type=excluded.entity_type,
                   title=excluded.title,
                   body=excluded.body,
                   updated_at=excluded.updated_at""",
            (entity_id, project_id, entity_type, title, body, updated_at),
        )
        row = connection.execute(
            "SELECT row_id FROM search_documents WHERE entity_id=?", (entity_id,)
        ).fetchone()
        connection.execute(
            """INSERT INTO search_fts(rowid, entity_id, project_id, entity_type, title, body)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (row["row_id"], entity_id, project_id, entity_type, title, body),
        )

    @staticmethod
    def _migration(row: Any) -> PersistedMigration:
        return PersistedMigration(
            migration_id=row["migration_id"],
            importer_version=int(row["importer_version"]),
            source_fingerprint=row["source_fingerprint"],
            status=row["status"],
            report=json.loads(row["report_json"]),
            imported_at=row["imported_at"],
        )


def _memory_projection(
    record: LegacyRecord,
) -> tuple[str, str, str, str, float, bool]:
    suffix = record.record_id[:8]
    if record.kind == "personality":
        return (
            f"Imported Cupcake 1.0 personality [{suffix}]",
            str(record.payload.get("content", "")),
            "instruction",
            "candidate",
            0.5,
            False,
        )
    if record.kind == "thought":
        return (
            f"Legacy thought [{suffix}]",
            str(record.payload.get("content", "")),
            "temporary_context",
            "candidate",
            0.5,
            False,
        )
    if record.kind in {"emotion", "sense"}:
        raise ValueError(f"report-only legacy {record.kind} cannot become memory")
    if record.kind == "chroma_text":
        return (
            f"Recovered legacy memory [{suffix}]",
            str(record.payload.get("content", "")),
            "fact",
            "candidate",
            0.5,
            False,
        )
    raise ValueError(f"record kind does not map to memory: {record.kind}")


def _validate_locator(value: str) -> None:
    normalized = value.replace("\\", "/")
    path = PurePosixPath(normalized)
    lowered = normalized.casefold()
    basename = path.name.casefold()
    if (
        not normalized
        or path.is_absolute()
        or ".." in path.parts
        or posixpath.normpath(normalized) != normalized
        or basename.startswith(".env")
        or any(token in basename for token in ("api_key", "apikey", "credential", "secret"))
        or path.suffix.casefold() in {".py", ".pyc", ".pyo", ".pem", ".key"}
        or "/__pycache__/" in f"/{lowered}/"
        or "/generated/" in f"/{lowered}/"
    ):
        raise ValueError("legacy record contains an unsafe source locator")


def _timestamp(report: MigrationReport) -> str:
    return report.imported_at.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _optional_text(value: object) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
