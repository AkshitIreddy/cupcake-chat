from __future__ import annotations

from threading import Event, Thread

import pytest

from cupcake_runtime.agents import (
    DEFAULT_ROLE_PROFILES,
    AgentRole,
    BudgetLedger,
    BudgetLimits,
    BudgetUsage,
    DelegateControl,
    DelegateCoordinator,
    DelegateResult,
    DelegateStatus,
    DeterministicDelegateExecutor,
    PydanticAIExecutor,
    RoleProfile,
)
from cupcake_runtime.events import EventKind, SqliteEventJournal


def coordinator(tmp_path, *, usage: BudgetUsage | None = None):
    journal = SqliteEventJournal(str(tmp_path / "events.sqlite"))
    executor = DeterministicDelegateExecutor(usage=usage or BudgetUsage(100, 50, 1, 0.1, 0.01))
    ledger = BudgetLedger(BudgetLimits(100_000, 100_000, 100, 50.0, 3600.0))
    return DelegateCoordinator(executor, journal, ledger), executor, journal, ledger


def test_all_registered_roles_execute_with_bounded_tools(tmp_path) -> None:
    manager, executor, journal, ledger = coordinator(tmp_path)
    tools = {
        AgentRole.RESEARCHER: frozenset({"web.search"}),
        AgentRole.CODER: frozenset({"patch.propose"}),
        AgentRole.REVIEWER: frozenset({"repo.inspect"}),
        AgentRole.DOCUMENT_ANALYST: frozenset({"document.parse"}),
    }
    for role in AgentRole:
        request = manager.make_request(
            "run-1",
            role,
            f"Act as {role.value}",
            requested_tools=tools[role],
        )
        assert manager.execute(request).status is DelegateStatus.SUCCEEDED

    assert len(executor.calls) == 4
    assert ledger.snapshot.usage.tool_calls == 4
    kinds = [item.kind for item in journal.read("run-1")]
    assert kinds.count(EventKind.SUBAGENT_STARTED) == 4
    assert kinds.count(EventKind.SUBAGENT_FINISHED) == 4


def test_role_tool_policy_and_recursion_are_denied_before_execution(tmp_path) -> None:
    manager, executor, _journal, _ledger = coordinator(tmp_path)
    denied = manager.make_request(
        "run-1", AgentRole.RESEARCHER, "Modify code", requested_tools=frozenset({"patch.propose"})
    )
    assert manager.execute(denied).status is DelegateStatus.POLICY_DENIED

    recursive = manager.make_request("run-1", AgentRole.CODER, "Spawn another coder")
    recursive = type(recursive)(
        delegate_id=recursive.delegate_id,
        parent_run_id=recursive.parent_run_id,
        role=recursive.role,
        instruction=recursive.instruction,
        delegation_depth=2,
    )
    assert manager.execute(recursive).status is DelegateStatus.POLICY_DENIED
    assert executor.calls == []


@pytest.mark.parametrize(
    "usage",
    [
        BudgetUsage(input_tokens=101),
        BudgetUsage(output_tokens=51),
        BudgetUsage(tool_calls=3),
        BudgetUsage(cost_usd=1.01),
    ],
)
def test_delegate_token_tool_and_cost_budgets_are_enforced(tmp_path, usage) -> None:
    manager, _executor, _journal, _ledger = coordinator(tmp_path, usage=usage)
    request = manager.make_request(
        "run-1",
        AgentRole.RESEARCHER,
        "Short answer",
        budget=BudgetLimits(100, 50, 2, 1.0, 10.0),
    )
    assert manager.execute(request).status is DelegateStatus.BUDGET_EXCEEDED


def test_parent_budget_is_checked_before_execution(tmp_path) -> None:
    _manager, executor, _journal, _ledger = coordinator(tmp_path)

    small_parent = DelegateCoordinator(
        executor,
        SqliteEventJournal(str(tmp_path / "small-events.sqlite")),
        BudgetLedger(BudgetLimits(10, 10, 1, 0.01, 1.0)),
    )
    unavailable = small_parent.make_request("run-2", AgentRole.REVIEWER, "Review")
    assert small_parent.execute(unavailable).status is DelegateStatus.BUDGET_EXCEEDED


def test_optional_pydantic_ai_adapter_uses_duck_typed_agent() -> None:
    class Usage:
        input_tokens = 12
        output_tokens = 7
        tool_calls = 1
        cost_usd = 0.02

    class Result:
        output = "model output"

        def usage(self):
            return Usage()

    class Agent:
        def run_sync(self, prompt, *, deps):
            assert prompt == "Research"
            assert deps["allowed_tools"] == ["web.search"]
            assert isinstance(deps["cancellation"], DelegateControl)
            return Result()

    executor = PydanticAIExecutor(lambda _profile: Agent())
    request = DelegateCoordinator(
        DeterministicDelegateExecutor(),
        SqliteEventJournal(":memory:"),
        BudgetLedger(BudgetLimits(100_000, 100_000, 100, 50.0, 3600.0)),
    ).make_request(
        "run-1",
        AgentRole.RESEARCHER,
        "Research",
        requested_tools=frozenset({"web.search"}),
    )
    result = executor.execute(
        request,
        DEFAULT_ROLE_PROFILES[AgentRole.RESEARCHER],
        DelegateControl(),
    )
    assert result.content == "model output"
    assert result.usage.input_tokens == 12


def test_cancelled_delegate_never_reaches_executor(tmp_path) -> None:
    manager, executor, _journal, _ledger = coordinator(tmp_path)
    request = manager.make_request("run-1", AgentRole.REVIEWER, "Review")
    manager.cancel(request.delegate_id)
    assert manager.execute(request).status is DelegateStatus.CANCELLED
    assert executor.calls == []


def test_parent_cancellation_propagates_to_active_delegate(tmp_path) -> None:
    entered = Event()

    class CooperativeExecutor:
        def execute(
            self,
            request,
            profile: RoleProfile,
            control: DelegateControl,
        ) -> DelegateResult:
            entered.set()
            while not control.cancelled:
                control.wait(timeout=0.01)
            control.raise_if_cancelled()
            raise AssertionError("unreachable")

    journal = SqliteEventJournal(str(tmp_path / "events.sqlite"))
    manager = DelegateCoordinator(
        CooperativeExecutor(),
        journal,
        BudgetLedger(BudgetLimits(100_000, 100_000, 100, 50.0, 3600.0)),
    )
    request = manager.make_request("run-1", AgentRole.RESEARCHER, "Research")
    results: list[DelegateResult] = []
    worker = Thread(target=lambda: results.append(manager.execute(request)))
    worker.start()
    assert entered.wait(timeout=5)

    assert manager.cancel_parent("run-1") == 1
    worker.join(timeout=5)

    assert not worker.is_alive()
    assert results[0].status is DelegateStatus.CANCELLED
    assert manager.cancel_parent("run-1") == 0


def test_concurrent_delegate_reservations_prevent_parent_budget_oversubscription(
    tmp_path,
) -> None:
    entered = Event()
    release = Event()

    class BlockingExecutor:
        def execute(
            self,
            request,
            profile: RoleProfile,
            control: DelegateControl,
        ) -> DelegateResult:
            entered.set()
            assert release.wait(timeout=5)
            return DelegateResult(
                request.delegate_id,
                DelegateStatus.SUCCEEDED,
                "done",
                usage=BudgetUsage(input_tokens=1),
            )

    role_budget = BudgetLimits(100, 100, 2, 1.0, 10.0)
    manager = DelegateCoordinator(
        BlockingExecutor(),
        SqliteEventJournal(str(tmp_path / "events.sqlite")),
        BudgetLedger(role_budget),
    )
    first = manager.make_request("run-1", AgentRole.RESEARCHER, "First", budget=role_budget)
    second = manager.make_request("run-1", AgentRole.RESEARCHER, "Second", budget=role_budget)
    first_results: list[DelegateResult] = []
    worker = Thread(target=lambda: first_results.append(manager.execute(first)))
    worker.start()
    assert entered.wait(timeout=5)

    assert manager.execute(second).status is DelegateStatus.BUDGET_EXCEEDED
    release.set()
    worker.join(timeout=5)
    assert first_results[0].status is DelegateStatus.SUCCEEDED
