"""Production DBOS runtime for durable CUPCAKEAGI task execution.

DBOS owns workflow recovery and checkpoints every product task step.  The
product durability store remains authoritative for user-visible task state,
approvals, control commands, and stable product identifiers.
"""

from __future__ import annotations

import importlib.metadata
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from typing import Any, Protocol, cast

from .coordinator import DurableTaskCoordinator
from .models import ApprovalStatus, RunRecord, RunStatus

DBOS_PACKAGE_VERSION = "2.31.0"
DBOS_APPLICATION_NAME = "cupcakeagi-runtime"


class DbosUnavailableError(RuntimeError):
    """Raised when the packaged DBOS runtime is absent or has the wrong version."""


class DbosRuntimeConflictError(RuntimeError):
    """Raised when two DBOS runtimes attempt to own the process singleton."""


class _WorkflowHandle(Protocol):
    workflow_id: str

    def get_result(self, *, polling_interval_sec: float = 1.0) -> Any: ...
    def get_status(self) -> Any: ...


@dataclass(frozen=True, slots=True)
class DbosRunHandle:
    """Product-owned identity returned after an idempotent workflow start."""

    workflow_id: str
    run_id: str
    task_id: str


@dataclass(frozen=True, slots=True)
class DbosRunStatus:
    workflow_id: str
    status: str
    application_version: str | None
    recovery_attempts: int | None
    error: str | None


@dataclass(slots=True)
class _RuntimeBinding:
    coordinator: DurableTaskCoordinator

    def task_shape(self, run_id: str) -> list[dict[str, object]]:
        run = self.coordinator.store.get_run(run_id)
        return [
            {
                "key": step.key,
                "requires_approval": step.requires_approval,
            }
            for step in run.spec.steps
        ]

    def prepare_approval(self, run_id: str, step_index: int) -> dict[str, object] | None:
        approval = self.coordinator.prepare_step_approval(run_id, step_index)
        if approval is None:
            return None
        run = self.coordinator.store.get_run(run_id)
        return {
            "approval_id": approval.approval_id,
            "intent_digest": approval.intent_digest,
            "status": approval.status.value,
            "run_id": run.run_id,
            "task_id": run.task_id,
            "current_step": run.current_step,
        }

    def execute_step(
        self,
        run_id: str,
        step_index: int,
        expected_step_key: str,
    ) -> dict[str, object]:
        run = self.coordinator.store.get_run(run_id)
        if not 0 <= step_index < len(run.spec.steps):
            raise IndexError(step_index)
        if run.spec.steps[step_index].key != expected_step_key:
            raise RuntimeError("persisted task shape changed during workflow recovery")
        updated = self.coordinator.run_single_step(
            run_id,
            step_index,
            approval_prechecked=True,
        )
        return _run_result(updated)


def _run_result(run: RunRecord) -> dict[str, object]:
    return {
        "run_id": run.run_id,
        "task_id": run.task_id,
        "status": run.status.value,
        "current_step": run.current_step,
        "error": run.error,
    }


_bindings: dict[str, _RuntimeBinding] = {}
_bindings_lock = RLock()
_registered = False
_registered_workflow: Any = None


def _binding(binding_key: str) -> _RuntimeBinding:
    with _bindings_lock:
        try:
            return _bindings[binding_key]
        except KeyError as exc:
            raise RuntimeError(f"DBOS task binding is unavailable: {binding_key}") from exc


def _register_workflows(dbos: Any) -> Any:
    """Register stable DBOS function names before the runtime is launched."""

    global _registered, _registered_workflow
    if _registered:
        return _registered_workflow

    @dbos.step(name="cupcake.task.prepare-approval", retries_allowed=False)
    def prepare_approval(
        binding_key: str, run_id: str, step_index: int
    ) -> dict[str, object] | None:
        return _binding(binding_key).prepare_approval(run_id, step_index)

    @dbos.step(name="cupcake.task.execute-step", retries_allowed=False)
    def execute_step(
        binding_key: str,
        run_id: str,
        step_index: int,
        expected_step_key: str,
    ) -> dict[str, object]:
        return _binding(binding_key).execute_step(run_id, step_index, expected_step_key)

    @dbos.workflow(name="cupcake.task.workflow", max_recovery_attempts=100)
    def task_workflow(
        binding_key: str,
        run_id: str,
        task_shape: Sequence[Mapping[str, object]],
    ) -> dict[str, object]:
        result: dict[str, object] = {
            "run_id": run_id,
            "status": RunStatus.QUEUED.value,
            "current_step": 0,
        }
        for step_index, step in enumerate(task_shape):
            step_key = step.get("key")
            if not isinstance(step_key, str) or not step_key:
                raise RuntimeError("DBOS workflow received an invalid task shape")
            if step.get("requires_approval") is True:
                approval = prepare_approval(binding_key, run_id, step_index)
                if approval is None:
                    raise RuntimeError("approval-gated task step has no durable approval")
                if approval["status"] == ApprovalStatus.PENDING.value:
                    result = {
                        "run_id": run_id,
                        "task_id": approval["task_id"],
                        "status": RunStatus.WAITING_APPROVAL.value,
                        "current_step": approval["current_step"],
                        "approval_id": approval["approval_id"],
                    }
                    dbos.set_event("task-state", result)
                    return result
            result = execute_step(binding_key, run_id, step_index, step_key)
            dbos.set_event("task-state", result)
            if result["status"] in {
                RunStatus.CANCELLED.value,
                RunStatus.FAILED.value,
            }:
                return result
        return result

    _registered_workflow = task_workflow
    _registered = True
    return task_workflow


def _load_dbos() -> tuple[Any, Any, Any]:
    try:
        from dbos import DBOS, DBOSConfig, SetWorkflowID
    except (ImportError, importlib.metadata.PackageNotFoundError) as exc:
        raise DbosUnavailableError(
            "DBOS is required for packaged durable tasks; install the durability extra"
        ) from exc
    try:
        installed = importlib.metadata.version("dbos")
    except importlib.metadata.PackageNotFoundError as exc:
        # PyInstaller bundles the importable package but does not automatically
        # preserve every dist-info directory. The frozen executable is built
        # from the locked environment, so retain the same pinned version when
        # metadata is unavailable; development environments still fail closed.
        if not getattr(sys, "frozen", False):
            raise DbosUnavailableError(
                "DBOS package metadata is missing; install the durability extra"
            ) from exc
        installed = DBOS_PACKAGE_VERSION
    if installed != DBOS_PACKAGE_VERSION:
        raise DbosUnavailableError(
            f"CUPCAKEAGI requires DBOS {DBOS_PACKAGE_VERSION}, found {installed}"
        )
    return DBOS, DBOSConfig, SetWorkflowID


def _sqlite_url(path: Path) -> str:
    # SQLAlchemy accepts forward slashes for absolute Windows paths.
    return f"sqlite:///{path.resolve().as_posix()}"


class DbosTaskRuntime:
    """Own the DBOS singleton and bridge product task controls to workflows."""

    def __init__(
        self,
        coordinator: DurableTaskCoordinator,
        *,
        binding_key: str,
        application_version: str,
        dbos: Any,
        set_workflow_id: Any,
        workflow: Any,
    ) -> None:
        self.coordinator = coordinator
        self.binding_key = binding_key
        self.application_version = application_version
        self._dbos = dbos
        self._set_workflow_id = set_workflow_id
        self._workflow = workflow
        self._closed = False
        self._latest_workflows: dict[str, str] = {}

    @staticmethod
    def workflow_id_for(run_id: str) -> str:
        """Use the non-empty stable product run ID as DBOS's idempotency key."""

        value = run_id.strip()
        if not value:
            raise ValueError("run_id cannot be empty")
        return value

    def start(self, run_id: str) -> DbosRunHandle:
        self._ensure_open()
        run = self.coordinator.store.get_run(run_id)
        workflow_id = self.workflow_id_for(run.run_id)
        return self._start_with_workflow_id(run, workflow_id)

    def _start_with_workflow_id(self, run: RunRecord, workflow_id: str) -> DbosRunHandle:
        shape = _binding(self.binding_key).task_shape(run.run_id)
        with self._set_workflow_id(workflow_id):
            handle = cast(
                _WorkflowHandle,
                self._dbos.start_workflow(
                    self._workflow,
                    self.binding_key,
                    run.run_id,
                    shape,
                ),
            )
        self._latest_workflows[run.run_id] = workflow_id
        return DbosRunHandle(handle.workflow_id, run.run_id, run.task_id)

    def _latest_workflow_id(self, run_id: str) -> str:
        known = self._latest_workflows.get(run_id)
        if known is not None:
            return known
        statuses = self._dbos.list_workflows(
            workflow_id_prefix=run_id,
            sort_desc=True,
            limit=1,
            load_input=False,
            load_output=False,
        )
        workflow_id = statuses[0].workflow_id if statuses else self.workflow_id_for(run_id)
        self._latest_workflows[run_id] = workflow_id
        return workflow_id

    def get_status(self, run_id: str) -> DbosRunStatus | None:
        self._ensure_open()
        workflow_id = self._latest_workflow_id(run_id)
        status = self._dbos.get_workflow_status(workflow_id)
        if status is None:
            return None
        raw_status = status.status
        value = raw_status.value if hasattr(raw_status, "value") else str(raw_status)
        error = str(status.error) if status.error is not None else None
        return DbosRunStatus(
            workflow_id=workflow_id,
            status=value,
            application_version=status.app_version,
            recovery_attempts=status.recovery_attempts,
            error=error,
        )

    def wait(self, run_id: str, *, polling_interval_seconds: float = 0.1) -> Mapping[str, Any]:
        self._ensure_open()
        handle = cast(
            _WorkflowHandle,
            self._dbos.retrieve_workflow(self._latest_workflow_id(run_id)),
        )
        result = handle.get_result(polling_interval_sec=polling_interval_seconds)
        if not isinstance(result, Mapping):
            raise RuntimeError("DBOS task workflow returned a non-object result")
        return result

    def cancel(self, run_id: str, *, reason: str = "user_requested") -> RunRecord:
        self._ensure_open()
        run = self.coordinator.request_cancel(run_id, reason=reason)
        workflow_id = self._latest_workflow_id(run_id)
        status = self._dbos.get_workflow_status(workflow_id)
        raw_status = status.status if status is not None else None
        status_value = str(getattr(raw_status, "value", raw_status))
        if status_value in {"PENDING", "ENQUEUED", "DELAYED"}:
            self._dbos.cancel_workflow(workflow_id, cancel_children=True)
        return run

    def resolve_approval(
        self,
        approval_id: str,
        *,
        approved: bool,
        response: Mapping[str, Any] | None = None,
    ) -> RunRecord:
        self._ensure_open()
        run = self.coordinator.resolve_approval(
            approval_id,
            approved=approved,
            response=response,
        )
        if approved and not run.status.terminal:
            continuation_id = f"{self.workflow_id_for(run.run_id)}:approval:{approval_id}"
            self._start_with_workflow_id(run, continuation_id)
        return run

    def resume(self, run_id: str) -> DbosRunHandle:
        self._ensure_open()
        run = self.coordinator.store.get_run(run_id)
        handle = cast(
            _WorkflowHandle,
            self._dbos.resume_workflow(self._latest_workflow_id(run_id)),
        )
        return DbosRunHandle(handle.workflow_id, run.run_id, run.task_id)

    def shutdown(self, *, completion_timeout_seconds: int = 5) -> None:
        if self._closed:
            return
        self._dbos.destroy(workflow_completion_timeout_sec=completion_timeout_seconds)
        with _bindings_lock:
            _bindings.pop(self.binding_key, None)
        self._closed = True

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("DBOS task runtime is closed")


def create_production_dbos_runtime(
    coordinator: DurableTaskCoordinator,
    *,
    system_database_path: str | Path,
    binding_key: str = "cupcake-desktop",
    application_version: str | None = None,
    executor_id: str = "cupcake-local-sidecar",
) -> DbosTaskRuntime:
    """Configure and launch the packaged single-user DBOS runtime.

    ``system_database_path`` must be distinct from the authoritative product
    database.  Launch performs DBOS migrations and automatically recovers
    interrupted PENDING workflows assigned to this stable local executor.
    """

    if not binding_key.strip():
        raise ValueError("binding_key cannot be empty")
    database_path = Path(system_database_path)
    database_path.parent.mkdir(parents=True, exist_ok=True)
    dbos, dbos_config, set_workflow_id = _load_dbos()
    workflow = _register_workflows(dbos)
    with _bindings_lock:
        if binding_key in _bindings:
            raise DbosRuntimeConflictError(f"DBOS binding already exists: {binding_key}")
        if _bindings:
            raise DbosRuntimeConflictError("only one production DBOS runtime may own a process")
        _bindings[binding_key] = _RuntimeBinding(coordinator)

    version = application_version or f"runtime-{coordinator.runtime_revision.major}"
    config: Any = dbos_config(
        name=DBOS_APPLICATION_NAME,
        application_version=version,
        executor_id=executor_id,
        system_database_url=_sqlite_url(database_path),
        use_listen_notify=False,
        run_migrations=True,
        run_admin_server=False,
        enable_otlp=False,
    )
    try:
        dbos(config=config)
        dbos.launch()
    except BaseException:
        with _bindings_lock:
            _bindings.pop(binding_key, None)
        raise
    return DbosTaskRuntime(
        coordinator,
        binding_key=binding_key,
        application_version=version,
        dbos=dbos,
        set_workflow_id=set_workflow_id,
        workflow=workflow,
    )
