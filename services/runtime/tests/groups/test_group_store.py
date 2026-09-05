from __future__ import annotations

import pytest

from cupcake_runtime.domain.models import MessageRole
from cupcake_runtime.groups import GroupStore, GroupStrategy, GroupTurnStatus
from cupcake_runtime.storage.database import Database
from cupcake_runtime.storage.repositories import ProductRepository


def test_personas_roster_lead_and_unique_safe_reorder(database: Database) -> None:
    repository = ProductRepository(database)
    conversation, _ = repository.create_conversation()
    store = GroupStore(database)
    first = store.create_persona(
        name="Mira", handle="mira-one", model_id="mock:cupcake-deterministic"
    )
    second = store.create_persona(
        name="Mira", handle="mira_two", model_id="mock:cupcake-deterministic"
    )
    one = store.add_participant(conversation.id, first.id)
    two = store.add_participant(conversation.id, second.id)

    roster = store.list_participants(conversation.id)
    assert roster[0]["id"] == one["id"]
    assert roster[0]["persona"]["id"] == first.id
    assert roster[0]["id"] != roster[0]["persona"]["id"]
    assert roster[0]["isLead"] is True
    assert roster[1]["id"] == two["id"]
    store.reorder_participants(conversation.id, [two["id"], one["id"]])
    assert [item["id"] for item in store.list_participants(conversation.id)] == [
        two["id"],
        one["id"],
    ]

    settings = store.set_settings(
        conversation.id,
        strategy=GroupStrategy.SMART,
        max_replies=3,
        lead_participant_id=two["id"],
    )
    assert settings["leadParticipantId"] == two["id"]
    store.archive_persona(second.id)
    assert store.get_settings(conversation.id)["leadParticipantId"] == one["id"]
    store.remove_participant(conversation.id, one["id"])
    assert store.get_settings(conversation.id)["leadParticipantId"] is None


def test_persona_handle_and_avatar_contract(database: Database) -> None:
    store = GroupStore(database)
    for handle in ("Ava", "a", "has space"):
        with pytest.raises(ValueError):
            store.create_persona(name="Ava", handle=handle, model_id="mock:x")
    with pytest.raises(ValueError):
        store.create_persona(
            name="Ava", handle="ava", model_id="mock:x", avatar="C:/private/me.png"
        )
    profile = store.create_persona(
        name="Ava", handle="ava-two", model_id="mock:x", avatar="atlas:7"
    )
    with pytest.raises(ValueError, match="already in use"):
        store.create_persona(name="Other", handle="ava-two", model_id="mock:x")
    assert profile.handle == "ava-two"


def test_turn_state_persists_usage_and_recovers(database: Database) -> None:
    repository = ProductRepository(database)
    conversation, branch = repository.create_conversation()
    user = repository.append_message(
        branch.id,
        role=MessageRole.USER,
        content="Discuss this",
        expected_head_id=None,
    )
    store = GroupStore(database)
    turn = store.create_turn(
        turn_id=user.id,
        conversation_id=conversation.id,
        branch_id=branch.id,
        user_message_id=user.id,
        mode="smart",
        digest="a" * 64,
        plan_revision="b" * 64,
        responder_limit=2,
        plan={"rosterRevision": 4},
    )
    assert turn["userMessageId"] == user.id
    store.record_selector(
        user.id,
        status="completed",
        selection={"decision": "pass", "participantId": None},
        usage={"inputTokens": 7, "outputTokens": 3},
    )
    assert store.get_turn(user.id)["selectorUsage"][0]["usage"]["inputTokens"] == 7
    store.record_member_selected(
        user.id,
        sequence=1,
        participant_id="participant",
        reason_code="best_fit",
        reason="Best fit.",
        snapshot={},
    )
    assert store.recover_interrupted() == 1
    assert store.get_turn(user.id)["status"] == GroupTurnStatus.INTERRUPTED.value
    assert store.get_turn(user.id)["members"][0]["status"] == "cancelled"
    assert store.get_turn(user.id)["members"][0]["errorCode"] == "RUNTIME_RESTART"


def test_store_refuses_two_running_turns_on_the_same_branch(database: Database) -> None:
    repository = ProductRepository(database)
    conversation, branch = repository.create_conversation()
    first = repository.append_message(
        branch.id,
        role=MessageRole.USER,
        content="First",
        expected_head_id=None,
    )
    store = GroupStore(database)
    store.create_turn(
        turn_id="turn-one",
        conversation_id=conversation.id,
        branch_id=branch.id,
        user_message_id=first.id,
        mode="smart",
        digest="a" * 64,
        plan_revision="b" * 64,
        responder_limit=2,
        plan={},
    )
    assert store.active_turn(conversation.id, branch_id=branch.id) is not None
    with pytest.raises(ValueError, match="already running"):
        store.create_turn(
            turn_id="turn-two",
            conversation_id=conversation.id,
            branch_id=branch.id,
            user_message_id=first.id,
            mode="smart",
            digest="c" * 64,
            plan_revision="d" * 64,
            responder_limit=2,
            plan={},
        )
