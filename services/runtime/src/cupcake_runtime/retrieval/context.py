from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime

from .models import ContextInspectorRecord, ContextItem, DestinationKind


class ContextBoundaryError(ValueError):
    pass


class ContextInspector:
    """Builds the user-visible context ledger without private model reasoning."""

    def assemble(
        self,
        *,
        run_id: str,
        project_id: str | None,
        model_id: str,
        destination: DestinationKind,
        items: Iterable[ContextItem],
    ) -> ContextInspectorRecord:
        checked: list[ContextItem] = []
        for item in items:
            if item.token_count < 0:
                raise ValueError("context token counts cannot be negative")
            if item.project_id is not None and item.project_id != project_id:
                raise ContextBoundaryError(f"context item {item.id!r} belongs to another project")
            if item.destination is not destination:
                raise ContextBoundaryError(
                    f"context item {item.id!r} is designated for {item.destination}, "
                    f"not {destination}"
                )
            checked.append(item)
        return ContextInspectorRecord(
            run_id=run_id,
            project_id=project_id,
            model_id=model_id,
            destination=destination,
            items=tuple(checked),
            total_tokens=sum(item.token_count for item in checked),
            created_at=datetime.now(UTC),
        )
