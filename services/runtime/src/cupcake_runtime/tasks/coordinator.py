"""Restart-safe task coordinator and explicit lifecycle state machine."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from cupcake_runtime.events import (
    EventJournal,
    EventKind,
    RunEvent,
    deterministic_event_id,
)

from .durability import CheckpointConflictError, DeterministicCheckpointAdapter, DurabilityStore
from .executors import StepContext, StepExecutor
from .models import (
    ApprovalRecord,
    ApprovalStatus,
    CommandKind,
    ControlCommand,
    IncompatibleRuntimeError,
    RevisionCompatibility,
    RunRecord,
    RunStatus,
    RuntimeRevision,
    TaskSpec,
    TaskStep,
    new_product_id,
)
from .promotion import PromotionDecision, TaskPromotionPolicy


@dataclass(frozen=True, slots=True)
class RecoveryResult:
    run_id: str
    resumed: bool
    status: RunStatus
    error: str | None = None


class DurableTaskCoordinator:
    def __init__(
        self,
        store: DurabilityStore,
        journal: EventJournal,
        executor: StepExecutor,
        *,
        runtime_revision: RuntimeRevision | None = None,
        compatibility: RevisionCompatibility | None = None,
        promotion_policy: TaskPromotionPolicy | None = None,
    ) -> None:
        self.store = store
        self.journal = journal
        self.executor = executor
        self.runtime_revision = runtime_revision or RuntimeRevision(1, 0, 0)
        self.compatibility = compatibility or RevisionCompatibility(self.runtime_revision)
        self.promotion_policy = promotion_policy or TaskPromotionPolicy()
        self._checkpoint_adapter = DeterministicCheckpointAdapter(
            store,
            self.runtime_revision,
            self.compatibility,
        )

    def create(self, spec: TaskSpec) -> tuple[RunRecord, PromotionDecision]:
        decision = self.promotion_policy.decide(spec)
        now = datetime.now(UTC)
        run = RunRecord(
            run_id=new_product_id("run"),
            task_id=new_product_id("task"),
            spec=spec,
            mode=decision.mode,
            status=RunStatus.QUEUED,
            runtime_revision=self.runtime_revision,
            created_at=now,
            updated_at=now,
        )
        self.store.create_run(run)
        self._emit(run, EventKind.RUN_CREATED, "created", {"mode": run.mode.value})
        if decision.promoted:
            self._emit(
                run,
                EventKind.RUN_PROMOTED,
                "promoted",
                {"reasons": list(decision.reasons)},
            )
        return run, decision

    def run(self, run_id: str) -> RunRecord:
        return self._run_steps(run_id)

    def run_single_step(
        self,
        run_id: str,
        step_index: int,
        *,
        approval_prechecked: bool = False,
    ) -> RunRecord:
        """Execute one deterministic product step boundary.

        The DBOS production adapter calls this method from a ``@DBOS.step``.
        Ordinary in-process callers should continue to use :meth:`run`.
        """

        if step_index < 0:
            raise ValueError("step_index must be non-negative")
        return self._run_steps(
            run_id,
            expected_step=step_index,
            max_steps=1,
            approval_prechecked=approval_prechecked,
        )

    def prepare_external_step(self, run_id: str, step_index: int) -> tuple[RunRecord, str]:
        """Persist a broker-owned step boundary without executing it in Python.

        The returned digest binds the immutable task step to the eventual broker
        receipt. A recovered ``waiting_input`` run can safely recreate the same
        request, but is never executed automatically after a process restart.
        """

        run = self.store.get_run(run_id)
        self.compatibility.assert_can_resume(run.runtime_revision)
        if step_index < 0 or step_index >= len(run.spec.steps):
            raise IndexError(step_index)
        if run.current_step != step_index:
            raise RuntimeError(
                f"task step ordering changed: expected {run.current_step}, got {step_index}"
            )
        if run.status.terminal:
            return run, self.external_step_input_digest(run, step_index)
        if run.cancellation_requested or run.status is RunStatus.CANCELLING:
            return self._finish_cancellation(run), self.external_step_input_digest(run, step_index)
        if run.status is RunStatus.QUEUED:
            run = self._transition(run, RunStatus.RUNNING)
        if run.status is RunStatus.RUNNING:
            step = run.spec.steps[step_index]
            self._emit(
                run,
                EventKind.STEP_STARTED,
                f"step:{step.key}:external",
                {"step_key": step.key, "operation": step.operation, "owner": "tool_broker"},
            )
            run = self._transition(run, RunStatus.WAITING_INPUT)
        if run.status not in {RunStatus.WAITING_INPUT, RunStatus.WAITING_APPROVAL}:
            raise RuntimeError(f"task is not ready for broker execution: {run.status.value}")
        return run, self.external_step_input_digest(run, step_index)

    def complete_external_step(
        self,
        run_id: str,
        step_index: int,
        *,
        input_digest: str,
        output: Mapping[str, Any],
        outcome: str,
        error: str | None = None,
    ) -> RunRecord:
        """Checkpoint one broker result and apply its truthful terminal state."""

        run = self.store.get_run(run_id)
        self.compatibility.assert_can_resume(run.runtime_revision)
        if step_index < 0 or step_index >= len(run.spec.steps):
            raise IndexError(step_index)
        if run.current_step != step_index:
            existing = self.store.get_checkpoint(run_id, run.spec.steps[step_index].key)
            if existing is not None and existing["input_digest"] == input_digest:
                return run
            raise RuntimeError(
                f"task step ordering changed: expected {run.current_step}, got {step_index}"
            )
        if run.status.terminal:
            return run
        expected_digest = self.external_step_input_digest(run, step_index)
        if input_digest != expected_digest:
            raise CheckpointConflictError("broker result does not match the persisted task step")
        if run.cancellation_requested or run.status is RunStatus.CANCELLING:
            outcome = "cancelled"
        if outcome not in {
            "succeeded",
            "failed",
            "cancelled",
            "denied",
            "timed_out",
            "output_limit_exceeded",
        }:
            raise ValueError(f"unsupported external step outcome: {outcome}")

        step = run.spec.steps[step_index]
        self.store.save_checkpoint(
            run_id,
            step.key,
            input_digest,
            output,
            self.runtime_revision,
        )
        self._emit(
            run,
            EventKind.STEP_CHECKPOINTED,
            f"step:{step.key}:broker-checkpoint",
            {
                "step_key": step.key,
                "output_keys": sorted(str(key) for key in output),
                "outcome": outcome,
            },
        )
        run = self.store.get_run(run_id)
        if outcome == "cancelled":
            self.store.request_cancellation(run_id)
            return self._finish_cancellation(self.store.get_run(run_id))
        if outcome != "succeeded":
            message = error or f"broker tool finished with status {outcome}"
            return self._transition(run, RunStatus.FAILED, error=message)

        run = self._transition(run, RunStatus.RUNNING, current_step=step_index + 1)
        if run.current_step == len(run.spec.steps):
            return self._transition(run, RunStatus.SUCCEEDED)
        return run

    @classmethod
    def external_step_input_digest(cls, run: RunRecord, step_index: int) -> str:
        if step_index < 0 or step_index >= len(run.spec.steps):
            raise IndexError(step_index)
        step = run.spec.steps[step_index]
        return cls._step_input_digest(step.operation, step.arguments, [])

    def prepare_step_approval(self, run_id: str, step_index: int) -> ApprovalRecord | None:
        """Create or retrieve the stable approval seam for one product step."""

        run = self.store.get_run(run_id)
        if not 0 <= step_index < len(run.spec.steps):
            raise IndexError(step_index)
        if run.status is RunStatus.QUEUED:
            run = self._transition(run, RunStatus.RUNNING)
        step = run.spec.steps[step_index]
        return self._approval_gate(
            run,
            step.key,
            step.requires_approval,
            step.approval_intent_digest,
        )

    def _run_steps(
        self,
        run_id: str,
        *,
        expected_step: int | None = None,
        max_steps: int | None = None,
        approval_prechecked: bool = False,
    ) -> RunRecord:
        run = self.store.get_run(run_id)
        self.compatibility.assert_can_resume(run.runtime_revision)
        if run.status.terminal or run.status in {
            RunStatus.WAITING_APPROVAL,
            RunStatus.WAITING_INPUT,
            RunStatus.CANCELLING,
        }:
            return run
        if run.status is RunStatus.QUEUED:
            run = self._transition(run, RunStatus.RUNNING)

        if expected_step is not None:
            if run.current_step > expected_step:
                return run
            if run.current_step < expected_step:
                raise RuntimeError(
                    f"task step ordering changed: expected {run.current_step}, got {expected_step}"
                )

        steering = self._consume_steering(run)
        steps_executed = 0
        try:
            for index in range(run.current_step, len(run.spec.steps)):
                run = self.store.get_run(run_id)
                if run.cancellation_requested:
                    return self._finish_cancellation(run)
                steering.extend(self._consume_steering(run))
                step = run.spec.steps[index]
                approval = (
                    self.store.get_approval(run.run_id, step.key)
                    if approval_prechecked and step.requires_approval
                    else self._approval_gate(
                        run,
                        step.key,
                        step.requires_approval,
                        step.approval_intent_digest,
                    )
                )
                if approval is not None:
                    if approval.status is ApprovalStatus.PENDING:
                        return self.store.get_run(run_id)
                    if approval.status is ApprovalStatus.DENIED:
                        return self._finish_cancellation(self.store.get_run(run_id))

                context = StepContext(
                    run_id=run.run_id,
                    task_id=run.task_id,
                    project_id=run.spec.project_id,
                    steering=tuple(steering),
                )
                persisted_checkpoint = self.store.get_checkpoint(run.run_id, step.key)
                input_digest = (
                    str(persisted_checkpoint["input_digest"])
                    if persisted_checkpoint is not None
                    else self._step_input_digest(step.operation, step.arguments, steering)
                )
                self._emit(
                    run,
                    EventKind.STEP_STARTED,
                    f"step:{step.key}:started",
                    {"step_key": step.key, "operation": step.operation},
                )

                def operation(
                    idempotency_key: str,
                    bound_step: TaskStep = step,
                    bound_context: StepContext = context,
                ) -> Mapping[str, Any]:
                    return self.executor.execute(
                        bound_step,
                        bound_context,
                        idempotency_key=idempotency_key,
                    )

                output, reused = self._checkpoint_adapter.checkpointed_step(
                    run.run_id, step.key, input_digest, operation
                )
                self._emit(
                    run,
                    EventKind.STEP_REUSED if reused else EventKind.STEP_CHECKPOINTED,
                    f"step:{step.key}:checkpoint",
                    {
                        "step_key": step.key,
                        "output_keys": sorted(str(key) for key in output),
                    },
                )
                run = self.store.get_run(run_id)
                if run.cancellation_requested or run.status is RunStatus.CANCELLING:
                    return self._finish_cancellation(run)
                run = self._transition(run, RunStatus.RUNNING, current_step=index + 1)
                steps_executed += 1
                if max_steps is not None and steps_executed >= max_steps:
                    if run.current_step == len(run.spec.steps):
                        return self._transition(run, RunStatus.SUCCEEDED)
                    return run

            return self._transition(run, RunStatus.SUCCEEDED)
        except Exception as exc:
            run = self.store.get_run(run_id)
            if run.cancellation_requested or run.status is RunStatus.CANCELLING:
                return self._finish_cancellation(run)
            if not run.status.terminal:
                run = self._transition(run, RunStatus.FAILED, error=str(exc))
            self._emit(
                run,
                EventKind.ERROR,
                f"error:{run.current_step}:{type(exc).__name__}",
                {"error_type": type(exc).__name__, "message": str(exc)},
            )
            return run

    def request_cancel(self, run_id: str, *, reason: str = "user_requested") -> RunRecord:
        run = self.store.get_run(run_id)
        if run.status.terminal:
            return run
        self.store.enqueue_command(run_id, CommandKind.CANCEL, {"reason": reason})
        self.store.request_cancellation(run_id)
        run = self.store.get_run(run_id)
        if run.status is RunStatus.RUNNING:
            run = self._transition(run, RunStatus.CANCELLING)
        else:
            run = self._finish_cancellation(run)
        return run

    def steer(self, run_id: str, instruction: str) -> ControlCommand:
        if not instruction.strip():
            raise ValueError("steering instruction cannot be empty")
        run = self.store.get_run(run_id)
        if run.status.terminal:
            raise ValueError("cannot steer a terminal run")
        command = self.store.enqueue_command(
            run_id, CommandKind.STEER, {"instruction": instruction.strip()}
        )
        self._emit(
            run,
            EventKind.RUN_STEERED,
            f"steer:{command.command_id}",
            {"command_id": command.command_id},
        )
        if run.status is RunStatus.WAITING_INPUT:
            self._transition(run, RunStatus.QUEUED)
        return command

    def queue_followup(self, run_id: str, prompt: str) -> ControlCommand:
        if not prompt.strip():
            raise ValueError("follow-up prompt cannot be empty")
        run = self.store.get_run(run_id)
        command = self.store.enqueue_command(
            run_id, CommandKind.FOLLOWUP, {"prompt": prompt.strip()}
        )
        self._emit(
            run,
            EventKind.RUN_FOLLOWUP_QUEUED,
            f"followup:{command.command_id}",
            {"command_id": command.command_id},
        )
        return command

    def take_followups(self, run_id: str) -> list[str]:
        prompts: list[str] = []
        for command in self.store.pending_commands(run_id):
            if command.kind is CommandKind.FOLLOWUP:
                prompts.append(str(command.payload["prompt"]))
                self.store.mark_command_applied(command.command_id)
        return prompts

    def resolve_approval(
        self,
        approval_id: str,
        *,
        approved: bool,
        response: Mapping[str, Any] | None = None,
    ) -> RunRecord:
        approval = self.store.resolve_approval(
            approval_id,
            ApprovalStatus.APPROVED if approved else ApprovalStatus.DENIED,
            response,
        )
        run = self.store.get_run(approval.run_id)
        self._emit(
            run,
            EventKind.APPROVAL_RESOLVED,
            f"approval:{approval.approval_id}:resolved",
            {"approval_id": approval.approval_id, "status": approval.status.value},
        )
        if run.status is RunStatus.WAITING_APPROVAL:
            if approved:
                return self._transition(run, RunStatus.QUEUED)
            self.store.request_cancellation(run.run_id)
            return self._finish_cancellation(self.store.get_run(run.run_id))
        return run

    def recover(self, *, resume: bool = True) -> list[RecoveryResult]:
        results: list[RecoveryResult] = []
        for persisted in self.store.list_recoverable():
            try:
                self.compatibility.assert_can_resume(persisted.runtime_revision)
            except IncompatibleRuntimeError as exc:
                failed = self.store.transition(
                    persisted.run_id,
                    RunStatus.FAILED,
                    error=str(exc),
                    recovery=True,
                )
                self._emit(
                    failed,
                    EventKind.ERROR,
                    "recovery:incompatible",
                    {"error_type": type(exc).__name__, "message": str(exc)},
                )
                results.append(RecoveryResult(failed.run_id, False, failed.status, str(exc)))
                continue

            if persisted.cancellation_requested or persisted.status is RunStatus.CANCELLING:
                recovered = self.store.transition(
                    persisted.run_id, RunStatus.CANCELLED, recovery=True
                )
                self._emit(
                    recovered,
                    EventKind.RUN_RECOVERED,
                    "recovery:cancelled",
                    {"status": recovered.status.value},
                )
                results.append(RecoveryResult(recovered.run_id, False, recovered.status))
                continue

            if persisted.status in {RunStatus.WAITING_APPROVAL, RunStatus.WAITING_INPUT}:
                self._emit(
                    persisted,
                    EventKind.RUN_RECOVERED,
                    f"recovery:{persisted.status.value}",
                    {"status": persisted.status.value},
                )
                results.append(RecoveryResult(persisted.run_id, False, persisted.status))
                continue

            queued = self.store.transition(persisted.run_id, RunStatus.QUEUED, recovery=True)
            self._emit(
                queued,
                EventKind.RUN_RECOVERED,
                f"recovery:queued:{queued.current_step}",
                {"from": persisted.status.value, "current_step": queued.current_step},
            )
            recovered = self.run(queued.run_id) if resume else queued
            results.append(RecoveryResult(recovered.run_id, resume, recovered.status))
        return results

    def _consume_steering(self, run: RunRecord) -> list[str]:
        instructions: list[str] = []
        for command in self.store.pending_commands(run.run_id):
            if command.kind is CommandKind.STEER:
                instructions.append(str(command.payload["instruction"]))
                self.store.mark_command_applied(command.command_id)
            elif command.kind is CommandKind.CANCEL:
                self.store.mark_command_applied(command.command_id)
        return instructions

    def _approval_gate(
        self,
        run: RunRecord,
        step_key: str,
        required: bool,
        intent_digest: str | None,
    ) -> ApprovalRecord | None:
        if not required:
            return None
        assert intent_digest is not None
        approval = self.store.get_approval(run.run_id, step_key)
        if approval is None:
            approval = self.store.request_approval(run.run_id, step_key, intent_digest)
            self._transition(run, RunStatus.WAITING_APPROVAL)
            self._emit(
                run,
                EventKind.APPROVAL_REQUESTED,
                f"approval:{approval.approval_id}:requested",
                {
                    "approval_id": approval.approval_id,
                    "step_key": step_key,
                    "intent_digest": intent_digest,
                },
            )
        return approval

    def _finish_cancellation(self, run: RunRecord) -> RunRecord:
        if run.status is RunStatus.RUNNING:
            run = self._transition(run, RunStatus.CANCELLING)
        if run.status is RunStatus.CANCELLING:
            return self._transition(run, RunStatus.CANCELLED)
        if run.status in {
            RunStatus.QUEUED,
            RunStatus.WAITING_APPROVAL,
            RunStatus.WAITING_INPUT,
        }:
            return self._transition(run, RunStatus.CANCELLED)
        return run

    def _transition(
        self,
        run: RunRecord,
        status: RunStatus,
        *,
        current_step: int | None = None,
        error: str | None = None,
    ) -> RunRecord:
        updated = self.store.transition(run.run_id, status, current_step=current_step, error=error)
        self._emit(
            updated,
            EventKind.RUN_STATUS,
            f"status:{status.value}:{updated.current_step}",
            {
                "status": status.value,
                "current_step": updated.current_step,
                "error": error,
            },
        )
        return updated

    def _emit(
        self,
        run: RunRecord,
        kind: EventKind,
        dedupe_key: str,
        payload: Mapping[str, Any],
    ) -> None:
        event = RunEvent(
            event_id=deterministic_event_id(run.run_id, dedupe_key),
            run_id=run.run_id,
            task_id=run.task_id,
            parent_run_id=run.spec.parent_run_id,
            sequence=0,
            kind=kind,
            payload=dict(payload),
        )
        self.journal.append_next(event)

    @staticmethod
    def _step_input_digest(
        operation: str, arguments: Mapping[str, Any], steering: list[str]
    ) -> str:
        canonical = json.dumps(
            {"operation": operation, "arguments": arguments, "steering": steering},
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        return hashlib.sha256(canonical.encode()).hexdigest()
