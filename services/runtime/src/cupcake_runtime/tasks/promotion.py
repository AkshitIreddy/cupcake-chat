"""Policy for turning foreground chats into durable background work."""

from __future__ import annotations

from dataclasses import dataclass

from .models import RunMode, TaskSpec, WorkKind

BACKGROUND_WORK_KINDS = frozenset(
    {
        WorkKind.REPOSITORY_INDEX,
        WorkKind.DOCUMENT_INDEX,
        WorkKind.CODE_EXECUTION,
        WorkKind.ARTIFACT_GENERATION,
    }
)


@dataclass(frozen=True, slots=True)
class PromotionDecision:
    mode: RunMode
    reasons: tuple[str, ...]

    @property
    def promoted(self) -> bool:
        return self.mode is RunMode.BACKGROUND


@dataclass(frozen=True, slots=True)
class TaskPromotionPolicy:
    duration_threshold_seconds: float = 20.0
    dependent_tool_stage_threshold: int = 2

    def decide(self, spec: TaskSpec) -> PromotionDecision:
        reasons: list[str] = []
        if spec.explicitly_background:
            reasons.append("explicit_request")
        if spec.work_kind in BACKGROUND_WORK_KINDS:
            reasons.append(spec.work_kind.value)
        if (
            spec.estimated_seconds is not None
            and spec.estimated_seconds > self.duration_threshold_seconds
        ):
            reasons.append("estimated_duration")
        if len(spec.steps) >= self.dependent_tool_stage_threshold:
            reasons.append("multiple_dependent_tool_stages")
        return PromotionDecision(
            RunMode.BACKGROUND if reasons else RunMode.INTERACTIVE,
            tuple(dict.fromkeys(reasons)),
        )
