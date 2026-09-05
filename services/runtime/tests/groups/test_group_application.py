from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import threading
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from cupcake_runtime.application import RuntimeCommandError, RuntimeService
from cupcake_runtime.domain.models import MessageRole
from cupcake_runtime.groups import GroupTurnStatus
from cupcake_runtime.providers.base import ProviderConfig
from cupcake_runtime.providers.types import (
    ModelCapabilities,
    ModelDescriptor,
    NormalizedStreamEvent,
    PrivacyRoute,
    ReasoningEffort,
    StreamEventType,
    TokenUsage,
)


def service(tmp_path: Path) -> RuntimeService:
    return RuntimeService(tmp_path, master_key=b"g" * 32, require_sqlcipher=False)


class ScriptedGroupEngine:
    def __init__(self, selector: Callable[[dict[str, Any], int], str]) -> None:
        self.selector = selector
        self.selector_requests: list[Any] = []
        self.member_requests: list[Any] = []
        self.member_personality_instructions: list[tuple[str, ...]] = []

    async def stream(self, request: Any, **_kwargs: Any):
        run_id = str(request.metadata["run_id"])
        yield NormalizedStreamEvent(StreamEventType.START, 1, run_id)
        if request.metadata.get("group_selector"):
            payload = json.loads(request.messages[-1].content)
            self.selector_requests.append(request)
            text = self.selector(payload, len(self.selector_requests))
        else:
            self.member_requests.append(request)
            self.member_personality_instructions.append(
                tuple(_kwargs.get("personality_instructions", ()))
            )
            text = f"member-{len(self.member_requests)} answered"
        yield NormalizedStreamEvent(StreamEventType.TEXT_DELTA, 2, run_id, text=text)
        yield NormalizedStreamEvent(
            StreamEventType.USAGE,
            3,
            run_id,
            usage=TokenUsage(input_tokens=9, output_tokens=3),
        )
        yield NormalizedStreamEvent(StreamEventType.FINISH, 4, run_id, finish_reason="stop")


class PartialFailureEngine(ScriptedGroupEngine):
    async def stream(self, request: Any, **kwargs: Any):
        if request.metadata.get("group_selector"):
            async for item in super().stream(request, **kwargs):
                yield item
            return
        self.member_requests.append(request)
        run_id = str(request.metadata["run_id"])
        yield NormalizedStreamEvent(StreamEventType.START, 1, run_id)
        yield NormalizedStreamEvent(StreamEventType.TEXT_DELTA, 2, run_id, text="partial answer")
        yield NormalizedStreamEvent(
            StreamEventType.ERROR,
            3,
            run_id,
            text="Provider unavailable",
            error_code="provider_unavailable",
            retryable=False,
        )


class SlowMemberEngine(ScriptedGroupEngine):
    def __init__(self, selector: Callable[[dict[str, Any], int], str]) -> None:
        super().__init__(selector)
        self.member_started = asyncio.Event()

    async def stream(self, request: Any, **kwargs: Any):
        if request.metadata.get("group_selector"):
            async for item in super().stream(request, **kwargs):
                yield item
            return
        self.member_requests.append(request)
        run_id = str(request.metadata["run_id"])
        yield NormalizedStreamEvent(StreamEventType.START, 1, run_id)
        yield NormalizedStreamEvent(StreamEventType.TEXT_DELTA, 2, run_id, text="partial")
        self.member_started.set()
        await asyncio.Event().wait()


class ExplodingSelectorEngine:
    async def stream(self, _request: Any, **_kwargs: Any):
        if False:
            yield None
        raise RuntimeError("adapter transport crashed")


def configured_group(
    runtime: RuntimeService, *, max_replies: int = 2, project_id: str | None = None
) -> dict[str, Any]:
    conversation_params = {"title": "Council"}
    if project_id is not None:
        conversation_params["projectId"] = project_id
    created, _ = runtime.handle("conversations.create", conversation_params)
    conversation_id = str(created["conversation"]["id"])
    branch_id = str(created["branch"]["id"])
    personas: list[dict[str, Any]] = []
    participants: list[dict[str, Any]] = []
    for name, handle, role in (
        ("Mira", "mira", "Research lead"),
        ("Sol", "sol", "Critical reviewer"),
    ):
        persona, _ = runtime.handle(
            "personas.create",
            {
                "name": name,
                "handle": handle,
                "role": role,
                "description": role,
                "instructions": f"private-{handle}-instruction",
                "modelId": "mock:cupcake-deterministic",
                "avatar": "atlas:7",
            },
        )
        participant, _ = runtime.handle(
            "conversations.participants.add",
            {"conversationId": conversation_id, "personaId": persona["id"]},
        )
        personas.append(persona)
        participants.append(participant)
    runtime.handle(
        "conversations.group.settings.set",
        {
            "conversationId": conversation_id,
            "strategy": "smart-selective",
            "maxReplies": max_replies,
            "leadParticipantId": participants[0]["id"],
        },
    )
    return {
        "conversationId": conversation_id,
        "branchId": branch_id,
        "personas": personas,
        "participants": participants,
    }


async def send(
    runtime: RuntimeService,
    params: Mapping[str, Any],
    *,
    on_event: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    events: list[dict[str, Any]] = []

    async def emit(event: dict[str, Any]) -> None:
        events.append(event)
        if on_event is not None:
            await on_event(event)

    result = await runtime.handle_stream(
        "groups.turn.send", params, emit, cancellation=threading.Event()
    )
    return result, events


def send_params(base: Mapping[str, Any], preflight: Mapping[str, Any]) -> dict[str, Any]:
    return {
        **base,
        "turnId": preflight["turnId"],
        "planRevision": preflight["planRevision"],
        "digest": preflight["digest"],
        "confirmationToken": preflight["confirmationToken"],
    }


def test_mentions_bypass_selector_and_persist_attributed_sequential_messages(
    tmp_path: Path,
) -> None:
    runtime = service(tmp_path)
    group = configured_group(runtime)
    engine = ScriptedGroupEngine(lambda _payload, _index: "unused")
    runtime.agent_engine = engine  # type: ignore[assignment]
    first, second = group["participants"]
    content = "@mira please research, then @sol review."
    base: dict[str, Any] = {
        "conversationId": group["conversationId"],
        "branchId": group["branchId"],
        "content": content,
        "mentions": [
            {
                "participantId": first["id"],
                "personaId": first["personaId"],
                "start": 0,
                "end": 5,
                "token": "@mira",
            },
            {
                "participantId": second["id"],
                "personaId": second["personaId"],
                "start": 28,
                "end": 32,
                "token": "@sol",
            },
        ],
    }
    preflight, _ = runtime.handle("groups.turn.preflight", base)
    result, events = asyncio.run(send(runtime, send_params(base, preflight)))

    assert preflight["mode"] == "mentions"
    assert preflight["maxSelectorCalls"] == 0
    assert engine.selector_requests == []
    assert len(engine.member_requests) == 2
    assert result["status"] == "completed"
    history, _ = runtime.handle("chat.history", {"branchId": group["branchId"]})
    assert [item["role"] for item in history] == ["user", "assistant", "assistant"]
    assert [item["canonical_metadata"]["group"]["speaker"]["handle"] for item in history[1:]] == [
        "mira",
        "sol",
    ]
    second_history = engine.member_requests[1].messages
    assert any(
        message.role == "assistant" and "transcript evidence" in message.content
        for message in second_history
    )
    first_coordination = engine.member_requests[0].messages[-1].content
    assert "selected Mira (@mira) for exactly one contribution" in first_coordination
    assert "runtime will invoke other requested participants separately" in first_coordination
    first_identity = engine.member_personality_instructions[0][-1]
    second_identity = engine.member_personality_instructions[1][-1]
    assert 'name="Mira", handle="mira", and role="Research lead"' in first_identity
    assert 'name="Sol", handle="sol", and role="Critical reviewer"' in second_identity
    assert "Never invent, simulate, introduce, label, quote, or complete" in first_identity
    assert "even when the user asks multiple roles to contribute" in first_identity
    assert "End after this participant's contribution" in first_identity
    assert all(event["payload"].get("runId") == preflight["turnId"] for event in events)
    runtime.close()


def test_smart_roster_can_exceed_reply_cap_but_direct_mentions_cannot(tmp_path: Path) -> None:
    runtime = service(tmp_path)
    group = configured_group(runtime, max_replies=2)
    persona, _ = runtime.handle(
        "personas.create",
        {
            "name": "Nova",
            "handle": "nova",
            "role": "Implementation specialist",
            "modelId": "mock:cupcake-deterministic",
            "avatar": "atlas:7",
        },
    )
    third, _ = runtime.handle(
        "conversations.participants.add",
        {"conversationId": group["conversationId"], "personaId": persona["id"]},
    )
    smart: dict[str, Any] = {
        "conversationId": group["conversationId"],
        "branchId": group["branchId"],
        "content": "Who can help?",
        "mentions": [],
    }
    preflight, _ = runtime.handle("groups.turn.preflight", smart)
    assert preflight["sendable"] is True
    assert len(preflight["eligibleSpeakers"]) == 3
    assert preflight["maxReplies"] == 2

    content = "@mira @sol @nova"
    participants = [*group["participants"], third]
    spans = ((0, 5, "@mira"), (6, 10, "@sol"), (11, 16, "@nova"))
    mentions = [
        {
            "participantId": participant["id"],
            "personaId": participant["personaId"],
            "start": start,
            "end": end,
            "token": token,
        }
        for participant, (start, end, token) in zip(participants, spans, strict=True)
    ]
    with pytest.raises(RuntimeCommandError, match="Mention no more Cupcakes"):
        runtime.handle(
            "groups.turn.preflight",
            {
                "conversationId": group["conversationId"],
                "branchId": group["branchId"],
                "content": content,
                "mentions": mentions,
            },
        )
    runtime.handle(
        "conversations.group.settings.set",
        {
            "conversationId": group["conversationId"],
            "strategy": "smart-selective",
            "maxReplies": 3,
            "leadParticipantId": participants[0]["id"],
        },
    )
    direct, _ = runtime.handle(
        "groups.turn.preflight",
        {
            "conversationId": group["conversationId"],
            "branchId": group["branchId"],
            "content": content,
            "mentions": mentions,
        },
    )
    assert direct["sendable"] is True
    assert direct["maxReplies"] == 3
    assert len(direct["eligibleSpeakers"]) == 3
    runtime.close()


def test_group_preflight_reads_binary_attachment_once_across_model_routes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime = service(tmp_path)
    project, _ = runtime.handle("projects.create", {"name": "Shared image context"})
    group = configured_group(runtime, project_id=project["id"])
    descriptors = [
        ModelDescriptor(
            id=f"mock:vision-{suffix}",
            provider="mock",
            model=f"vision-{suffix}",
            display_name=f"Vision {suffix}",
            family="mock-vision",
            context_window=8_192,
            max_output_tokens=1_024,
            capabilities=ModelCapabilities(streaming=True, tools=False, images=True),
            privacy_route=PrivacyRoute.LOCAL,
        )
        for suffix in ("one", "two")
    ]
    for descriptor, persona in zip(descriptors, group["personas"], strict=True):
        runtime.providers.catalog.register(descriptor)
        runtime.handle("personas.update", {"personaId": persona["id"], "modelId": descriptor.id})
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )
    staging = tmp_path / "broker-ingestion"
    staging.mkdir()
    source = staging / "shared.png"
    source.write_bytes(png)
    ingested, _ = runtime.handle(
        "ingestion.ingest.private",
        {
            "projectId": project["id"],
            "sourceHandle": "grant-shared-image",
            "displayName": "shared.png",
            "stagedPath": str(source),
            "sha256": hashlib.sha256(png).hexdigest(),
            "byteSize": len(png),
            "mediaType": "application/octet-stream",
            "structuredDocument": {
                "version": 1,
                "entries": [],
                "warnings": [],
                "metadata": {"network_access": False},
            },
        },
    )
    original_get = runtime.objects.get
    reads = 0

    def counted_get(digest: str) -> bytes:
        nonlocal reads
        reads += 1
        return original_get(digest)

    monkeypatch.setattr(runtime.objects, "get", counted_get)
    base: dict[str, Any] = {
        "conversationId": group["conversationId"],
        "branchId": group["branchId"],
        "projectId": project["id"],
        "content": "Compare this image.",
        "mentions": [],
        "attachments": [{"fileId": ingested["file"]["id"], "sourceId": ingested["sourceId"]}],
        "attachmentHandles": ["grant-shared-image"],
        "attachmentBindings": [
            {
                "handleId": "grant-shared-image",
                "byteSize": len(png),
                "sha256": hashlib.sha256(png).hexdigest(),
            }
        ],
    }
    preflight, _ = runtime.handle("groups.turn.preflight", base)
    assert reads == 1
    runtime_any: Any = runtime
    authorizations = runtime_any._group_preflights
    contexts = list(authorizations[preflight["turnId"]].contexts.values())
    binary_values = [context.model_attachments[0]["data"] for context in contexts]
    assert len(binary_values) == 2
    assert binary_values[0] is binary_values[1]

    replacement, _ = runtime.handle(
        "groups.turn.preflight", {**base, "content": "Compare it again."}
    )
    assert reads == 2
    assert list(authorizations) == [replacement["turnId"]]
    with pytest.raises(RuntimeCommandError, match="too large"):
        runtime_any._resolve_explicit_chat_context(
            group["conversationId"],
            {**base, "modelId": descriptors[0].id},
            binary_cache={},
            binary_cache_limit=1,
        )
    assert reads == 2
    runtime.close()


def test_smart_pass_is_durable_and_selector_never_receives_private_instructions(
    tmp_path: Path,
) -> None:
    runtime = service(tmp_path)
    group = configured_group(runtime)
    engine = ScriptedGroupEngine(
        lambda _payload, _index: json.dumps(
            {
                "decision": "pass",
                "participantId": None,
                "reasonCode": "acknowledgement",
                "reason": "No reply would add value.",
            }
        )
    )
    runtime.agent_engine = engine  # type: ignore[assignment]
    base: dict[str, Any] = {
        "conversationId": group["conversationId"],
        "branchId": group["branchId"],
        "content": "Thanks, everyone.",
        "mentions": [],
    }
    preflight, _ = runtime.handle("groups.turn.preflight", base)
    result, _ = asyncio.run(send(runtime, send_params(base, preflight)))

    assert result["status"] == "waiting_for_you"
    assert result["selectorCalls"] == 1
    assert result["responderCalls"] == 0
    assert result["selectorUsage"][0]["status"] == "completed"
    assert engine.selector_requests[0].max_output_tokens == 256
    selector_body = engine.selector_requests[0].messages[-1].content
    assert "private-mira-instruction" not in selector_body
    assert "private-sol-instruction" not in selector_body
    runtime.close()


def test_reasoning_selector_discloses_and_uses_a_reasoning_aware_budget(
    tmp_path: Path,
) -> None:
    runtime = service(tmp_path)
    group = configured_group(runtime)
    descriptor = runtime.providers.register_openai_compatible_endpoint(
        "groq",
        model="openai/gpt-oss-20b",
        display_name="Groq GPT OSS 20B",
        base_url="https://api.groq.com/openai/v1",
        api_key="credential-lease",
        context_window=131_072,
        max_output_tokens=65_536,
        reasoning_efforts=(
            ReasoningEffort.LOW,
            ReasoningEffort.MEDIUM,
            ReasoningEffort.HIGH,
        ),
        capabilities=ModelCapabilities(streaming=True, reasoning=True),
        metadata={"provider_preset": "groq"},
    )
    runtime.providers.catalog.register(
        replace(
            descriptor,
            privacy_route=PrivacyRoute.CLOUD,
            default_reasoning_effort=ReasoningEffort.LOW,
        ),
        replace=True,
    )
    for persona in group["personas"]:
        runtime.handle("personas.update", {"personaId": persona["id"], "modelId": descriptor.id})
    engine = ScriptedGroupEngine(
        lambda _payload, _index: json.dumps(
            {
                "decision": "pass",
                "participantId": None,
                "reasonCode": "acknowledgement",
                "reason": "No reply would add value.",
            }
        )
    )
    runtime.agent_engine = engine  # type: ignore[assignment]
    base: dict[str, Any] = {
        "conversationId": group["conversationId"],
        "branchId": group["branchId"],
        "content": "Thanks, everyone.",
        "mentions": [],
    }

    preflight, _ = runtime.handle("groups.turn.preflight", base)
    result, _ = asyncio.run(send(runtime, send_params(base, preflight)))

    assert preflight["selectorMaxOutputTokens"] == 1_024
    assert preflight["disclosure"]["selectorMaxOutputTokens"] == 1_024
    assert result["status"] == "waiting_for_you"
    assert result["selectorCalls"] == 1
    assert len(engine.selector_requests) == 1
    assert engine.selector_requests[0].max_output_tokens == 1_024
    assert engine.selector_requests[0].reasoning_effort is ReasoningEffort.LOW
    runtime.close()


def test_smart_reselects_after_reply_then_passes_without_repeat(tmp_path: Path) -> None:
    runtime = service(tmp_path)
    group = configured_group(runtime)

    def choose(payload: dict[str, Any], index: int) -> str:
        if index == 1:
            participant_id = payload["allowedRemainingCandidates"][0]["participantId"]
            return json.dumps(
                {
                    "decision": "speak",
                    "participantId": participant_id,
                    "reasonCode": "best_fit",
                    "reason": "Best fit for the request.",
                }
            )
        return json.dumps(
            {
                "decision": "pass",
                "participantId": None,
                "reasonCode": "no_distinct_value",
                "reason": "The first answer covered it.",
            }
        )

    engine = ScriptedGroupEngine(choose)
    runtime.agent_engine = engine  # type: ignore[assignment]
    base: dict[str, Any] = {
        "conversationId": group["conversationId"],
        "branchId": group["branchId"],
        "content": "Compare the architecture choices.",
        "mentions": [],
    }
    preflight, _ = runtime.handle("groups.turn.preflight", base)
    result, _ = asyncio.run(send(runtime, send_params(base, preflight)))
    assert result["status"] == "completed"
    assert result["selectorCalls"] == 2
    assert result["responderCalls"] == 1
    assert len(engine.member_requests) == 1
    assert len(engine.selector_requests) == 2
    assert engine.selector_requests[0].metadata["group_call"] is True
    assert engine.member_requests[0].metadata["group_call"] is True
    assert len(engine.selector_requests[1].messages) == 1
    runtime.close()


def test_invalid_selector_and_stale_roster_fail_without_guessed_speaker(tmp_path: Path) -> None:
    runtime = service(tmp_path)
    group = configured_group(runtime)
    engine = ScriptedGroupEngine(lambda _payload, _index: "not-json")
    runtime.agent_engine = engine  # type: ignore[assignment]
    base: dict[str, Any] = {
        "conversationId": group["conversationId"],
        "branchId": group["branchId"],
        "content": "Who should answer?",
        "mentions": [],
    }
    preflight, _ = runtime.handle("groups.turn.preflight", base)
    result, _ = asyncio.run(send(runtime, send_params(base, preflight)))
    assert result["status"] == "selection_failed"
    assert result["selectorCalls"] == 1
    assert result["selectorUsage"][0]["status"] == "failed"
    assert engine.member_requests == []

    next_preflight, _ = runtime.handle("groups.turn.preflight", base)
    runtime.handle(
        "conversations.participants.update",
        {
            "conversationId": group["conversationId"],
            "participantId": group["participants"][1]["id"],
            "enabled": False,
        },
    )
    with pytest.raises(RuntimeCommandError, match="roster changed"):
        asyncio.run(send(runtime, send_params(base, next_preflight)))
    assert len(engine.selector_requests) == 1
    runtime.close()


def test_unexpected_selector_exception_is_accounted_and_terminal(tmp_path: Path) -> None:
    runtime = service(tmp_path)
    group = configured_group(runtime)
    runtime.agent_engine = ExplodingSelectorEngine()  # type: ignore[assignment]
    base: dict[str, Any] = {
        "conversationId": group["conversationId"],
        "branchId": group["branchId"],
        "content": "Who should answer?",
        "mentions": [],
    }
    preflight, _ = runtime.handle("groups.turn.preflight", base)
    result, _ = asyncio.run(send(runtime, send_params(base, preflight)))
    assert result["status"] == "selection_failed"
    assert result["selectorCalls"] == 1
    assert result["selectorUsage"] == [
        {
            "status": "failed",
            "selection": None,
            "usage": {"events": []},
            "errorCode": "GROUP_SELECTOR_PROVIDER_ERROR",
        }
    ]
    assert result["members"] == []
    runtime.close()


def test_cancel_between_member_and_next_selector_stops_whole_turn(tmp_path: Path) -> None:
    runtime = service(tmp_path)
    group = configured_group(runtime)

    def choose(payload: dict[str, Any], _index: int) -> str:
        participant_id = payload["allowedRemainingCandidates"][0]["participantId"]
        return json.dumps(
            {
                "decision": "speak",
                "participantId": participant_id,
                "reasonCode": "best_fit",
                "reason": "Useful contribution.",
            }
        )

    engine = ScriptedGroupEngine(choose)
    runtime.agent_engine = engine  # type: ignore[assignment]
    base: dict[str, Any] = {
        "conversationId": group["conversationId"],
        "branchId": group["branchId"],
        "content": "Give me two perspectives.",
        "mentions": [],
    }
    preflight, _ = runtime.handle("groups.turn.preflight", base)

    async def cancel_after_first(event: dict[str, Any]) -> None:
        if event["type"] == "group.speaker.completed":
            assert runtime.cancel_active(preflight["turnId"]) is True

    result, _ = asyncio.run(
        send(runtime, send_params(base, preflight), on_event=cancel_after_first)
    )
    assert result["status"] == "cancelled"
    assert len(engine.selector_requests) == 1
    assert len(engine.member_requests) == 1
    assert result["members"][0]["status"] == "completed"
    runtime.close()


def test_restart_marks_running_turn_interrupted_and_latest_lookup_finds_it(
    tmp_path: Path,
) -> None:
    runtime = service(tmp_path)
    created, _ = runtime.handle("conversations.create", {"title": "Recovery"})
    conversation_id = created["conversation"]["id"]
    branch_id = created["branch"]["id"]
    user = runtime.repository.append_message(
        branch_id,
        role=MessageRole.USER,
        content="Interrupted",
        expected_head_id=None,
    )
    runtime.groups.create_turn(
        turn_id=user.id,
        conversation_id=conversation_id,
        branch_id=branch_id,
        user_message_id=user.id,
        mode="mentions",
        digest="a" * 64,
        plan_revision="b" * 64,
        responder_limit=1,
        plan={"rosterRevision": 1},
    )
    runtime.close()

    reopened = service(tmp_path)
    latest, _ = reopened.handle("groups.turn.get", {"conversationId": conversation_id})
    assert latest["turnId"] == user.id
    assert latest["status"] == GroupTurnStatus.INTERRUPTED.value
    reopened.close()


def test_mentions_enforce_utf16_ranges_and_token_boundaries(tmp_path: Path) -> None:
    runtime = service(tmp_path)
    group = configured_group(runtime, max_replies=1)
    participant = group["participants"][0]
    common = {
        "conversationId": group["conversationId"],
        "branchId": group["branchId"],
    }
    for content, start, end in (("email@mira.com", 5, 10), ("@mirax", 0, 5)):
        with pytest.raises(RuntimeCommandError, match="separate composer token"):
            runtime.handle(
                "groups.turn.preflight",
                {
                    **common,
                    "content": content,
                    "mentions": [
                        {
                            "participantId": participant["id"],
                            "personaId": participant["personaId"],
                            "start": start,
                            "end": end,
                            "token": "@mira",
                        }
                    ],
                },
            )
    content = "🧁 @mira help"
    valid, _ = runtime.handle(
        "groups.turn.preflight",
        {
            **common,
            "content": content,
            "mentions": [
                {
                    "participantId": participant["id"],
                    "personaId": participant["personaId"],
                    "start": 3,
                    "end": 8,
                    "token": "@mira",
                }
            ],
        },
    )
    assert valid["sendable"] is True
    runtime.close()


def test_cloud_group_confirmation_and_live_offline_change_fail_before_model_io(
    tmp_path: Path,
) -> None:
    runtime = service(tmp_path)
    group = configured_group(runtime)
    descriptor = runtime.providers.register_openai_compatible_endpoint(
        "cloud-test",
        model="cloud-model",
        display_name="Cloud Test",
        base_url="https://cloud.example.test/v1",
        api_key="credential-lease",
    )
    runtime.providers.catalog.register(
        replace(descriptor, privacy_route=PrivacyRoute.CLOUD), replace=True
    )
    runtime.providers.configure_model(
        descriptor.id,
        ProviderConfig(api_key="credential-lease", base_url="https://cloud.example.test/v1"),
    )
    for persona in group["personas"]:
        runtime.handle("personas.update", {"personaId": persona["id"], "modelId": descriptor.id})
    engine = ScriptedGroupEngine(lambda _payload, _index: "never")
    runtime.agent_engine = engine  # type: ignore[assignment]
    base: dict[str, Any] = {
        "conversationId": group["conversationId"],
        "branchId": group["branchId"],
        "content": "Use the group.",
        "mentions": [],
    }
    preflight, _ = runtime.handle("groups.turn.preflight", base)
    assert preflight["confirmationRequired"] is True
    assert preflight["confirmationToken"]
    rejected = send_params(base, preflight)
    rejected["confirmationToken"] = "wrong-token"
    with pytest.raises(RuntimeCommandError, match="exact fresh disclosure confirmation"):
        asyncio.run(send(runtime, rejected))
    assert engine.selector_requests == []
    assert engine.member_requests == []

    preflight, _ = runtime.handle("groups.turn.preflight", base)
    runtime.handle("settings.set", {"key": "privacy.default_mode", "value": "offline"})
    with pytest.raises(RuntimeCommandError, match="Privacy changed to offline"):
        asyncio.run(send(runtime, send_params(base, preflight)))
    assert engine.selector_requests == []
    assert engine.member_requests == []
    history, _ = runtime.handle("chat.history", {"branchId": group["branchId"]})
    assert history == []
    runtime.close()


def test_confirmation_token_and_head_are_bound_before_any_group_io(tmp_path: Path) -> None:
    runtime = service(tmp_path)
    group = configured_group(runtime)
    engine = ScriptedGroupEngine(lambda _payload, _index: "never")
    runtime.agent_engine = engine  # type: ignore[assignment]
    base: dict[str, Any] = {
        "conversationId": group["conversationId"],
        "branchId": group["branchId"],
        "content": "Use the group.",
        "mentions": [],
    }
    preflight, _ = runtime.handle("groups.turn.preflight", base)
    tampered = send_params(base, preflight)
    tampered["digest"] = "0" * 64
    with pytest.raises(RuntimeCommandError, match="changed"):
        asyncio.run(send(runtime, tampered))

    preflight, _ = runtime.handle("groups.turn.preflight", base)
    runtime.repository.append_message(
        group["branchId"],
        role=MessageRole.USER,
        content="Concurrent message",
        expected_head_id=None,
    )
    with pytest.raises(RuntimeCommandError, match="conversation changed"):
        asyncio.run(send(runtime, send_params(base, preflight)))
    assert engine.selector_requests == []
    assert engine.member_requests == []
    runtime.close()


def test_partial_member_failure_is_persisted_with_speaker_attribution(tmp_path: Path) -> None:
    runtime = service(tmp_path)
    group = configured_group(runtime)

    def choose(payload: dict[str, Any], _index: int) -> str:
        return json.dumps(
            {
                "decision": "speak",
                "participantId": payload["allowedRemainingCandidates"][0]["participantId"],
                "reasonCode": "best_fit",
                "reason": "Best fit.",
            }
        )

    engine = PartialFailureEngine(choose)
    runtime.agent_engine = engine  # type: ignore[assignment]
    base: dict[str, Any] = {
        "conversationId": group["conversationId"],
        "branchId": group["branchId"],
        "content": "Start an answer.",
        "mentions": [],
    }
    preflight, _ = runtime.handle("groups.turn.preflight", base)
    result, events = asyncio.run(send(runtime, send_params(base, preflight)))
    assert result["status"] == "member_failed"
    assert result["members"][0]["status"] == "failed"
    assert result["members"][0]["messageId"]
    history, _ = runtime.handle("chat.history", {"branchId": group["branchId"]})
    assert history[-1]["state"] == "error"
    assert history[-1]["content"] == "partial answer"
    assert history[-1]["canonical_metadata"]["group"]["speaker"]["handle"] == "mira"
    failed = next(event for event in events if event["type"] == "group.speaker.failed")
    assert failed["payload"]["sequence"] == 1
    assert failed["payload"]["speaker"]["handle"] == "mira"
    assert failed["payload"]["messageId"] == history[-1]["id"]
    runtime.close()


def test_cancel_active_member_persists_partial_and_terminal_child_state(tmp_path: Path) -> None:
    runtime = service(tmp_path)
    group = configured_group(runtime)

    def choose(payload: dict[str, Any], _index: int) -> str:
        return json.dumps(
            {
                "decision": "speak",
                "participantId": payload["allowedRemainingCandidates"][0]["participantId"],
                "reasonCode": "best_fit",
                "reason": "Best fit.",
            }
        )

    engine = SlowMemberEngine(choose)
    runtime.agent_engine = engine  # type: ignore[assignment]
    base: dict[str, Any] = {
        "conversationId": group["conversationId"],
        "branchId": group["branchId"],
        "content": "Begin a response.",
        "mentions": [],
    }
    preflight, _ = runtime.handle("groups.turn.preflight", base)

    async def scenario() -> dict[str, Any]:
        sending = asyncio.create_task(send(runtime, send_params(base, preflight)))
        await asyncio.wait_for(engine.member_started.wait(), timeout=5)
        assert runtime.cancel_active(preflight["turnId"]) is True
        result, _ = await asyncio.wait_for(sending, timeout=5)
        return result

    result = asyncio.run(scenario())
    assert result["status"] == "cancelled"
    assert result["members"][0]["status"] == "cancelled"
    assert result["members"][0]["messageId"]
    history, _ = runtime.handle("chat.history", {"branchId": group["branchId"]})
    assert history[-1]["state"] == "cancelled"
    assert history[-1]["content"] == "partial"
    assert history[-1]["canonical_metadata"]["group"]["speaker"]["handle"] == "mira"
    runtime.close()


def test_active_turn_blocks_same_branch_preflight_but_not_another_branch(
    tmp_path: Path,
) -> None:
    runtime = service(tmp_path)
    group = configured_group(runtime)

    def choose(payload: dict[str, Any], _index: int) -> str:
        return json.dumps(
            {
                "decision": "speak",
                "participantId": payload["allowedRemainingCandidates"][0]["participantId"],
                "reasonCode": "best_fit",
                "reason": "Best fit.",
            }
        )

    engine = SlowMemberEngine(choose)
    runtime.agent_engine = engine  # type: ignore[assignment]
    base: dict[str, Any] = {
        "conversationId": group["conversationId"],
        "branchId": group["branchId"],
        "content": "Please answer this slowly.",
        "mentions": [],
    }
    preflight, _ = runtime.handle("groups.turn.preflight", base)

    async def scenario() -> dict[str, Any]:
        running = asyncio.create_task(send(runtime, send_params(base, preflight)))
        await asyncio.wait_for(engine.member_started.wait(), timeout=5)
        with pytest.raises(RuntimeCommandError, match="current group turn"):
            runtime.handle(
                "groups.turn.preflight",
                {**base, "content": "Do not overlap this turn."},
            )
        history, _ = runtime.handle("chat.history", {"branchId": group["branchId"]})
        forked, _ = runtime.handle(
            "conversations.branch",
            {
                "conversationId": group["conversationId"],
                "fromMessageId": history[0]["id"],
                "name": "Parallel branch",
            },
        )
        other, _ = runtime.handle(
            "groups.turn.preflight",
            {
                **base,
                "branchId": forked["id"],
                "content": "This branch remains independent.",
            },
        )
        assert other["sendable"] is True
        assert runtime.cancel_active(preflight["turnId"]) is True
        result, _events = await asyncio.wait_for(running, timeout=5)
        return result

    result = asyncio.run(scenario())
    assert result["status"] == "cancelled"
    runtime.close()


def test_user_append_rolls_back_if_durable_turn_creation_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime = service(tmp_path)
    group = configured_group(runtime)
    base: dict[str, Any] = {
        "conversationId": group["conversationId"],
        "branchId": group["branchId"],
        "content": "Do not persist half a turn.",
        "mentions": [],
    }
    preflight, _ = runtime.handle("groups.turn.preflight", base)

    def fail_create_turn(**_kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("durability unavailable")

    monkeypatch.setattr(runtime.groups, "create_turn", fail_create_turn)
    with pytest.raises(RuntimeError, match="durability unavailable"):
        asyncio.run(send(runtime, send_params(base, preflight)))
    history, _ = runtime.handle("chat.history", {"branchId": group["branchId"]})
    assert history == []
    runtime.close()


def test_solo_chat_actions_cannot_bypass_group_roster_or_attribution(tmp_path: Path) -> None:
    runtime = service(tmp_path)
    group = configured_group(runtime, max_replies=1)
    with pytest.raises(RuntimeCommandError, match="group composer"):
        runtime.handle(
            "chat.send",
            {
                "conversationId": group["conversationId"],
                "branchId": group["branchId"],
                "content": "Bypass the roster",
                "modelId": "mock:cupcake-deterministic",
            },
        )
    history, _ = runtime.handle("chat.history", {"branchId": group["branchId"]})
    assert history == []
    runtime.close()


def test_unavailable_direct_mention_returns_repair_without_loading_or_model_io(
    tmp_path: Path,
) -> None:
    runtime = service(tmp_path)
    group = configured_group(runtime, max_replies=1)
    descriptor = runtime.providers.register_openai_compatible_endpoint(
        "unloaded-local",
        model="local-model",
        display_name="Unloaded Local",
        base_url="http://127.0.0.1:65530/v1",
        metadata={"runtime_kind": "cupcake_llama_cpp", "runtime_loaded": False},
    )
    runtime.providers.catalog.register(
        replace(descriptor, privacy_route=PrivacyRoute.LOCAL), replace=True
    )
    first_persona = group["personas"][0]
    runtime.handle("personas.update", {"personaId": first_persona["id"], "modelId": descriptor.id})
    participant = runtime.handle(
        "conversations.participants.list", {"conversationId": group["conversationId"]}
    )[0][0]
    content = "@mira help"
    preflight, _ = runtime.handle(
        "groups.turn.preflight",
        {
            "conversationId": group["conversationId"],
            "branchId": group["branchId"],
            "content": content,
            "mentions": [
                {
                    "participantId": participant["id"],
                    "personaId": participant["personaId"],
                    "start": 0,
                    "end": 5,
                    "token": "@mira",
                }
            ],
        },
    )
    assert preflight["sendable"] is False
    assert preflight["eligibleSpeakers"] == []
    assert preflight["ineligibleSpeakers"][0]["reasonCode"] == "local_not_loaded"
    assert preflight["ineligibleSpeakers"][0]["repairAction"] == "load_local_model"
    assert preflight["confirmationToken"] is None
    with pytest.raises(RuntimeCommandError, match="Review this group turn again"):
        asyncio.run(
            send(
                runtime,
                {
                    "conversationId": group["conversationId"],
                    "branchId": group["branchId"],
                    "content": content,
                    "mentions": [],
                    "turnId": preflight["turnId"],
                    "planRevision": preflight["planRevision"],
                    "digest": preflight["digest"],
                    "confirmationToken": None,
                },
            )
        )
    runtime.close()
