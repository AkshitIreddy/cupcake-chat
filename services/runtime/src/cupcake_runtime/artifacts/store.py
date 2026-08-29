from __future__ import annotations

import os
import re
import tempfile
from contextlib import suppress
from pathlib import Path
from typing import Protocol

from cupcake_runtime.domain.errors import ConflictError
from cupcake_runtime.domain.models import Artifact as DomainArtifact
from cupcake_runtime.domain.models import ArtifactKind as DomainArtifactKind
from cupcake_runtime.domain.models import ArtifactRevision as DomainArtifactRevision
from cupcake_runtime.domain.models import ObjectMetadata
from cupcake_runtime.storage.repositories import ProductRepository

from .models import (
    Artifact,
    ArtifactKind,
    ArtifactRevision,
    ArtifactSnapshot,
    ExportResult,
    RevisionConflictError,
)


class ObjectStore(Protocol):
    """The encrypted runtime object store satisfies this narrow interface."""

    def put(self, content: bytes) -> str: ...

    def get(self, object_id: str) -> bytes: ...


class ArtifactStore:
    """Artifact editing/export facade over the authoritative repository.

    Revisions and mutable heads remain owned by ``ProductRepository``; payloads
    remain encrypted, immutable objects. This service creates no parallel tables.
    """

    def __init__(self, repository: ProductRepository, *, objects: ObjectStore) -> None:
        self._repository = repository
        self._objects = objects

    def create(
        self,
        *,
        project_id: str,
        title: str,
        kind: ArtifactKind,
        mime_type: str,
        content: bytes | str,
        author_kind: str = "user",
        conversation_id: str | None = None,
        source_message_id: str | None = None,
    ) -> ArtifactSnapshot:
        if not project_id.strip() or not title.strip() or not mime_type.strip():
            raise ValueError("project_id, title, and mime_type are required")
        self._validate_source_message(project_id, source_message_id)
        payload = content.encode("utf-8") if isinstance(content, str) else bytes(content)
        digest = self._objects.put(payload)
        self._repository.record_object(
            ObjectMetadata(object_id=digest, byte_size=len(payload), media_type=mime_type)
        )
        artifact = self._repository.create_artifact(
            title.strip(),
            DomainArtifactKind(kind.value),
            mime_type,
            project_id=project_id,
            conversation_id=conversation_id,
        )
        summary = (
            "Initial revision" if author_kind == "user" else f"Initial revision by {author_kind}"
        )
        revision = self._repository.add_artifact_revision(
            artifact.id,
            object_id=digest,
            byte_size=len(payload),
            expected_head_id=None,
            summary=summary,
            source_message_id=source_message_id,
        )
        artifact = self._repository.get_artifact(artifact.id)
        return ArtifactSnapshot(
            self._artifact(artifact), self._revision(revision, author_kind=author_kind), payload
        )

    def edit(
        self,
        artifact_id: str,
        *,
        project_id: str,
        expected_parent_revision_id: str,
        content: bytes | str,
        author_kind: str,
        change_summary: str | None = None,
        source_message_id: str | None = None,
    ) -> ArtifactSnapshot:
        artifact = self._qualified_artifact(artifact_id, project_id)
        self._validate_source_message(project_id, source_message_id)
        payload = content.encode("utf-8") if isinstance(content, str) else bytes(content)
        digest = self._objects.put(payload)
        self._repository.record_object(
            ObjectMetadata(
                object_id=digest,
                byte_size=len(payload),
                media_type=artifact.media_type,
            )
        )
        try:
            revision = self._repository.add_artifact_revision(
                artifact_id,
                object_id=digest,
                byte_size=len(payload),
                expected_head_id=expected_parent_revision_id,
                summary=change_summary or f"Revision by {author_kind}",
                source_message_id=source_message_id,
            )
        except ConflictError as exc:
            raise RevisionConflictError(str(exc)) from exc
        updated = self._repository.get_artifact(artifact_id)
        return ArtifactSnapshot(
            self._artifact(updated), self._revision(revision, author_kind=author_kind), payload
        )

    def get(
        self, artifact_id: str, *, project_id: str, revision_id: str | None = None
    ) -> ArtifactSnapshot:
        artifact = self._qualified_artifact(artifact_id, project_id)
        history = self._repository.artifact_history(artifact_id)
        selected_id = revision_id or artifact.current_revision_id
        revision = next((item for item in history if item.id == selected_id), None)
        if revision is None:
            raise KeyError(selected_id)
        return ArtifactSnapshot(
            self._artifact(artifact),
            self._revision(revision),
            self._objects.get(revision.object_id),
        )

    def history(self, artifact_id: str, *, project_id: str) -> list[ArtifactRevision]:
        self._qualified_artifact(artifact_id, project_id)
        return [self._revision(item) for item in self._repository.artifact_history(artifact_id)]

    def list_project(self, project_id: str, *, limit: int = 100) -> list[Artifact]:
        if not 1 <= limit <= 500:
            raise ValueError("limit must be between 1 and 500")
        self._repository.get_project(project_id)
        rows = self._repository.database.connection.execute(
            """SELECT id FROM artifacts WHERE project_id = ?
               ORDER BY updated_at DESC, id DESC LIMIT ?""",
            (project_id, limit),
        ).fetchall()
        return [self._artifact(self._repository.get_artifact(row["id"])) for row in rows]

    def export(
        self,
        artifact_id: str,
        *,
        project_id: str,
        destination: str | Path,
        granted_root: str | Path,
        revision_id: str | None = None,
        overwrite: bool = False,
    ) -> ExportResult:
        snapshot = self.get(artifact_id, project_id=project_id, revision_id=revision_id)
        root = Path(granted_root).resolve(strict=True)
        target = Path(destination)
        if target.name in {"", ".", ".."}:
            raise ValueError("export destination must name a file")
        target_parent = target.parent.resolve(strict=True)
        if not target_parent.is_relative_to(root):
            raise ValueError("export destination escapes its granted root")
        if target.is_symlink():
            raise ValueError("refusing to export through a symbolic link")
        if target.exists() and not overwrite:
            raise FileExistsError(target)

        descriptor, temporary_name = tempfile.mkstemp(prefix=".cupcake-export-", dir=target_parent)
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(snapshot.content)
                handle.flush()
                os.fsync(handle.fileno())
            if overwrite:
                os.replace(temporary, target)
            else:
                try:
                    os.link(temporary, target)
                except FileExistsError:
                    raise FileExistsError(target) from None
                except OSError:
                    self._exclusive_copy(temporary, target)
        finally:
            with suppress(FileNotFoundError):
                temporary.unlink()
        return ExportResult(
            artifact_id=artifact_id,
            revision_id=snapshot.revision.id,
            destination=str(target),
            byte_size=len(snapshot.content),
        )

    @staticmethod
    def immutable_link(artifact_id: str, revision_id: str) -> str:
        if not artifact_id or not revision_id:
            raise ValueError("artifact and revision IDs are required")
        return f"cupcake-artifact://{artifact_id}/revisions/{revision_id}"

    def _qualified_artifact(self, artifact_id: str, project_id: str) -> DomainArtifact:
        artifact = self._repository.get_artifact(artifact_id)
        if artifact.project_id != project_id:
            # Do not expose whether a guessed identifier exists in another project.
            raise KeyError(artifact_id)
        return artifact

    def _validate_source_message(self, project_id: str, source_message_id: str | None) -> None:
        if source_message_id is None:
            return
        message = self._repository.get_message(source_message_id)
        conversation = self._repository.get_conversation(message.conversation_id)
        if conversation.project_id != project_id:
            # Avoid exposing a cross-project message through an artifact link.
            raise KeyError(source_message_id)

    @staticmethod
    def _exclusive_copy(source: Path, target: Path) -> None:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        flags |= int(getattr(os, "O_BINARY", 0))
        flags |= int(getattr(os, "O_NOFOLLOW", 0))
        descriptor = os.open(target, flags, 0o600)
        try:
            with source.open("rb") as incoming, os.fdopen(descriptor, "wb") as outgoing:
                while block := incoming.read(1024 * 1024):
                    outgoing.write(block)
                outgoing.flush()
                os.fsync(outgoing.fileno())
        except BaseException:
            with suppress(FileNotFoundError):
                target.unlink()
            raise

    @staticmethod
    def _artifact(value: DomainArtifact) -> Artifact:
        if value.project_id is None:
            raise ValueError("global artifacts are outside this scoped service")
        return Artifact(
            id=value.id,
            project_id=value.project_id,
            title=value.title,
            kind=ArtifactKind(value.kind.value),
            mime_type=value.media_type,
            head_revision_id=value.current_revision_id or "",
            created_at=value.created_at,
            updated_at=value.updated_at,
        )

    @staticmethod
    def _revision(
        value: DomainArtifactRevision, *, author_kind: str = "unknown"
    ) -> ArtifactRevision:
        return ArtifactRevision(
            id=value.id,
            artifact_id=value.artifact_id,
            parent_revision_id=value.parent_revision_id,
            object_digest=value.object_id,
            byte_size=value.byte_size,
            author_kind=author_kind,
            change_summary=value.summary,
            created_at=value.created_at,
        )


def safe_export_name(title: str, extension: str) -> str:
    stem = re.sub(r"[^\w .-]+", "-", title, flags=re.UNICODE).strip(" .-") or "artifact"
    stem = stem[:120].rstrip(" .-") or "artifact"
    extension = extension.strip().lstrip(".")
    if not re.fullmatch(r"[A-Za-z0-9]{1,12}", extension):
        raise ValueError("invalid export extension")
    return f"{stem}.{extension.casefold()}"
