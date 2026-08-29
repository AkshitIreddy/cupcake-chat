import sqlite3

import pytest

from cupcake_runtime.domain.errors import ConflictError, ProjectBoundaryViolation
from cupcake_runtime.domain.models import (
    ArtifactKind,
    MessageRole,
    ProjectFile,
    SearchDocument,
    SearchEntityType,
    Setting,
)
from cupcake_runtime.storage.repositories import ProductRepository


def test_message_graph_fork_history_and_immutability(repository: ProductRepository) -> None:
    project = repository.create_project("Cupcake", "Text-first agent")
    conversation, main = repository.create_conversation("Architecture", project_id=project.id)
    first = repository.append_message(
        main.id, role=MessageRole.USER, content="Design storage", expected_head_id=None
    )
    second = repository.append_message(
        main.id,
        role=MessageRole.ASSISTANT,
        content="Use an immutable DAG",
        expected_head_id=first.id,
        provider_id="mock",
    )
    branch = repository.fork_branch(conversation.id, first.id, name="Alternative")
    alternative = repository.append_message(
        branch.id,
        role=MessageRole.ASSISTANT,
        content="Use an event log",
        expected_head_id=first.id,
    )

    assert [message.id for message in repository.branch_history(main.id)] == [first.id, second.id]
    assert [message.id for message in repository.branch_history(branch.id)] == [
        first.id,
        alternative.id,
    ]
    with pytest.raises(ConflictError):
        repository.append_message(
            main.id,
            role=MessageRole.USER,
            content="stale writer",
            expected_head_id=first.id,
        )
    with pytest.raises(sqlite3.IntegrityError, match="immutable"):
        repository.database.connection.execute(
            "UPDATE messages SET content='mutated' WHERE id=?", (first.id,)
        )


def test_artifact_revision_compare_and_swap(repository: ProductRepository) -> None:
    artifact = repository.create_artifact("Decision record", ArtifactKind.DOCUMENT, "text/markdown")
    first = repository.add_artifact_revision(
        artifact.id, object_id="a" * 64, byte_size=10, expected_head_id=None, summary="v1"
    )
    second = repository.add_artifact_revision(
        artifact.id, object_id="b" * 64, byte_size=20, expected_head_id=first.id, summary="v2"
    )
    assert repository.get_artifact(artifact.id).current_revision_id == second.id
    assert [revision.id for revision in repository.artifact_history(artifact.id)] == [
        first.id,
        second.id,
    ]
    with pytest.raises(ConflictError):
        repository.add_artifact_revision(
            artifact.id,
            object_id="c" * 64,
            byte_size=30,
            expected_head_id=first.id,
        )


def test_project_boundary_is_mandatory_for_search(repository: ProductRepository) -> None:
    alpha = repository.create_project("Alpha")
    beta = repository.create_project("Beta")
    repository.index_document(
        SearchDocument(
            entity_id="alpha-doc",
            project_id=alpha.id,
            entity_type=SearchEntityType.FILE,
            title="Alpha architecture",
            body="secret frosting design",
        )
    )
    repository.index_document(
        SearchDocument(
            entity_id="beta-doc",
            project_id=beta.id,
            entity_type=SearchEntityType.FILE,
            title="Beta architecture",
            body="secret frosting design",
        )
    )
    with pytest.raises(ProjectBoundaryViolation):
        repository.search("frosting")
    assert [result.entity_id for result in repository.search("frosting", project_id=alpha.id)] == [
        "alpha-doc"
    ]
    assert {result.entity_id for result in repository.search("frosting", global_scope=True)} == {
        "alpha-doc",
        "beta-doc",
    }
    assert repository.search('"))) frosting ((("', project_id=alpha.id)[0].entity_id == "alpha-doc"


def test_project_files_settings_and_dbos_seam(repository: ProductRepository) -> None:
    project = repository.create_project("Workspace")
    file = repository.upsert_project_file(
        ProjectFile(
            project_id=project.id,
            display_name="README.md",
            grant_token="opaque-grant-1",
            relative_path="README.md",
            media_type="text/markdown",
            byte_size=100,
        )
    )
    updated = repository.upsert_project_file(
        file.model_copy(update={"byte_size": 120, "parse_status": "indexed"})
    )
    assert updated.id == file.id
    assert repository.list_project_files(project.id)[0].byte_size == 120

    repository.set_setting(Setting(key="theme.active", value={"id": "cupcake-dark"}))
    assert repository.get_setting("theme.active") == {"id": "cupcake-dark"}
    assert repository.get_setting("missing", default=False) is False

    repository.link_dbos_workflow("task-1", "workflow-1")
    row = repository.database.connection.execute(
        "SELECT dbos_workflow_id FROM runtime_references WHERE task_id='task-1'"
    ).fetchone()
    assert row[0] == "workflow-1"
