from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any


@dataclass(frozen=True, slots=True)
class LegacyRecord:
    record_id: str
    kind: str
    source: str
    payload: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class MigrationReport:
    migration_id: str
    source_fingerprint: str
    status: str
    counts: Mapping[str, int]
    warnings: tuple[str, ...] = ()
    ignored_secret_files: tuple[str, ...] = ()
    imported_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    @property
    def total_records(self) -> int:
        return sum(self.counts.values())

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["imported_at"] = self.imported_at.astimezone(UTC).isoformat().replace("+00:00", "Z")
        value["total_records"] = self.total_records
        message_count = int(self.counts.get("conversation_message", 0))
        value["conversations"] = int(message_count > 0)
        value["messages"] = message_count
        value["tasks"] = int(self.counts.get("task", 0))
        value["memories"] = sum(
            int(self.counts.get(kind, 0)) for kind in ("personality", "thought", "chroma_text")
        )
        value["files"] = 0
        return value
