from __future__ import annotations

from pathlib import Path
from threading import Event, Thread

import pytest

from cupcake_runtime.events import EventKind, SqliteEventJournal
from cupcake_runtime.tasks import (
    ApprovalStatus,
    CheckpointConflictError,
    DeterministicFakeExecutor,
    DurableTaskCoordinator,
    IncompatibleRuntimeError,
    InvalidTransitionError,
    RevisionCompatibility,
    RunMode,
    RunStatus,
    RuntimeRevision,
    SqliteDurabilityStore,
    TaskPromotionPolicy,
    TaskSpec,
    TaskStep,
    WorkKind,
)


def build_coordinator(
    root: Path,
    executor: DeterministicFakeExecutor | None = None,
    *,
    revision: RuntimeRevision | None = None,
) -> tuple[DurableTaskCoordinator, SqliteDurabilityStore, SqliteEventJournal]:
    store = SqliteDurabilityStore(str(root / "tasks.sqlite"))
    journal = SqliteEventJournal(str(root / "events.sqlite"))
    coordinator = DurableTaskCoordinator(
        store,
        journal,
        executor or DeterministicFakeExecutor(),
        runtime_revision=revision or RuntimeRevision(1, 0, 0),
    )
    return coordinator, store, journal


def spec(
    *steps: TaskStep,
    seconds: float | None = None,
    kind: WorkKind = WorkKind.CHAT,
    explicit: bool = False,
) -> TaskSpec:
    return TaskSpec(
        title="Test task",
        prompt="Do the durable work",
        steps=steps,
        work_kind=kind,
        estimated_seconds=seconds,
        explicitly_background=explicit,
    )


@pytest.mark.parametrize(
    ("task_spec", "expected_mode", "reason"),
    [
        (spec(TaskStep("one", "chat"), seconds=20), RunMode.INTERACTIVE, None),
        (spec(TaskStep("one", "chat"), seconds=20.01), RunMode.BACKGROUND, "estimated_duration"),
        (
            spec(TaskStep("one", "index"), kind=WorkKind.REPOSITORY_INDEX),
            RunMode.BACKGROUND,
            "repository_index",
        ),
        (
            spec(TaskStep("one", "a"), TaskStep("two", "b")),
            RunMode.BACKGROUND,
            "multiple_dependent_tool_stages",
        ),
        (spec(TaskStep("one", "chat"), explicit=True), RunMode.BACKGROUND, "explicit_request"),
    ],
)
def test_promotion_policy(task_spec, expected_mode, reason) -> None:
    decision = TaskPromotionPolicy().decide(task_spec)
    assert decision.mode is expected_mode
    if reason:
        assert reason in decision.reasons
    else:
        assert decision.reasons == ()


def test_checkpointed_run_is_idempotent(tmp_path) -> None:
    executor = DeterministicFakeExecutor()
    coordinator, store, journal = build_coordinator(tmp_path, executor)
    run, _ = coordinator.create(spec(TaskStep("one", "alpha"), TaskStep("two", "beta")))

    completed = coordinator.run(run.run_id)
    assert completed.status is RunStatus.SUCCEEDED
    assert completed.current_step == 2
    assert [call[0] for call in executor.calls] == ["one", "two"]
    assert coordinator.run(run.run_id).status is RunStatus.SUCCEEDED
    assert len(executor.calls) == 2
    assert store.get_checkpoint(run.run_id, "one") is not None
    assert any(item.kind is EventKind.STEP_CHECKPOINTED for item in journal.read(run.run_id))


def test_restart_recovers_from_last_checkpoint_without_duplicate_effect(tmp_path) -> None:
    def crash(_step, _context, _key):
        raise KeyboardInterrupt("simulated process death")

    first_executor = DeterministicFakeExecutor(operations={"crash": crash})
    coordinator, store, journal = build_coordinator(tmp_path, first_executor)
    run, _ = coordinator.create(spec(TaskStep("one", "ok"), TaskStep("two", "crash")))
    with pytest.raises(KeyboardInterrupt):
        coordinator.run(run.run_id)
    assert store.get_run(run.run_id).status is RunStatus.RUNNING
    assert store.get_run(run.run_id).current_step == 1

    store.close()
    journal.close()
    second_executor = DeterministicFakeExecutor()
    recovered, recovered_store, recovered_journal = build_coordinator(tmp_path, second_executor)
    results = recovered.recover()

    assert results[0].status is RunStatus.SUCCEEDED
    assert [call[0] for call in second_executor.calls] == ["two"]
    assert recovered_store.get_run(run.run_id).current_step == 2
    kinds = [item.kind for item in recovered_journal.read(run.run_id)]
    assert EventKind.RUN_RECOVERED in kinds


def test_approval_survives_restart_and_can_resume(tmp_path) -> None:
    coordinator, store, journal = build_coordinator(tmp_path)
    step = TaskStep(
        "publish",
        "external.write",
        requires_approval=True,
        approval_intent_digest="sha256:fixed-intent",
    )
    run, _ = coordinator.create(spec(step))
    waiting = coordinator.run(run.run_id)
    approval = store.get_approval(run.run_id, step.key)

    assert waiting.status is RunStatus.WAITING_APPROVAL
    assert approval is not None and approval.status is ApprovalStatus.PENDING
    store.close()
    journal.close()

    recovered, _recovered_store, _ = build_coordinator(tmp_path)
    assert recovered.recover()[0].status is RunStatus.WAITING_APPROVAL
    queued = recovered.resolve_approval(approval.approval_id, approved=True)
    assert queued.status is RunStatus.QUEUED
    assert recovered.run(run.run_id).status is RunStatus.SUCCEEDED
    with pytest.raises(CheckpointConflictError):
        recovered.resolve_approval(approval.approval_id, approved=False)


def test_denied_approval_and_cancel_are_terminal(tmp_path) -> None:
    coordinator, store, _ = build_coordinator(tmp_path)
    step = TaskStep("delete", "delete", requires_approval=True, approval_intent_digest="digest")
    run, _ = coordinator.create(spec(step))
    coordinator.run(run.run_id)
    approval = store.get_approval(run.run_id, step.key)
    assert approval is not None
    assert (
        coordinator.resolve_approval(approval.approval_id, approved=False).status
        is RunStatus.CANCELLED
    )

    queued, _ = coordinator.create(spec(TaskStep("one", "wait")))
    assert coordinator.request_cancel(queued.run_id).status is RunStatus.CANCELLED


def test_steer_and_followup_commands_are_durable(tmp_path) -> None:
    captured: list[tuple[str, ...]] = []

    def capture(_step, context, _key):
        captured.append(context.steering)
        return {"ok": True}

    executor = DeterministicFakeExecutor(operations={"capture": capture})
    coordinator, _store, _journal = build_coordinator(tmp_path, executor)
    run, _ = coordinator.create(spec(TaskStep("one", "capture")))
    coordinator.steer(run.run_id, "Prefer the safer route")
    coordinator.queue_followup(run.run_id, "Then write a summary")

    assert coordinator.run(run.run_id).status is RunStatus.SUCCEEDED
    assert captured == [("Prefer the safer route",)]
    assert coordinator.take_followups(run.run_id) == ["Then write a summary"]
    assert coordinator.take_followups(run.run_id) == []


def test_followup_queue_survives_store_restart(tmp_path) -> None:
    coordinator, store, journal = build_coordinator(tmp_path)
    run, _ = coordinator.create(spec(TaskStep("one", "work")))
    coordinator.queue_followup(run.run_id, "Continue after restart")
    store.close()
    journal.close()

    recovered, _store, _journal = build_coordinator(tmp_path)
    assert recovered.take_followups(run.run_id) == ["Continue after restart"]


def test_pending_cancellation_is_completed_during_restart_recovery(tmp_path) -> None:
    coordinator, store, journal = build_coordinator(tmp_path)
    run, _ = coordinator.create(spec(TaskStep("one", "work")))
    store.transition(run.run_id, RunStatus.RUNNING)
    store.request_cancellation(run.run_id)
    store.close()
    journal.close()

    recovered, recovered_store, _journal = build_coordinator(tmp_path)
    result = recovered.recover()[0]
    assert result.status is RunStatus.CANCELLED
    assert recovered_store.get_run(run.run_id).status is RunStatus.CANCELLED


def test_cancel_during_a_running_step_finishes_cancelled(tmp_path) -> None:
    entered = Event()
    release = Event()

    def blocking(_step, _context, _key):
        entered.set()
        assert release.wait(timeout=5)
        return {"effect": "completed_once"}

    executor = DeterministicFakeExecutor(operations={"blocking": blocking})
    coordinator, store, _journal = build_coordinator(tmp_path, executor)
    run, _ = coordinator.create(spec(TaskStep("one", "blocking")))
    worker = Thread(target=coordinator.run, args=(run.run_id,))
    worker.start()
    assert entered.wait(timeout=5)

    assert coordinator.request_cancel(run.run_id).status is RunStatus.CANCELLING
    release.set()
    worker.join(timeout=5)

    assert not worker.is_alive()
    assert store.get_run(run.run_id).status is RunStatus.CANCELLED
    assert store.get_checkpoint(run.run_id, "one") is not None


def test_steering_received_mid_step_applies_at_next_boundary(tmp_path) -> None:
    entered = Event()
    release = Event()
    captured: list[tuple[str, ...]] = []

    def blocking(_step, _context, _key):
        entered.set()
        assert release.wait(timeout=5)
        return {"ok": True}

    def capture(_step, context, _key):
        captured.append(context.steering)
        return {"ok": True}

    executor = DeterministicFakeExecutor(operations={"blocking": blocking, "capture": capture})
    coordinator, store, _journal = build_coordinator(tmp_path, executor)
    run, _ = coordinator.create(spec(TaskStep("one", "blocking"), TaskStep("two", "capture")))
    worker = Thread(target=coordinator.run, args=(run.run_id,))
    worker.start()
    assert entered.wait(timeout=5)

    coordinator.steer(run.run_id, "Use the reviewed evidence")
    release.set()
    worker.join(timeout=5)

    assert not worker.is_alive()
    assert store.get_run(run.run_id).status is RunStatus.SUCCEEDED
    assert captured == [("Use the reviewed evidence",)]


def test_checkpoint_and_approval_intents_cannot_change(tmp_path) -> None:
    coordinator, store, _journal = build_coordinator(tmp_path)
    run, _ = coordinator.create(spec(TaskStep("one", "work")))
    store.save_checkpoint(run.run_id, "one", "digest-a", {"a": 1}, RuntimeRevision(1))
    assert (
        store.save_checkpoint(run.run_id, "one", "digest-a", {"a": 1}, RuntimeRevision(1)) is False
    )
    with pytest.raises(CheckpointConflictError):
        store.save_checkpoint(run.run_id, "one", "digest-b", {"a": 2}, RuntimeRevision(1))


def test_newer_checkpoint_revision_cannot_be_reused(tmp_path) -> None:
    coordinator, store, _journal = build_coordinator(tmp_path, revision=RuntimeRevision(1, 2, 0))
    run, _ = coordinator.create(spec(TaskStep("one", "work")))
    digest = coordinator._step_input_digest("work", {}, [])
    store.save_checkpoint(
        run.run_id,
        "one",
        digest,
        {"from": "future"},
        RuntimeRevision(1, 3, 0),
    )

    result = coordinator.run(run.run_id)
    assert result.status is RunStatus.FAILED
    assert "newer than runtime" in (result.error or "")


def test_steering_after_checkpoint_crash_applies_to_next_unfinished_step(tmp_path) -> None:
    captured: list[tuple[str, ...]] = []

    def capture(_step, context, _key):
        captured.append(context.steering)
        return {"ok": True}

    executor = DeterministicFakeExecutor(operations={"capture": capture})
    coordinator, store, _journal = build_coordinator(tmp_path, executor)
    run, _ = coordinator.create(spec(TaskStep("one", "already-done"), TaskStep("two", "capture")))
    original_digest = coordinator._step_input_digest("already-done", {}, [])
    store.save_checkpoint(
        run.run_id,
        "one",
        original_digest,
        {"done": True},
        RuntimeRevision(1),
    )
    coordinator.steer(run.run_id, "Apply this only to remaining work")

    assert coordinator.run(run.run_id).status is RunStatus.SUCCEEDED
    assert [call[0] for call in executor.calls] == ["two"]
    assert captured == [("Apply this only to remaining work",)]


def test_incompatible_runtime_fails_recovery_without_execution(tmp_path) -> None:
    original, store, journal = build_coordinator(tmp_path, revision=RuntimeRevision(2, 0, 0))
    _run, _ = original.create(spec(TaskStep("one", "work")))
    store.close()
    journal.close()

    executor = DeterministicFakeExecutor()
    current, _current_store, _ = build_coordinator(
        tmp_path, executor, revision=RuntimeRevision(1, 5, 0)
    )
    result = current.recover()[0]
    assert result.status is RunStatus.FAILED
    assert "cannot resume" in (result.error or "")
    assert executor.calls == []


def test_revision_policy_accepts_older_same_major_and_rejects_newer() -> None:
    policy = RevisionCompatibility(RuntimeRevision(2, 3, 0))
    policy.assert_can_resume(RuntimeRevision(2, 2, 9))
    with pytest.raises(IncompatibleRuntimeError):
        policy.assert_can_resume(RuntimeRevision(2, 4, 0))
    with pytest.raises(IncompatibleRuntimeError):
        policy.assert_can_resume(RuntimeRevision(1, 9, 9))


def test_terminal_state_machine_rejects_illegal_transition(tmp_path) -> None:
    coordinator, store, _journal = build_coordinator(tmp_path)
    run, _ = coordinator.create(spec(TaskStep("one", "work")))
    assert coordinator.run(run.run_id).status is RunStatus.SUCCEEDED
    with pytest.raises(InvalidTransitionError):
        store.transition(run.run_id, RunStatus.RUNNING)
