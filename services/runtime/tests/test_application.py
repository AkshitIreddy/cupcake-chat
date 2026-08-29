from __future__ import annotations

import asyncio
import hashlib
import threading
from importlib.util import find_spec
from pathlib import Path
from typing import Any

import pytest

from cupcake_runtime.application import RuntimeCommandError, RuntimeService
from cupcake_runtime.providers.types import NormalizedStreamEvent, StreamEventType


def service(tmp_path: Path) -> RuntimeService:
    return RuntimeService(tmp_path, master_key=b"k" * 32, require_sqlcipher=False)


def test_composed_runtime_bootstrap_and_persistence(tmp_path: Path) -> None:
    runtime = service(tmp_path)
    project, _ = runtime.handle(
        "projects.create", {"name": "Cupcake 2.0", "description": "Text-first workbench"}
    )
    conversation, _ = runtime.handle(
        "conversations.create",
        {"title": "Architecture", "projectId": project["id"]},
    )
    response, events = runtime.handle(
        "chat.send",
        {
            "conversationId": conversation["conversation"]["id"],
            "branchId": conversation["branch"]["id"],
            "content": "Explain the runtime boundary.",
            "modelId": "mock:cupcake-deterministic",
        },
    )
    assert response["content"] == "Cupcake received: Explain the runtime boundary."
    assert next(event["type"] for event in events) == "message.started"
    assert [event["type"] for event in events][-1] == "message.completed"
    runtime.close()

    reopened = service(tmp_path)
    conversations, _ = reopened.handle("conversations.list", {"projectId": project["id"]})
    assert [item["title"] for item in conversations] == ["Architecture"]
    history, _ = reopened.handle("chat.history", {"branchId": conversation["branch"]["id"]})
    assert [item["role"] for item in history] == ["user", "assistant"]
    assert reopened.handle("runtime.health")[0]["healthy"] is True
    reopened.close()


def test_memory_and_background_task_commands_share_profile(tmp_path: Path) -> None:
    runtime = service(tmp_path)
    memory, _ = runtime.handle(
        "memory.remember",
        {
            "key": "readme-style",
            "content": "Prefer concise README files",
            "kind": "preference",
            "scope": "global",
        },
    )
    assert memory["state"] == "active"
    found, _ = runtime.handle("memory.list", {"query": "README"})
    assert [item["id"] for item in found] == [memory["id"]]

    task, _ = runtime.handle(
        "tasks.create",
        {
            "prompt": "Analyze the repository and write a report",
            "workKind": "repository_index",
            "estimatedSeconds": 45,
            "toolStages": 3,
        },
    )
    assert task["promotion"]["promoted"] is True
    listed, _ = runtime.handle("tasks.list")
    assert listed[0]["run_id"] == task["run"]["run_id"]
    runtime.close()


def test_project_conversation_branch_artifact_and_settings_surface(tmp_path: Path) -> None:
    runtime = service(tmp_path)
    project, _ = runtime.handle("projects.create", {"name": "Workspace"})
    updated, _ = runtime.handle(
        "projects.update", {"projectId": project["id"], "description": "Private scope"}
    )
    assert updated["description"] == "Private scope"
    created, _ = runtime.handle(
        "conversations.create", {"title": "Draft", "projectId": project["id"]}
    )
    sent, _ = runtime.handle(
        "chat.send",
        {
            "conversationId": created["conversation"]["id"],
            "branchId": created["branch"]["id"],
            "content": "Original prompt",
            "modelId": "mock:cupcake-deterministic",
        },
    )
    edited, edit_events = runtime.handle(
        "chat.edit",
        {
            "messageId": sent["message"]["parent_message_id"],
            "content": "Edited prompt",
            "modelId": "mock:cupcake-deterministic",
        },
    )
    assert edited["branchId"] != created["branch"]["id"]
    assert edit_events[0]["type"] == "conversation.branched"
    regenerated, _ = runtime.handle(
        "chat.regenerate",
        {"messageId": edited["message"]["id"], "modelId": "mock:cupcake-deterministic"},
    )
    assert regenerated["branchId"] != edited["branchId"]

    artifact, _ = runtime.handle(
        "artifacts.create",
        {
            "projectId": project["id"],
            "title": "Plan",
            "kind": "document",
            "mimeType": "text/markdown",
            "content": "# One",
        },
    )
    revised, _ = runtime.handle(
        "artifacts.revise",
        {
            "projectId": project["id"],
            "artifactId": artifact["artifact"]["id"],
            "expectedRevisionId": artifact["revision"]["id"],
            "content": "# Two",
        },
    )
    assert revised["content"] == "# Two"
    intent, _ = runtime.handle(
        "artifacts.export.intent",
        {
            "projectId": project["id"],
            "artifactId": artifact["artifact"]["id"],
            "destinationHandle": "grant-export-1",
            "extension": "md",
        },
    )
    assert intent["payload"]["destinationHandle"] == "grant-export-1"
    setting, _ = runtime.handle("settings.set", {"key": "appearance.theme", "value": "classic"})
    assert setting == {"key": "appearance.theme", "value": "classic"}
    runtime.close()


def test_memory_secret_policy_confirmation_and_chat_commands(tmp_path: Path) -> None:
    runtime = service(tmp_path)
    with pytest.raises(RuntimeCommandError, match="secret-like"):
        runtime.handle(
            "memory.remember",
            {"key": "api", "content": "api_key=sk-secret-value-1234567890"},
        )
    with pytest.raises(RuntimeCommandError, match="secret-like"):
        runtime.handle(
            "memory.remember",
            {"key": "nim", "content": "nvapi-synthetic-memory-canary-1234567890"},
        )
    preflight, _ = runtime.handle(
        "memory.confirmation.preflight",
        {
            "key": "medical-note",
            "content": "Prefers a private appointment",
            "kind": "fact",
            "scope": "global",
        },
    )
    remembered, events = runtime.handle(
        "memory.remember",
        {
            "key": "medical-note",
            "content": "Prefers a private appointment",
            "kind": "fact",
            "scope": "global",
            "sensitive": True,
            "confirmationToken": preflight["confirmationToken"],
        },
    )
    assert remembered["state"] == "active"
    assert events[0]["payload"]["undo"]["method"] == "memory.forget"
    command, command_events = runtime.handle(
        "chat.send",
        {"content": "remember Use short headings", "modelId": "mock:cupcake-deterministic"},
    )
    assert command["kind"] == "memory.command"
    assert any(event["type"] == "memory.saved" for event in command_events)
    runtime.close()


def test_offline_and_cloud_disclosure_tokens_are_enforced(tmp_path: Path) -> None:
    runtime = service(tmp_path)
    with pytest.raises(RuntimeCommandError) as offline:
        runtime.handle(
            "chat.send",
            {"content": "No network", "modelId": "openai:gpt-5.6-sol", "offline": True},
        )
    assert offline.value.code == "OFFLINE_ROUTE_DENIED"
    preflight, _ = runtime.handle(
        "chat.disclosure.preflight",
        {"content": "Hello", "modelId": "openai:gpt-5.6-sol", "files": ["file-1"]},
    )
    assert preflight["confirmationRequired"] is True
    runtime._enforce_model_policy(
        "openai:gpt-5.6-sol",
        {
            "modelId": "openai:gpt-5.6-sol",
            "files": ["file-1"],
            "outboundIntent": preflight["outboundIntent"],
            "disclosureConfirmationToken": preflight["token"],
        },
        content="Hello",
    )
    with pytest.raises(RuntimeCommandError) as replayed:
        runtime._enforce_model_policy(
            "openai:gpt-5.6-sol",
            {
                "modelId": "openai:gpt-5.6-sol",
                "files": ["file-1"],
                "outboundIntent": preflight["outboundIntent"],
                "disclosureConfirmationToken": preflight["token"],
            },
            content="Hello",
        )
    assert replayed.value.code == "OUTBOUND_CONFIRMATION_REQUIRED"
    tamper_preflight, _ = runtime.handle(
        "chat.disclosure.preflight",
        {"content": "Hello", "modelId": "openai:gpt-5.6-sol", "files": ["file-1"]},
    )
    with pytest.raises(RuntimeCommandError) as tampered:
        runtime.handle(
            "chat.send",
            {
                "content": "Changed",
                "modelId": "openai:gpt-5.6-sol",
                "files": ["file-1"],
                "disclosureConfirmationToken": tamper_preflight["token"],
            },
        )
    assert tampered.value.code == "OUTBOUND_CONFIRMATION_REQUIRED"
    runtime.close()


def test_broker_staged_ingestion_verifies_and_deletes_source(tmp_path: Path) -> None:
    runtime = service(tmp_path)
    project, _ = runtime.handle("projects.create", {"name": "Files"})
    staging = tmp_path / "broker-ingestion"
    staging.mkdir()
    source = staging / "source-1.md"
    source.write_text("Cupcake indexing evidence", encoding="utf-8")
    data = source.read_bytes()
    result, _ = runtime.handle(
        "ingestion.ingest.private",
        {
            "projectId": project["id"],
            "sourceHandle": "grant-file-1",
            "displayName": "notes.md",
            "stagedPath": str(source),
            "sha256": hashlib.sha256(data).hexdigest(),
            "byteSize": len(data),
            "mediaType": "text/markdown",
        },
    )
    assert result["chunkCount"] == 1
    assert not source.exists()
    found, _ = runtime.handle("search.project", {"projectId": project["id"], "query": "evidence"})
    assert found[0]["document"]["source_id"] == result["sourceId"]
    runtime.close()


def test_private_backup_includes_runtime_database_and_stages_restore(tmp_path: Path) -> None:
    runtime = service(tmp_path / "profile")
    runtime.handle("tasks.create", {"prompt": "Durable backup evidence"})
    destination = tmp_path / "backup.zip"
    created, _ = runtime.handle(
        "backup.create.private", {"destinationPath": str(destination.resolve())}
    )
    paths = {entry["path"] for entry in created["manifest"]["entries"]}
    assert "database/product.sqlite" in paths
    assert "database/runtime.sqlite" in paths
    prepared, _ = runtime.handle(
        "backup.restore.prepare.private", {"sourcePath": str(destination.resolve())}
    )
    assert prepared["requiresRestart"] is True
    assert "database/runtime.sqlite" in {
        entry["path"] for entry in prepared["manifest"]["entries"]
    }
    runtime.close()


def test_packaged_self_test_constructs_provider_models_without_network(tmp_path: Path) -> None:
    runtime = service(tmp_path)
    result, _ = runtime.handle("runtime.self_test")
    providers = result["components"]["providers"]
    assert {
        "openai",
        "anthropic",
        "google",
        "xai",
        "mistral",
        "cohere",
        "openai-compatible",
    } <= providers.keys()
    assert all(providers[name]["ok"] for name in providers)
    runtime.close()


class _SlowAgentEngine:
    async def stream(self, request: Any, **_kwargs: Any):
        run_id = str(request.metadata["run_id"])
        yield NormalizedStreamEvent(StreamEventType.START, 1, run_id)
        yield NormalizedStreamEvent(StreamEventType.TEXT_DELTA, 2, run_id, text="first")
        await asyncio.sleep(60)


def test_chat_stream_is_incremental_and_cancellable(tmp_path: Path) -> None:
    runtime = service(tmp_path)
    runtime.agent_engine = _SlowAgentEngine()  # type: ignore[assignment]

    async def scenario() -> None:
        events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

        async def emit(event: dict[str, Any]) -> None:
            await events.put(event)

        request = asyncio.create_task(
            runtime.handle_stream(
                "chat.send",
                {"content": "Stream slowly", "modelId": "mock:cupcake-deterministic"},
                emit,
                cancellation=threading.Event(),
            )
        )
        seen = [await asyncio.wait_for(events.get(), 2) for _ in range(3)]
        delta = next(event for event in seen if event["type"] == "message.delta")
        assert delta["payload"]["delta"] == "first"
        assert not request.done()
        run_id = str(delta["payload"]["runId"])
        assert runtime.cancel_active(run_id) is True
        with pytest.raises(RuntimeCommandError) as cancelled:
            await asyncio.wait_for(request, 2)
        assert cancelled.value.code == "CANCELLED"
        cancellation_event = await asyncio.wait_for(events.get(), 2)
        assert cancellation_event["type"] == "message.cancelled"

    asyncio.run(scenario())
    runtime.close()


@pytest.mark.skipif(find_spec("sqlcipher3") is None, reason="SQLCipher release extra unavailable")
def test_release_profile_uses_real_sqlcipher(tmp_path: Path) -> None:
    runtime = RuntimeService(tmp_path, master_key=b"r" * 32, require_sqlcipher=True)
    health, _ = runtime.handle("runtime.health")
    assert health["healthy"] is True
    assert health["profileEncrypted"] is True
    runtime.handle("projects.create", {"name": "Encrypted"})
    runtime.close()

    reopened = RuntimeService(tmp_path, master_key=b"r" * 32, require_sqlcipher=True)
    projects, _ = reopened.handle("projects.list")
    assert [project["name"] for project in projects] == ["Encrypted"]
    reopened.close()
