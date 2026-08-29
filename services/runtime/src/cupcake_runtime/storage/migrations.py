from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Migration:
    version: int
    description: str
    sql: str


MIGRATIONS: tuple[Migration, ...] = (
    Migration(
        1,
        "initial product schema",
        """
        CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
            description TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            archived_at TEXT
        ) STRICT;

        CREATE TABLE project_files (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            display_name TEXT NOT NULL,
            grant_token TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            media_type TEXT NOT NULL,
            byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
            content_hash TEXT CHECK(content_hash IS NULL OR length(content_hash) = 64),
            parse_status TEXT NOT NULL,
            indexed_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(project_id, grant_token, relative_path)
        ) STRICT;

        CREATE TABLE conversations (
            id TEXT PRIMARY KEY,
            project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
            title TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE conversation_branches (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            forked_from_message_id TEXT,
            head_message_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            branch_id TEXT NOT NULL REFERENCES conversation_branches(id) ON DELETE RESTRICT,
            parent_message_id TEXT REFERENCES messages(id) ON DELETE RESTRICT,
            role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
            content TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('complete', 'cancelled', 'error')),
            model_id TEXT,
            provider_id TEXT,
            run_id TEXT,
            canonical_metadata TEXT NOT NULL CHECK(json_valid(canonical_metadata)),
            created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX messages_conversation_created
            ON messages(conversation_id, created_at, id);
        CREATE INDEX messages_parent ON messages(parent_message_id);

        CREATE TRIGGER messages_immutable_update
        BEFORE UPDATE ON messages BEGIN
            SELECT RAISE(ABORT, 'messages are immutable');
        END;
        CREATE TRIGGER messages_immutable_delete
        BEFORE DELETE ON messages BEGIN
            SELECT RAISE(ABORT, 'messages are immutable');
        END;

        CREATE TABLE artifacts (
            id TEXT PRIMARY KEY,
            project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
            conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
            title TEXT NOT NULL,
            kind TEXT NOT NULL,
            media_type TEXT NOT NULL,
            current_revision_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE artifact_revisions (
            id TEXT PRIMARY KEY,
            artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
            parent_revision_id TEXT REFERENCES artifact_revisions(id) ON DELETE RESTRICT,
            object_id TEXT NOT NULL CHECK(length(object_id) = 64),
            byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
            summary TEXT NOT NULL,
            source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX artifact_revisions_artifact_created
            ON artifact_revisions(artifact_id, created_at, id);
        CREATE TRIGGER artifact_revisions_immutable_update
        BEFORE UPDATE ON artifact_revisions BEGIN
            SELECT RAISE(ABORT, 'artifact revisions are immutable');
        END;
        CREATE TRIGGER artifact_revisions_immutable_delete
        BEFORE DELETE ON artifact_revisions BEGIN
            SELECT RAISE(ABORT, 'artifact revisions are immutable');
        END;

        CREATE TABLE object_metadata (
            object_id TEXT PRIMARY KEY CHECK(length(object_id) = 64),
            byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
            media_type TEXT NOT NULL,
            created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE search_documents (
            row_id INTEGER PRIMARY KEY,
            entity_id TEXT NOT NULL UNIQUE,
            project_id TEXT,
            entity_type TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            updated_at TEXT NOT NULL
        ) STRICT;

        CREATE VIRTUAL TABLE search_fts USING fts5(
            entity_id UNINDEXED,
            project_id UNINDEXED,
            entity_type UNINDEXED,
            title,
            body,
            tokenize = 'unicode61 remove_diacritics 2'
        );

        CREATE TABLE settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL CHECK(json_valid(value_json)),
            updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE runtime_references (
            task_id TEXT PRIMARY KEY,
            dbos_workflow_id TEXT NOT NULL UNIQUE,
            last_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_event_sequence >= 0),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        ) STRICT;
        """,
    ),
    Migration(
        2,
        "legacy import ledger and recovered task records",
        """
        CREATE TABLE legacy_migrations (
            migration_id TEXT PRIMARY KEY,
            importer_version INTEGER NOT NULL CHECK(importer_version >= 1),
            source_fingerprint TEXT NOT NULL UNIQUE CHECK(length(source_fingerprint) = 64),
            status TEXT NOT NULL CHECK(status IN ('imported', 'no_data')),
            report_json TEXT NOT NULL CHECK(json_valid(report_json)),
            imported_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE legacy_migration_decisions (
            source_fingerprint TEXT PRIMARY KEY CHECK(length(source_fingerprint) = 64),
            importer_version INTEGER NOT NULL CHECK(importer_version >= 1),
            state TEXT NOT NULL CHECK(state IN ('previewed', 'declined')),
            report_json TEXT NOT NULL CHECK(json_valid(report_json)),
            updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE legacy_migration_records (
            migration_id TEXT NOT NULL REFERENCES legacy_migrations(migration_id)
                ON DELETE CASCADE,
            record_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            source_locator TEXT NOT NULL,
            entity_id TEXT,
            imported_at TEXT NOT NULL,
            PRIMARY KEY(migration_id, record_id)
        ) STRICT;

        CREATE TABLE legacy_tasks (
            id TEXT PRIMARY KEY,
            migration_id TEXT NOT NULL REFERENCES legacy_migrations(migration_id)
                ON DELETE RESTRICT,
            title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 1000),
            status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'cancelled')),
            legacy_created_at TEXT,
            canonical_metadata TEXT NOT NULL CHECK(json_valid(canonical_metadata)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(migration_id, id)
        ) STRICT;

        CREATE INDEX legacy_tasks_status_updated
            ON legacy_tasks(status, updated_at DESC, id DESC);
        """,
    ),
)


LATEST_SCHEMA_VERSION = MIGRATIONS[-1].version
