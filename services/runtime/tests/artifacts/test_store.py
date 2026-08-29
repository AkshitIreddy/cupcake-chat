from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from cupcake_runtime.artifacts import (
    ArtifactKind,
    ArtifactStore,
    RevisionConflictError,
    safe_export_name,
)
from cupcake_runtime.domain.models import MessageRole
from cupcake_runtime.object_store import EncryptedObjectStore
from cupcake_runtime.storage import Database, DatabaseConfig, ProductRepository


class ArtifactStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.database = Database(
            DatabaseConfig(
                path=self.root / "product.db", require_sqlcipher=False, encryption_key=None
            )
        )
        self.repository = ProductRepository(self.database)
        project = self.repository.create_project("Alpha")
        self.project_id = project.id
        self.store = ArtifactStore(
            self.repository,
            objects=EncryptedObjectStore(self.root / "objects", b"a" * 32),
        )

    def tearDown(self) -> None:
        self.database.close()
        self.temporary.cleanup()

    def test_revisions_are_immutable_and_conflicts_are_explicit(self) -> None:
        created = self.store.create(
            project_id=self.project_id,
            title="Report",
            kind=ArtifactKind.REPORT,
            mime_type="text/markdown",
            content="# Version one",
        )
        edited = self.store.edit(
            created.artifact.id,
            project_id=self.project_id,
            expected_parent_revision_id=created.revision.id,
            content="# Version two",
            author_kind="assistant",
            change_summary="Update",
        )
        self.assertEqual(
            self.store.get(
                created.artifact.id,
                project_id=self.project_id,
                revision_id=created.revision.id,
            ).content,
            b"# Version one",
        )
        self.assertEqual(edited.content, b"# Version two")
        with self.assertRaises(RevisionConflictError):
            self.store.edit(
                created.artifact.id,
                project_id=self.project_id,
                expected_parent_revision_id=created.revision.id,
                content="stale",
                author_kind="assistant",
            )

    def test_project_isolation_and_safe_export(self) -> None:
        created = self.store.create(
            project_id=self.project_id,
            title="Table",
            kind=ArtifactKind.TABLE,
            mime_type="text/csv",
            content="a,b\n1,2\n",
        )
        with self.assertRaises(KeyError):
            self.store.get(created.artifact.id, project_id="beta")
        export_root = self.root / "exports"
        export_root.mkdir()
        target = export_root / safe_export_name("Quarterly / Table", "csv")
        result = self.store.export(
            created.artifact.id,
            project_id=self.project_id,
            destination=target,
            granted_root=export_root,
        )
        self.assertEqual(Path(result.destination).read_bytes(), b"a,b\n1,2\n")

    def test_cross_project_source_message_is_rejected(self) -> None:
        beta = self.repository.create_project("Beta")
        _, branch = self.repository.create_conversation("Beta chat", project_id=beta.id)
        message = self.repository.append_message(
            branch.id,
            role=MessageRole.USER,
            content="private beta context",
            expected_head_id=None,
        )
        with self.assertRaises(KeyError):
            self.store.create(
                project_id=self.project_id,
                title="Leaky report",
                kind=ArtifactKind.REPORT,
                mime_type="text/plain",
                content="must not link",
                source_message_id=message.id,
            )


if __name__ == "__main__":
    unittest.main()
