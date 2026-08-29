"""Subprocess worker used to prove real DBOS crash recovery."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from cupcake_runtime.events import SqliteEventJournal
from cupcake_runtime.tasks import (
    DeterministicFakeExecutor,
    DurableTaskCoordinator,
    RunStatus,
    RuntimeRevision,
    SqliteDurabilityStore,
    TaskSpec,
    TaskStep,
    create_production_dbos_runtime,
)


def append_effect(path: Path, value: str) -> None:
    with path.open("a", encoding="utf-8") as stream:
        stream.write(f"{value}\n")
        stream.flush()
        os.fsync(stream.fileno())


def main() -> int:
    root = Path(sys.argv[1])
    phase = sys.argv[2]
    effects = root / "effects.txt"
    run_id_path = root / "run-id.txt"
    store = SqliteDurabilityStore(str(root / "product-tasks.sqlite"))
    journal = SqliteEventJournal(str(root / "events.sqlite"))

    def first_effect(_step, _context, _idempotency_key):
        append_effect(effects, "one")
        return {"effect": "one"}

    def second_effect(_step, _context, _idempotency_key):
        if phase == "crash":
            os._exit(73)
        append_effect(effects, "two")
        return {"effect": "two"}

    coordinator = DurableTaskCoordinator(
        store,
        journal,
        DeterministicFakeExecutor(
            operations={"first-effect": first_effect, "second-effect": second_effect}
        ),
        runtime_revision=RuntimeRevision(2, 0, 0),
    )
    runtime = create_production_dbos_runtime(
        coordinator,
        system_database_path=root / "dbos-system.sqlite",
        binding_key="cupcake-recovery-test",
        executor_id="cupcake-recovery-test-executor",
    )
    if phase == "crash":
        run, _ = coordinator.create(
            TaskSpec(
                title="Recovery test",
                prompt="Prove DBOS recovery",
                steps=(
                    TaskStep("one", "first-effect"),
                    TaskStep("two", "second-effect"),
                ),
            )
        )
        run_id_path.write_text(run.run_id, encoding="utf-8")
        runtime.start(run.run_id)
        runtime.wait(run.run_id)
        return 74

    run_id = run_id_path.read_text(encoding="utf-8")
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        run = store.get_run(run_id)
        if run.status is RunStatus.SUCCEEDED:
            runtime.shutdown()
            store.close()
            journal.close()
            return 0
        if run.status in {RunStatus.FAILED, RunStatus.CANCELLED}:
            return 75
        time.sleep(0.05)
    return 76


if __name__ == "__main__":
    raise SystemExit(main())
