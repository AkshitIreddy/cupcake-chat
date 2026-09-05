from __future__ import annotations

import json
import re
import sqlite3
from datetime import UTC, datetime
from typing import Any

from cupcake_runtime.domain.errors import ConflictError, NotFoundError, ProjectBoundaryViolation
from cupcake_runtime.domain.models import (
    Artifact,
    ArtifactKind,
    ArtifactRevision,
    Conversation,
    ConversationBranch,
    ConversationStatus,
    Message,
    MessageRole,
    MessageState,
    ObjectMetadata,
    Project,
    ProjectFile,
    SearchDocument,
    SearchEntityType,
    SearchResult,
    Setting,
    utc_now,
)
from cupcake_runtime.storage.database import Database


def _timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _datetime(value: str | None) -> datetime | None:
    return None if value is None else datetime.fromisoformat(value.replace("Z", "+00:00"))


def _required_datetime(value: str | None) -> datetime:
    parsed = _datetime(value)
    if parsed is None:
        raise RuntimeError("product row is missing a required timestamp")
    return parsed


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class ProductRepository:
    """Transactional product repository.

    Every graph mutation validates conversation/project ownership and advances a
    mutable head with compare-and-swap semantics. Message and artifact revision
    rows themselves are protected by database triggers and never updated.
    """

    def __init__(self, database: Database) -> None:
        self.database = database

    # Projects and granted files -------------------------------------------------
    def create_project(self, name: str, description: str = "") -> Project:
        project = Project(name=name, description=description)
        with self.database.transaction() as connection:
            connection.execute(
                "INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)",
                (
                    project.id,
                    project.name,
                    project.description,
                    _timestamp(project.created_at),
                    _timestamp(project.updated_at),
                    None,
                ),
            )
            self._upsert_search(
                connection,
                SearchDocument(
                    entity_id=project.id,
                    project_id=project.id,
                    entity_type=SearchEntityType.PROJECT,
                    title=project.name,
                    body=project.description,
                ),
            )
        return project

    def get_project(self, project_id: str) -> Project:
        row = self.database.connection.execute(
            "SELECT * FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
        if row is None:
            raise NotFoundError(f"project not found: {project_id}")
        return self._project(row)

    def list_projects(self, *, include_archived: bool = False) -> tuple[Project, ...]:
        where = "" if include_archived else "WHERE archived_at IS NULL"
        rows = self.database.connection.execute(
            f"SELECT * FROM projects {where} ORDER BY updated_at DESC, id DESC"
        ).fetchall()
        return tuple(self._project(row) for row in rows)

    def update_project(
        self,
        project_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
    ) -> Project:
        """Update mutable project metadata without changing project identity or scope."""
        current = self.get_project(project_id)
        next_name = current.name if name is None else name.strip()
        next_description = current.description if description is None else description.strip()
        if not next_name or len(next_name) > 200:
            raise ValueError("project name must contain 1..200 characters")
        if len(next_description) > 10_000:
            raise ValueError("project description exceeds 10000 characters")
        now = utc_now()
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE projects SET name=?, description=?, updated_at=? WHERE id=?",
                (next_name, next_description, _timestamp(now), project_id),
            )
            self._upsert_search(
                connection,
                SearchDocument(
                    entity_id=project_id,
                    project_id=project_id,
                    entity_type=SearchEntityType.PROJECT,
                    title=next_name,
                    body=next_description,
                    updated_at=now,
                ),
            )
        return self.get_project(project_id)

    def set_project_archived(self, project_id: str, *, archived: bool) -> Project:
        """Soft-delete or restore a project while retaining its immutable history."""
        self.get_project(project_id)
        now = utc_now()
        archived_at = _timestamp(now) if archived else None
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE projects SET archived_at=?, updated_at=? WHERE id=?",
                (archived_at, _timestamp(now), project_id),
            )
            if archived:
                connection.execute(
                    "DELETE FROM search_fts WHERE rowid IN "
                    "(SELECT row_id FROM search_documents WHERE entity_id=?)",
                    (project_id,),
                )
                connection.execute("DELETE FROM search_documents WHERE entity_id=?", (project_id,))
            else:
                project = self.get_project(project_id)
                self._upsert_search(
                    connection,
                    SearchDocument(
                        entity_id=project.id,
                        project_id=project.id,
                        entity_type=SearchEntityType.PROJECT,
                        title=project.name,
                        body=project.description,
                        updated_at=now,
                    ),
                )
        return self.get_project(project_id)

    def upsert_project_file(self, project_file: ProjectFile) -> ProjectFile:
        self.get_project(project_file.project_id)
        with self.database.transaction() as connection:
            connection.execute(
                """INSERT INTO project_files(
                    id, project_id, display_name, grant_token, relative_path, media_type,
                    byte_size, content_hash, parse_status, indexed_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(project_id, grant_token, relative_path) DO UPDATE SET
                    display_name=excluded.display_name, media_type=excluded.media_type,
                    byte_size=excluded.byte_size, content_hash=excluded.content_hash,
                    parse_status=excluded.parse_status, indexed_at=excluded.indexed_at,
                    updated_at=excluded.updated_at""",
                (
                    project_file.id,
                    project_file.project_id,
                    project_file.display_name,
                    project_file.grant_token,
                    project_file.relative_path,
                    project_file.media_type,
                    project_file.byte_size,
                    project_file.content_hash,
                    project_file.parse_status,
                    _timestamp(project_file.indexed_at) if project_file.indexed_at else None,
                    _timestamp(project_file.created_at),
                    _timestamp(project_file.updated_at),
                ),
            )
            row = connection.execute(
                """SELECT * FROM project_files
                   WHERE project_id=? AND grant_token=? AND relative_path=?""",
                (project_file.project_id, project_file.grant_token, project_file.relative_path),
            ).fetchone()
        assert row is not None
        return self._project_file(row)

    def list_project_files(self, project_id: str) -> tuple[ProjectFile, ...]:
        self.get_project(project_id)
        rows = self.database.connection.execute(
            "SELECT * FROM project_files WHERE project_id=? ORDER BY relative_path COLLATE NOCASE",
            (project_id,),
        ).fetchall()
        return tuple(self._project_file(row) for row in rows)

    def get_project_file_for_source(
        self,
        project_id: str,
        *,
        file_id: str | None = None,
        source_id: str | None = None,
    ) -> ProjectFile:
        """Resolve an indexed file only within its authoritative project scope."""
        if not project_id.strip() or (not file_id and not source_id):
            raise ValueError("project_id and a file or source ID are required")
        clauses = ["project_id = ?"]
        arguments: list[object] = [project_id]
        if file_id:
            clauses.append("id = ?")
            arguments.append(file_id)
        if source_id:
            clauses.append("grant_token = ?")
            arguments.append(source_id)
        row = self.database.connection.execute(
            "SELECT * FROM project_files WHERE " + " AND ".join(clauses), arguments
        ).fetchone()
        if row is None:
            # Deliberately do not disclose whether either identifier exists in a
            # different project.
            raise NotFoundError("project file is unavailable in this context")
        return self._project_file(row)

    # Conversations and immutable messages --------------------------------------
    def create_conversation(
        self, title: str = "New conversation", *, project_id: str | None = None
    ) -> tuple[Conversation, ConversationBranch]:
        if project_id:
            self.get_project(project_id)
        conversation = Conversation(project_id=project_id, title=title)
        branch = ConversationBranch(conversation_id=conversation.id)
        with self.database.transaction() as connection:
            connection.execute(
                "INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?)",
                (
                    conversation.id,
                    conversation.project_id,
                    conversation.title,
                    conversation.status.value,
                    _timestamp(conversation.created_at),
                    _timestamp(conversation.updated_at),
                ),
            )
            connection.execute(
                "INSERT INTO conversation_branches VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    branch.id,
                    branch.conversation_id,
                    branch.name,
                    None,
                    None,
                    _timestamp(branch.created_at),
                    _timestamp(branch.updated_at),
                ),
            )
            self._upsert_search(
                connection,
                SearchDocument(
                    entity_id=conversation.id,
                    project_id=project_id,
                    entity_type=SearchEntityType.CONVERSATION,
                    title=title,
                ),
            )
        return conversation, branch

    def get_conversation(self, conversation_id: str) -> Conversation:
        row = self.database.connection.execute(
            "SELECT * FROM conversations WHERE id=?", (conversation_id,)
        ).fetchone()
        if row is None:
            raise NotFoundError(f"conversation not found: {conversation_id}")
        return self._conversation(row)

    def list_conversations(
        self,
        *,
        project_id: str | None = None,
        include_archived: bool = False,
        limit: int = 500,
    ) -> tuple[Conversation, ...]:
        """List conversations without weakening project isolation.

        ``project_id=None`` intentionally means the whole local profile for the
        global Chats screen. Callers serving project-scoped model context must
        pass the project id explicitly and must not merge this result with a
        second project.
        """
        if not 1 <= limit <= 2_000:
            raise ValueError("limit must be between 1 and 2000")
        clauses: list[str] = []
        arguments: list[object] = []
        if project_id is not None:
            self.get_project(project_id)
            clauses.append("project_id = ?")
            arguments.append(project_id)
        if not include_archived:
            clauses.append("status = ?")
            arguments.append(ConversationStatus.ACTIVE.value)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        arguments.append(limit)
        rows = self.database.connection.execute(
            f"""SELECT * FROM conversations {where}
                ORDER BY updated_at DESC, id DESC LIMIT ?""",
            arguments,
        ).fetchall()
        return tuple(self._conversation(row) for row in rows)

    def list_branches(self, conversation_id: str) -> tuple[ConversationBranch, ...]:
        self.get_conversation(conversation_id)
        rows = self.database.connection.execute(
            """SELECT * FROM conversation_branches
               WHERE conversation_id=? ORDER BY created_at, id""",
            (conversation_id,),
        ).fetchall()
        return tuple(self._branch(row) for row in rows)

    def rename_conversation(self, conversation_id: str, title: str) -> Conversation:
        title = title.strip()
        if not title or len(title) > 500:
            raise ValueError("conversation title must contain 1..500 characters")
        now = utc_now()
        with self.database.transaction() as connection:
            changed = connection.execute(
                "UPDATE conversations SET title=?, updated_at=? WHERE id=?",
                (title, _timestamp(now), conversation_id),
            ).rowcount
            if changed != 1:
                raise NotFoundError(f"conversation not found: {conversation_id}")
            project = connection.execute(
                "SELECT project_id FROM conversations WHERE id=?", (conversation_id,)
            ).fetchone()
            self._upsert_search(
                connection,
                SearchDocument(
                    entity_id=conversation_id,
                    project_id=project["project_id"],
                    entity_type=SearchEntityType.CONVERSATION,
                    title=title,
                    updated_at=now,
                ),
            )
        return self.get_conversation(conversation_id)

    def set_conversation_status(
        self, conversation_id: str, status: ConversationStatus
    ) -> Conversation:
        now = utc_now()
        with self.database.transaction() as connection:
            changed = connection.execute(
                "UPDATE conversations SET status=?, updated_at=? WHERE id=?",
                (status.value, _timestamp(now), conversation_id),
            ).rowcount
            if changed != 1:
                raise NotFoundError(f"conversation not found: {conversation_id}")
            if status is ConversationStatus.ARCHIVED:
                connection.execute(
                    "DELETE FROM search_fts WHERE rowid IN "
                    "(SELECT row_id FROM search_documents WHERE entity_id=?)",
                    (conversation_id,),
                )
                connection.execute(
                    "DELETE FROM search_documents WHERE entity_id=?", (conversation_id,)
                )
        return self.get_conversation(conversation_id)

    def get_branch(self, branch_id: str) -> ConversationBranch:
        row = self.database.connection.execute(
            "SELECT * FROM conversation_branches WHERE id=?", (branch_id,)
        ).fetchone()
        if row is None:
            raise NotFoundError(f"conversation branch not found: {branch_id}")
        return self._branch(row)

    def append_message(
        self,
        branch_id: str,
        *,
        role: MessageRole,
        content: str,
        expected_head_id: str | None,
        state: MessageState = MessageState.COMPLETE,
        model_id: str | None = None,
        provider_id: str | None = None,
        run_id: str | None = None,
        canonical_metadata: dict[str, Any] | None = None,
    ) -> Message:
        now = utc_now()
        with self.database.transaction() as connection:
            branch_row = connection.execute(
                "SELECT * FROM conversation_branches WHERE id=?", (branch_id,)
            ).fetchone()
            if branch_row is None:
                raise NotFoundError(f"conversation branch not found: {branch_id}")
            current_head = branch_row["head_message_id"]
            if current_head != expected_head_id:
                raise ConflictError(
                    f"branch head changed: expected {expected_head_id!r}, found {current_head!r}"
                )
            message = Message(
                conversation_id=branch_row["conversation_id"],
                branch_id=branch_id,
                parent_message_id=current_head,
                role=role,
                content=content,
                state=state,
                model_id=model_id,
                provider_id=provider_id,
                run_id=run_id,
                canonical_metadata=canonical_metadata or {},
                created_at=now,
            )
            connection.execute(
                """INSERT INTO messages(
                    id, conversation_id, branch_id, parent_message_id, role, content, state,
                    model_id, provider_id, run_id, canonical_metadata, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    message.id,
                    message.conversation_id,
                    message.branch_id,
                    message.parent_message_id,
                    message.role.value,
                    message.content,
                    message.state.value,
                    message.model_id,
                    message.provider_id,
                    message.run_id,
                    _json(message.canonical_metadata),
                    _timestamp(message.created_at),
                ),
            )
            changed = connection.execute(
                """UPDATE conversation_branches SET head_message_id=?, updated_at=?
                   WHERE id=? AND head_message_id IS ?""",
                (message.id, _timestamp(now), branch_id, current_head),
            ).rowcount
            if changed != 1:
                raise ConflictError("branch head was concurrently modified")
            connection.execute(
                "UPDATE conversations SET updated_at=? WHERE id=?",
                (_timestamp(now), message.conversation_id),
            )
            conversation = connection.execute(
                "SELECT project_id FROM conversations WHERE id=?", (message.conversation_id,)
            ).fetchone()
            self._upsert_search(
                connection,
                SearchDocument(
                    entity_id=message.id,
                    project_id=conversation["project_id"],
                    entity_type=SearchEntityType.MESSAGE,
                    title=f"{message.role.value.title()} message",
                    body=message.content,
                    updated_at=now,
                ),
            )
        return message

    def fork_branch(
        self, conversation_id: str, from_message_id: str | None, *, name: str = "Branch"
    ) -> ConversationBranch:
        self.get_conversation(conversation_id)
        if from_message_id:
            source = self.get_message(from_message_id)
            if source.conversation_id != conversation_id:
                raise ConflictError("fork source does not belong to conversation")
        branch = ConversationBranch(
            conversation_id=conversation_id,
            name=name,
            forked_from_message_id=from_message_id,
            head_message_id=from_message_id,
        )
        with self.database.transaction() as connection:
            connection.execute(
                "INSERT INTO conversation_branches VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    branch.id,
                    branch.conversation_id,
                    branch.name,
                    branch.forked_from_message_id,
                    branch.head_message_id,
                    _timestamp(branch.created_at),
                    _timestamp(branch.updated_at),
                ),
            )
        return branch

    def get_message(self, message_id: str) -> Message:
        row = self.database.connection.execute(
            "SELECT * FROM messages WHERE id=?", (message_id,)
        ).fetchone()
        if row is None:
            raise NotFoundError(f"message not found: {message_id}")
        return self._message(row)

    def branch_history(self, branch_id: str) -> tuple[Message, ...]:
        branch = self.get_branch(branch_id)
        history: list[Message] = []
        seen: set[str] = set()
        message_id = branch.head_message_id
        while message_id:
            if message_id in seen:
                raise RuntimeError("message graph contains a cycle")
            seen.add(message_id)
            message = self.get_message(message_id)
            if message.conversation_id != branch.conversation_id:
                raise RuntimeError("message graph crosses conversation boundary")
            history.append(message)
            message_id = message.parent_message_id
        history.reverse()
        return tuple(history)

    # Artifacts and immutable revisions ------------------------------------------
    def create_artifact(
        self,
        title: str,
        kind: ArtifactKind,
        media_type: str,
        *,
        project_id: str | None = None,
        conversation_id: str | None = None,
    ) -> Artifact:
        if project_id:
            self.get_project(project_id)
        if conversation_id:
            conversation = self.get_conversation(conversation_id)
            if conversation.project_id != project_id:
                raise ProjectBoundaryViolation(
                    "artifact and conversation must belong to the same project scope"
                )
        artifact = Artifact(
            title=title,
            kind=kind,
            media_type=media_type,
            project_id=project_id,
            conversation_id=conversation_id,
        )
        with self.database.transaction() as connection:
            connection.execute(
                "INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    artifact.id,
                    artifact.project_id,
                    artifact.conversation_id,
                    artifact.title,
                    artifact.kind.value,
                    artifact.media_type,
                    None,
                    _timestamp(artifact.created_at),
                    _timestamp(artifact.updated_at),
                ),
            )
            self._upsert_search(
                connection,
                SearchDocument(
                    entity_id=artifact.id,
                    project_id=project_id,
                    entity_type=SearchEntityType.ARTIFACT,
                    title=title,
                ),
            )
        return artifact

    def add_artifact_revision(
        self,
        artifact_id: str,
        *,
        object_id: str,
        byte_size: int,
        expected_head_id: str | None,
        summary: str = "",
        source_message_id: str | None = None,
    ) -> ArtifactRevision:
        now = utc_now()
        with self.database.transaction() as connection:
            artifact = connection.execute(
                "SELECT * FROM artifacts WHERE id=?", (artifact_id,)
            ).fetchone()
            if artifact is None:
                raise NotFoundError(f"artifact not found: {artifact_id}")
            if artifact["current_revision_id"] != expected_head_id:
                raise ConflictError("artifact head changed")
            if source_message_id:
                message = connection.execute(
                    "SELECT conversation_id FROM messages WHERE id=?", (source_message_id,)
                ).fetchone()
                if message is None:
                    raise NotFoundError(f"source message not found: {source_message_id}")
                if (
                    artifact["conversation_id"]
                    and message["conversation_id"] != artifact["conversation_id"]
                ):
                    raise ProjectBoundaryViolation(
                        "source message is outside the artifact conversation"
                    )
            revision = ArtifactRevision(
                artifact_id=artifact_id,
                parent_revision_id=expected_head_id,
                object_id=object_id,
                byte_size=byte_size,
                summary=summary,
                source_message_id=source_message_id,
                created_at=now,
            )
            connection.execute(
                "INSERT INTO artifact_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    revision.id,
                    revision.artifact_id,
                    revision.parent_revision_id,
                    revision.object_id,
                    revision.byte_size,
                    revision.summary,
                    revision.source_message_id,
                    _timestamp(revision.created_at),
                ),
            )
            changed = connection.execute(
                """UPDATE artifacts SET current_revision_id=?, updated_at=?
                   WHERE id=? AND current_revision_id IS ?""",
                (revision.id, _timestamp(now), artifact_id, expected_head_id),
            ).rowcount
            if changed != 1:
                raise ConflictError("artifact head was concurrently modified")
            doc = connection.execute(
                "SELECT title, project_id FROM search_documents WHERE entity_id=?", (artifact_id,)
            ).fetchone()
            self._upsert_search(
                connection,
                SearchDocument(
                    entity_id=artifact_id,
                    project_id=doc["project_id"],
                    entity_type=SearchEntityType.ARTIFACT,
                    title=doc["title"],
                    body=summary,
                    updated_at=now,
                ),
            )
        return revision

    def get_artifact(self, artifact_id: str) -> Artifact:
        row = self.database.connection.execute(
            "SELECT * FROM artifacts WHERE id=?", (artifact_id,)
        ).fetchone()
        if row is None:
            raise NotFoundError(f"artifact not found: {artifact_id}")
        return self._artifact(row)

    def artifact_history(self, artifact_id: str) -> tuple[ArtifactRevision, ...]:
        artifact = self.get_artifact(artifact_id)
        history: list[ArtifactRevision] = []
        seen: set[str] = set()
        revision_id = artifact.current_revision_id
        while revision_id:
            if revision_id in seen:
                raise RuntimeError("artifact revision graph contains a cycle")
            seen.add(revision_id)
            row = self.database.connection.execute(
                "SELECT * FROM artifact_revisions WHERE id=?", (revision_id,)
            ).fetchone()
            if row is None or row["artifact_id"] != artifact_id:
                raise RuntimeError("artifact revision graph is corrupt")
            revision = self._artifact_revision(row)
            history.append(revision)
            revision_id = revision.parent_revision_id
        history.reverse()
        return tuple(history)

    # Objects, search, and settings ----------------------------------------------
    def record_object(self, metadata: ObjectMetadata) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                """INSERT INTO object_metadata(object_id, byte_size, media_type, created_at)
                   VALUES (?, ?, ?, ?) ON CONFLICT(object_id) DO NOTHING""",
                (
                    metadata.object_id,
                    metadata.byte_size,
                    metadata.media_type,
                    _timestamp(metadata.created_at),
                ),
            )

    def reachable_object_ids(self) -> tuple[str, ...]:
        rows = self.database.connection.execute(
            """SELECT object_id FROM (
                   SELECT DISTINCT r.object_id AS object_id
                   FROM artifact_revisions r
                   JOIN artifacts a ON a.id = r.artifact_id
                   UNION
                   SELECT DISTINCT f.content_hash AS object_id
                   FROM project_files f
                   JOIN object_metadata o ON o.object_id = f.content_hash
                   WHERE f.content_hash IS NOT NULL
               ) ORDER BY object_id"""
        ).fetchall()
        return tuple(str(row[0]) for row in rows)

    def index_document(self, document: SearchDocument) -> None:
        with self.database.transaction() as connection:
            self._upsert_search(connection, document)

    def remove_search_document(self, entity_id: str) -> None:
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT row_id FROM search_documents WHERE entity_id=?", (entity_id,)
            ).fetchone()
            if row is not None:
                connection.execute("DELETE FROM search_fts WHERE rowid=?", (row["row_id"],))
            connection.execute("DELETE FROM search_documents WHERE entity_id=?", (entity_id,))

    def search(
        self,
        query: str,
        *,
        project_id: str | None = None,
        global_scope: bool = False,
        entity_types: tuple[SearchEntityType, ...] = (),
        limit: int = 50,
    ) -> tuple[SearchResult, ...]:
        fts_query = self._fts_query(query)
        if not fts_query:
            return ()
        if limit < 1 or limit > 200:
            raise ValueError("limit must be between 1 and 200")
        if project_id is None and not global_scope:
            raise ProjectBoundaryViolation(
                "search requires an explicit project_id or global_scope=True"
            )
        clauses = ["search_fts MATCH ?"]
        parameters: list[Any] = [fts_query]
        if project_id is not None:
            clauses.append("d.project_id = ?")
            parameters.append(project_id)
        if entity_types:
            placeholders = ",".join("?" for _ in entity_types)
            clauses.append(f"d.entity_type IN ({placeholders})")
            parameters.extend(entity_type.value for entity_type in entity_types)
        parameters.append(limit)
        rows = self.database.connection.execute(
            f"""SELECT d.entity_id, d.project_id, d.entity_type, d.title,
                       snippet(search_fts, 4, '<mark>', '</mark>', ' … ', 24) AS snippet,
                       bm25(search_fts, 0.0, 0.0, 0.0, 4.0, 1.0) AS rank
                FROM search_fts
                JOIN search_documents d ON d.row_id = search_fts.rowid
                WHERE {" AND ".join(clauses)}
                ORDER BY rank, d.updated_at DESC LIMIT ?""",
            parameters,
        ).fetchall()
        return tuple(
            SearchResult(
                entity_id=row["entity_id"],
                project_id=row["project_id"],
                entity_type=SearchEntityType(row["entity_type"]),
                title=row["title"],
                snippet=row["snippet"],
                score=-float(row["rank"]),
            )
            for row in rows
        )

    def set_setting(self, setting: Setting) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                """INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
                   ON CONFLICT(key) DO UPDATE SET
                       value_json=excluded.value_json, updated_at=excluded.updated_at""",
                (setting.key, _json(setting.value), _timestamp(setting.updated_at)),
            )

    def get_setting(self, key: str, *, default: Any = None) -> Any:
        row = self.database.connection.execute(
            "SELECT value_json FROM settings WHERE key=?", (key,)
        ).fetchone()
        return default if row is None else json.loads(row["value_json"])

    def link_dbos_workflow(self, task_id: str, workflow_id: str) -> None:
        """Persist only a stable DBOS identifier, never framework-owned state."""
        now = _timestamp(utc_now())
        with self.database.transaction() as connection:
            connection.execute(
                """INSERT INTO runtime_references(
                    task_id, dbos_workflow_id, last_event_sequence, created_at, updated_at
                ) VALUES (?, ?, 0, ?, ?)
                ON CONFLICT(task_id) DO UPDATE SET
                    dbos_workflow_id=excluded.dbos_workflow_id, updated_at=excluded.updated_at""",
                (task_id, workflow_id, now, now),
            )

    @staticmethod
    def _fts_query(value: str) -> str:
        """Compile user text to a bounded literal AND query.

        FTS5 has its own operator grammar. Passing user text through directly
        makes punctuation produce syntax errors and allows accidental broad
        expressions such as ``OR`` or ``NOT``. Product search is literal by
        default; a future advanced-search parser can expose operators explicitly.
        """
        terms = re.findall(r"[\w'-]+", value.casefold(), flags=re.UNICODE)[:32]
        return " AND ".join(f'"{term.replace(chr(34), chr(34) * 2)}"' for term in terms)

    @staticmethod
    def _upsert_search(connection: sqlite3.Connection, document: SearchDocument) -> None:
        existing = connection.execute(
            "SELECT row_id FROM search_documents WHERE entity_id=?", (document.entity_id,)
        ).fetchone()
        if existing is not None:
            connection.execute("DELETE FROM search_fts WHERE rowid=?", (existing["row_id"],))
        connection.execute(
            """INSERT INTO search_documents(
                entity_id, project_id, entity_type, title, body, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(entity_id) DO UPDATE SET
                project_id=excluded.project_id, entity_type=excluded.entity_type,
                title=excluded.title, body=excluded.body, updated_at=excluded.updated_at""",
            (
                document.entity_id,
                document.project_id,
                document.entity_type.value,
                document.title,
                document.body,
                _timestamp(document.updated_at),
            ),
        )
        row = connection.execute(
            "SELECT row_id FROM search_documents WHERE entity_id=?", (document.entity_id,)
        ).fetchone()
        assert row is not None
        connection.execute(
            """INSERT INTO search_fts(
                rowid, entity_id, project_id, entity_type, title, body
            ) VALUES (?, ?, ?, ?, ?, ?)""",
            (
                row["row_id"],
                document.entity_id,
                document.project_id,
                document.entity_type.value,
                document.title,
                document.body,
            ),
        )

    @staticmethod
    def _project(row: sqlite3.Row) -> Project:
        return Project(
            id=row["id"],
            name=row["name"],
            description=row["description"],
            created_at=_required_datetime(row["created_at"]),
            updated_at=_required_datetime(row["updated_at"]),
            archived_at=_datetime(row["archived_at"]),
        )

    @staticmethod
    def _project_file(row: sqlite3.Row) -> ProjectFile:
        return ProjectFile(
            id=row["id"],
            project_id=row["project_id"],
            display_name=row["display_name"],
            grant_token=row["grant_token"],
            relative_path=row["relative_path"],
            media_type=row["media_type"],
            byte_size=row["byte_size"],
            content_hash=row["content_hash"],
            parse_status=row["parse_status"],
            indexed_at=_datetime(row["indexed_at"]),
            created_at=_required_datetime(row["created_at"]),
            updated_at=_required_datetime(row["updated_at"]),
        )

    @staticmethod
    def _conversation(row: sqlite3.Row) -> Conversation:
        return Conversation(
            id=row["id"],
            project_id=row["project_id"],
            title=row["title"],
            status=ConversationStatus(row["status"]),
            created_at=_required_datetime(row["created_at"]),
            updated_at=_required_datetime(row["updated_at"]),
        )

    @staticmethod
    def _branch(row: sqlite3.Row) -> ConversationBranch:
        return ConversationBranch(
            id=row["id"],
            conversation_id=row["conversation_id"],
            name=row["name"],
            forked_from_message_id=row["forked_from_message_id"],
            head_message_id=row["head_message_id"],
            created_at=_required_datetime(row["created_at"]),
            updated_at=_required_datetime(row["updated_at"]),
        )

    @staticmethod
    def _message(row: sqlite3.Row) -> Message:
        return Message(
            id=row["id"],
            conversation_id=row["conversation_id"],
            branch_id=row["branch_id"],
            parent_message_id=row["parent_message_id"],
            role=MessageRole(row["role"]),
            content=row["content"],
            state=MessageState(row["state"]),
            model_id=row["model_id"],
            provider_id=row["provider_id"],
            run_id=row["run_id"],
            canonical_metadata=json.loads(row["canonical_metadata"]),
            created_at=_required_datetime(row["created_at"]),
        )

    @staticmethod
    def _artifact(row: sqlite3.Row) -> Artifact:
        return Artifact(
            id=row["id"],
            project_id=row["project_id"],
            conversation_id=row["conversation_id"],
            title=row["title"],
            kind=ArtifactKind(row["kind"]),
            media_type=row["media_type"],
            current_revision_id=row["current_revision_id"],
            created_at=_required_datetime(row["created_at"]),
            updated_at=_required_datetime(row["updated_at"]),
        )

    @staticmethod
    def _artifact_revision(row: sqlite3.Row) -> ArtifactRevision:
        return ArtifactRevision(
            id=row["id"],
            artifact_id=row["artifact_id"],
            parent_revision_id=row["parent_revision_id"],
            object_id=row["object_id"],
            byte_size=row["byte_size"],
            summary=row["summary"],
            source_message_id=row["source_message_id"],
            created_at=_required_datetime(row["created_at"]),
        )
