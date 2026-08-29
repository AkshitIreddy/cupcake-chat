from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .legacy import LegacyImporter
from .models import MigrationReport
from .product_sink import ProductMigrationSink

LegacyMigrationStateName = Literal[
    "not_found",
    "available",
    "previewed",
    "declined",
    "imported",
    "no_data",
]


@dataclass(frozen=True, slots=True)
class LegacyMigrationState:
    state: LegacyMigrationStateName
    available: bool
    source_fingerprint: str | None = None
    report: MigrationReport | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "available": self.available,
            "source_fingerprint": self.source_fingerprint,
            "report": self.report.to_dict() if self.report else None,
        }


class LegacyMigrationService:
    """First-run detect/preview/execute/decline workflow.

    Only a broker-selected local root is accepted.  The service exposes counts,
    warnings, ignored credential *names*, and state; preview never returns the
    imported record payloads to the desktop layer.
    """

    def __init__(self, legacy_root: str | Path, sink: ProductMigrationSink) -> None:
        self.legacy_root = Path(legacy_root)
        self.sink = sink

    def detect(self) -> LegacyMigrationState:
        importer = self._importer()
        if importer is None:
            return LegacyMigrationState("not_found", False)
        report, _ = importer.import_once(dry_run=True)
        persisted = self.sink.migration_for_fingerprint(report.source_fingerprint)
        if persisted is not None:
            state: LegacyMigrationStateName = (
                "no_data" if persisted.status == "no_data" else "imported"
            )
            return LegacyMigrationState(state, True, report.source_fingerprint, report)
        decision = self.sink.decision_for(report.source_fingerprint)
        if decision is not None:
            return LegacyMigrationState(decision.state, True, report.source_fingerprint, report)
        return LegacyMigrationState("available", True, report.source_fingerprint, report)

    def preview(self) -> LegacyMigrationState:
        importer = self._require_importer()
        report, _ = importer.import_once(dry_run=True)
        persisted = self.sink.migration_for_fingerprint(report.source_fingerprint)
        if persisted is not None:
            state: LegacyMigrationStateName = (
                "no_data" if persisted.status == "no_data" else "imported"
            )
            return LegacyMigrationState(state, True, report.source_fingerprint, report)
        self.sink.record_decision("previewed", report)
        return LegacyMigrationState("previewed", True, report.source_fingerprint, report)

    def execute(self) -> LegacyMigrationState:
        importer = self._require_importer()
        report, _ = importer.import_once()
        if report.status == "already_imported":
            persisted = self.sink.migration_for_fingerprint(report.source_fingerprint)
            state: LegacyMigrationStateName = (
                "no_data" if persisted and persisted.status == "no_data" else "imported"
            )
        else:
            state = "no_data" if report.status == "no_data" else "imported"
        return LegacyMigrationState(state, True, report.source_fingerprint, report)

    def decline(self) -> LegacyMigrationState:
        importer = self._require_importer()
        report, _ = importer.import_once(dry_run=True)
        persisted = self.sink.migration_for_fingerprint(report.source_fingerprint)
        if persisted is not None:
            state: LegacyMigrationStateName = (
                "no_data" if persisted.status == "no_data" else "imported"
            )
            return LegacyMigrationState(state, True, report.source_fingerprint, report)
        self.sink.record_decision("declined", report)
        return LegacyMigrationState("declined", True, report.source_fingerprint, report)

    def _require_importer(self) -> LegacyImporter:
        importer = self._importer()
        if importer is None:
            raise FileNotFoundError("a safe CUPCAKEAGI 1.0 state directory was not found")
        return importer

    def _importer(self) -> LegacyImporter | None:
        root = self.legacy_root
        try:
            if not root.exists() or not root.is_dir() or root.is_symlink():
                return None
            state = root if root.name == "state_of_mind" else root / "state_of_mind"
            if not state.is_dir() or state.is_symlink():
                return None
            return LegacyImporter(root, self.sink)
        except (OSError, ValueError):
            return None
