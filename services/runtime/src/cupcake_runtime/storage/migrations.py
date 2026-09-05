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
    Migration(
        3,
        "pause legacy tasks",
        """
        DROP INDEX legacy_tasks_status_updated;
        ALTER TABLE legacy_tasks RENAME TO legacy_tasks_v2;

        CREATE TABLE legacy_tasks (
            id TEXT PRIMARY KEY,
            migration_id TEXT NOT NULL REFERENCES legacy_migrations(migration_id)
                ON DELETE RESTRICT,
            title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 1000),
            status TEXT NOT NULL CHECK(status IN ('paused', 'completed', 'cancelled')),
            legacy_created_at TEXT,
            canonical_metadata TEXT NOT NULL CHECK(json_valid(canonical_metadata)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(migration_id, id)
        ) STRICT;

        INSERT INTO legacy_tasks(
            id, migration_id, title, status, legacy_created_at,
            canonical_metadata, created_at, updated_at
        )
        SELECT id, migration_id, title,
               CASE WHEN status = 'pending' THEN 'paused' ELSE status END,
               legacy_created_at, canonical_metadata, created_at, updated_at
          FROM legacy_tasks_v2;

        DROP TABLE legacy_tasks_v2;
        CREATE INDEX legacy_tasks_status_updated
            ON legacy_tasks(status, updated_at DESC, id DESC);
        """,
    ),
    Migration(
        4,
        "persistent Cupcake personas and bounded group turns",
        """
        CREATE TABLE personas (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 40),
            handle TEXT NOT NULL COLLATE NOCASE UNIQUE
                CHECK(length(handle) BETWEEN 2 AND 32),
            avatar TEXT NOT NULL DEFAULT '' CHECK(length(avatar) <= 200),
            role TEXT NOT NULL DEFAULT '' CHECK(length(role) <= 120),
            description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 1000),
            instructions TEXT NOT NULL DEFAULT '' CHECK(length(instructions) <= 4000),
            speak_when TEXT NOT NULL DEFAULT '' CHECK(length(speak_when) <= 1000),
            personality_json TEXT NOT NULL CHECK(json_valid(personality_json)),
            model_id TEXT NOT NULL CHECK(length(model_id) BETWEEN 1 AND 500),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            archived_at TEXT
        ) STRICT;

        CREATE TABLE conversation_group_settings (
            conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
            strategy TEXT NOT NULL CHECK(strategy IN ('smart-selective', 'mentions-only')),
            max_replies INTEGER NOT NULL CHECK(max_replies BETWEEN 1 AND 3),
            lead_participant_id TEXT,
            roster_revision INTEGER NOT NULL CHECK(roster_revision >= 1),
            updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE conversation_participants (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE RESTRICT,
            position INTEGER NOT NULL CHECK(position >= 0),
            enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
            added_at TEXT NOT NULL,
            UNIQUE(conversation_id, persona_id),
            UNIQUE(conversation_id, position)
        ) STRICT;
        CREATE INDEX conversation_participants_roster
            ON conversation_participants(conversation_id, enabled, position, id);

        CREATE TABLE group_turns (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            branch_id TEXT NOT NULL REFERENCES conversation_branches(id) ON DELETE RESTRICT,
            user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
            status TEXT NOT NULL CHECK(status IN (
                'running', 'completed', 'waiting_for_you', 'selection_failed',
                'member_failed', 'cancelled', 'awaiting_tool', 'interrupted'
            )),
            mode TEXT NOT NULL CHECK(mode IN ('mentions', 'smart')),
            confirmed_digest TEXT NOT NULL CHECK(length(confirmed_digest) = 64),
            plan_revision TEXT NOT NULL CHECK(length(plan_revision) = 64),
            responder_limit INTEGER NOT NULL CHECK(responder_limit BETWEEN 1 AND 3),
            selector_calls INTEGER NOT NULL DEFAULT 0 CHECK(selector_calls BETWEEN 0 AND 3),
            responder_calls INTEGER NOT NULL DEFAULT 0 CHECK(responder_calls BETWEEN 0 AND 3),
            selector_usage_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(selector_usage_json)),
            plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT
        ) STRICT;
        CREATE INDEX group_turns_conversation_created
            ON group_turns(conversation_id, created_at DESC, id DESC);

        CREATE TABLE group_turn_members (
            turn_id TEXT NOT NULL REFERENCES group_turns(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 3),
            participant_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('selected', 'completed', 'failed', 'cancelled')),
            message_id TEXT REFERENCES messages(id) ON DELETE RESTRICT,
            selection_reason_code TEXT NOT NULL DEFAULT ''
                CHECK(length(selection_reason_code) <= 40),
            selection_reason TEXT NOT NULL DEFAULT '' CHECK(length(selection_reason) <= 120),
            speaker_snapshot_json TEXT NOT NULL CHECK(json_valid(speaker_snapshot_json)),
            usage_snapshot_json TEXT NOT NULL CHECK(json_valid(usage_snapshot_json)),
            error_code TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(turn_id, sequence),
            UNIQUE(turn_id, participant_id)
        ) STRICT;
        """,
    ),
    Migration(
        5,
        "one active group turn per conversation branch",
        """
        CREATE UNIQUE INDEX group_turns_one_running_per_branch
            ON group_turns(conversation_id, branch_id)
            WHERE status = 'running';
        """,
    ),
)


LATEST_SCHEMA_VERSION = MIGRATIONS[-1].version
