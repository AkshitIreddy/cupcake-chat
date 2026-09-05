from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .coordinator import DurableTaskCoordinator, RecoveryResult
from .durability import (
    CheckpointConflictError,
    DbosCompatibleDurabilityAdapter,
    DeterministicCheckpointAdapter,
    DurabilityStore,
    SqliteDurabilityStore,
)
from .executors import DeterministicFakeExecutor, StepContext, StepExecutor
from .models import (
    ApprovalRecord,
    ApprovalStatus,
    CommandKind,
    ControlCommand,
    IncompatibleRuntimeError,
    InvalidTransitionError,
    RevisionCompatibility,
    RunMode,
    RunRecord,
    RunStatus,
    RuntimeRevision,
    TaskSpec,
    TaskStep,
    WorkKind,
    new_product_id,
)
from .promotion import PromotionDecision, TaskPromotionPolicy

if TYPE_CHECKING:
    from .dbos_runtime import (
        DbosRunHandle,
        DbosRunStatus,
        DbosRuntimeConflictError,
        DbosTaskRuntime,
        DbosUnavailableError,
        create_production_dbos_runtime,
    )

_DBOS_EXPORTS = {
    "DbosRunHandle",
    "DbosRunStatus",
    "DbosRuntimeConflictError",
    "DbosTaskRuntime",
    "DbosUnavailableError",
    "create_production_dbos_runtime",
}

__all__ = [
    "ApprovalRecord",
    "ApprovalStatus",
    "CheckpointConflictError",
    "CommandKind",
    "ControlCommand",
    "DbosCompatibleDurabilityAdapter",
    "DbosRunHandle",
    "DbosRunStatus",
    "DbosRuntimeConflictError",
    "DbosTaskRuntime",
    "DbosUnavailableError",
    "DeterministicCheckpointAdapter",
    "DeterministicFakeExecutor",
    "DurabilityStore",
    "DurableTaskCoordinator",
    "IncompatibleRuntimeError",
    "InvalidTransitionError",
    "PromotionDecision",
    "RecoveryResult",
    "RevisionCompatibility",
    "RunMode",
    "RunRecord",
    "RunStatus",
    "RuntimeRevision",
    "SqliteDurabilityStore",
    "StepContext",
    "StepExecutor",
    "TaskPromotionPolicy",
    "TaskSpec",
    "TaskStep",
    "WorkKind",
    "create_production_dbos_runtime",
    "new_product_id",
]


def __getattr__(name: str) -> Any:
    """Load the optional production executor only when a task needs it."""

    if name in _DBOS_EXPORTS:
        from . import dbos_runtime

        return getattr(dbos_runtime, name)
    raise AttributeError(name)
