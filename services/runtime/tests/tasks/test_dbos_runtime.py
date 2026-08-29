from __future__ import annotations

import sqlite3
import subprocess
import sys
import time
from pathlib import Path

from cupcake_runtime.events import SqliteEventJournal
from cupcake_runtime.tasks import (
    ApprovalStatus,
    DeterministicFakeExecutor,
    DurableTaskCoordinator,
    RunStatus,
    RuntimeRevision,
    SqliteDurabilityStore,
    TaskSpec,
    TaskStep,
    create_production_dbos_runtime,
)


def build_runtime(
    root: Path,
    executor: DeterministicFakeExecutor | None = None,
    *,
    binding_key: str = "cupcake-test",
):
    store = SqliteDurabilityStore(str(root / "product-tasks.sqlite"))
    journal = SqliteEventJournal(str(root / "events.sqlite"))
    coordinator = DurableTaskCoordinator(
        store,
        journal,
        executor or DeterministicFakeExecutor(),
        runtime_revision=RuntimeRevision(2, 0, 0),
    )
    runtime = create_production_dbos_runtime(
        coordinator,
        system_database_path=root / "dbos-system.sqlite",
        binding_key=binding_key,
        executor_id="cupcake-test-executor",
    )
    return runtime, coordinator, store, journal


def task(*steps: TaskStep) -> TaskSpec:
    return TaskSpec(title="DBOS task", prompt="Run durably", steps=steps)


def wait_for_status(
    store: SqliteDurabilityStore,
    run_id: str,
    expected: RunStatus,
    *,
    timeout: float = 10,
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if store.get_run(run_id).status is expected:
            return
        time.sleep(0.02)
    raise AssertionError(f"run did not reach {expected.value}")


def test_real_dbos_steps_and_workflow_id_are_idempotent(tmp_path: Path) -> None:
    executor = DeterministicFakeExecutor()
    runtime, coordinator, store, journal = build_runtime(tmp_path, executor)
    try:
        run, _ = coordinator.create(
            task(TaskStep("one", "first-effect"), TaskStep("two", "second-effect"))
        )

        first = runtime.start(run.run_id)
        second = runtime.start(run.run_id)
        result = runtime.wait(run.run_id)

        assert first.workflow_id == second.workflow_id == run.run_id
        assert result["status"] == RunStatus.SUCCEEDED.value
        assert [call[0] for call in executor.calls] == ["one", "two"]
        assert store.get_run(run.run_id).current_step == 2
        status = runtime.get_status(run.run_id)
        assert status is not None and status.status == "SUCCESS"
        assert status.application_version == "runtime-2"

        dbos_database = sqlite3.connect(tmp_path / "dbos-system.sqlite")
        try:
            tables = {
                row[0]
                for row in dbos_database.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            checkpointed_product_steps = dbos_database.execute(
                "SELECT function_name FROM operation_outputs "
                "WHERE workflow_uuid=? AND function_name='cupcake.task.execute-step'",
                (run.run_id,),
            ).fetchall()
        finally:
            dbos_database.close()
        assert "workflow_status" in tables
        assert "operation_outputs" in tables
        assert len(checkpointed_product_steps) == 2
    finally:
        runtime.shutdown()
        store.close()
        journal.close()


def test_approval_resumes_in_an_idempotent_continuation_workflow(tmp_path: Path) -> None:
    runtime, coordinator, store, journal = build_runtime(tmp_path)
    try:
        step = TaskStep(
            "publish",
            "external.write",
            requires_approval=True,
            approval_intent_digest="sha256:stable-publish-intent",
        )
        run, _ = coordinator.create(task(step))
        runtime.start(run.run_id)
        wait_for_status(store, run.run_id, RunStatus.WAITING_APPROVAL)
        approval = store.get_approval(run.run_id, step.key)
        assert approval is not None and approval.status is ApprovalStatus.PENDING

        runtime.resolve_approval(
            approval.approval_id,
            approved=True,
            response={"reviewed": True},
        )
        result = runtime.wait(run.run_id)

        assert result["status"] == RunStatus.SUCCEEDED.value
        persisted = store.get_approval(run.run_id, step.key)
        assert persisted is not None and persisted.status is ApprovalStatus.APPROVED
        assert persisted.response == {"reviewed": True}
        status = runtime.get_status(run.run_id)
        assert status is not None
        assert status.workflow_id == f"{run.run_id}:approval:{approval.approval_id}"
        assert status.status == "SUCCESS"
    finally:
        runtime.shutdown()
        store.close()
        journal.close()


def test_cancellation_preempts_a_workflow_waiting_for_approval(tmp_path: Path) -> None:
    runtime, coordinator, store, journal = build_runtime(tmp_path)
    try:
        step = TaskStep(
            "delete",
            "filesystem.delete",
            requires_approval=True,
            approval_intent_digest="sha256:stable-delete-intent",
        )
        run, _ = coordinator.create(task(step))
        runtime.start(run.run_id)
        wait_for_status(store, run.run_id, RunStatus.WAITING_APPROVAL)

        cancelled = runtime.cancel(run.run_id)

        assert cancelled.status is RunStatus.CANCELLED
        wait_for_status(store, run.run_id, RunStatus.CANCELLED)
        status = runtime.get_status(run.run_id)
        assert status is not None and status.status in {"SUCCESS", "CANCELLED"}
    finally:
        runtime.shutdown()
        store.close()
        journal.close()


def test_process_restart_recovers_without_duplicate_completed_effects(tmp_path: Path) -> None:
    worker = Path(__file__).with_name("_dbos_recovery_worker.py")
    crashed = subprocess.run(
        [sys.executable, str(worker), str(tmp_path), "crash"],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert crashed.returncode == 73, crashed.stderr

    recovered = subprocess.run(
        [sys.executable, str(worker), str(tmp_path), "recover"],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert recovered.returncode == 0, recovered.stderr
    assert (tmp_path / "effects.txt").read_text(encoding="utf-8").splitlines() == [
        "one",
        "two",
    ]
