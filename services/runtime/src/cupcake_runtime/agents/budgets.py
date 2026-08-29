"""Thread-safe, task-wide budget accounting."""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from threading import RLock

from .models import BudgetLimits, BudgetUsage


class BudgetExceededError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class BudgetSnapshot:
    limits: BudgetLimits
    usage: BudgetUsage


class BudgetLedger:
    """Atomically accounts all delegates against a shared parent-task budget."""

    def __init__(self, limits: BudgetLimits) -> None:
        self._limits = limits
        self._usage = BudgetUsage()
        self._reservations: dict[str, BudgetLimits] = {}
        self._lock = RLock()

    @property
    def snapshot(self) -> BudgetSnapshot:
        with self._lock:
            return BudgetSnapshot(self._limits, self._usage)

    @staticmethod
    def _limits_as_usage(limits: BudgetLimits) -> BudgetUsage:
        return BudgetUsage(
            input_tokens=limits.max_input_tokens,
            output_tokens=limits.max_output_tokens,
            tool_calls=limits.max_tool_calls,
            cost_usd=limits.max_cost_usd,
            duration_seconds=limits.max_duration_seconds,
        )

    def _reserved_usage(self) -> BudgetUsage:
        total = BudgetUsage()
        for limits in self._reservations.values():
            total += self._limits_as_usage(limits)
        return total

    def _assert_within_limits(self, usage: BudgetUsage) -> None:
        if usage.input_tokens > self._limits.max_input_tokens:
            raise BudgetExceededError("input token budget unavailable")
        if usage.output_tokens > self._limits.max_output_tokens:
            raise BudgetExceededError("output token budget unavailable")
        if usage.tool_calls > self._limits.max_tool_calls:
            raise BudgetExceededError("tool-call budget unavailable")
        if usage.cost_usd > self._limits.max_cost_usd + 1e-12:
            raise BudgetExceededError("cost budget unavailable")
        if usage.duration_seconds > self._limits.max_duration_seconds:
            raise BudgetExceededError("duration budget unavailable")

    def ensure_available(self, requested: BudgetLimits) -> None:
        with self._lock:
            candidate = self._usage + self._reserved_usage() + self._limits_as_usage(requested)
            self._assert_within_limits(candidate)

    def reserve(self, requested: BudgetLimits) -> str:
        with self._lock:
            self.ensure_available(requested)
            reservation_id = f"budget_{secrets.token_hex(16)}"
            self._reservations[reservation_id] = requested
            return reservation_id

    def release(self, reservation_id: str) -> None:
        with self._lock:
            if self._reservations.pop(reservation_id, None) is None:
                raise KeyError(reservation_id)

    def settle(self, reservation_id: str, usage: BudgetUsage) -> BudgetSnapshot:
        with self._lock:
            if self._reservations.pop(reservation_id, None) is None:
                raise KeyError(reservation_id)
            return self.consume(usage)

    def consume(self, usage: BudgetUsage) -> BudgetSnapshot:
        with self._lock:
            candidate = self._usage + usage
            self._usage = candidate
            self._assert_within_limits(candidate)
            return BudgetSnapshot(self._limits, self._usage)
