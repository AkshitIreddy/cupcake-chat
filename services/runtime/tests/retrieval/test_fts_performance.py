from __future__ import annotations

import os
from pathlib import Path
from time import perf_counter

import pytest

from cupcake_runtime.retrieval import RetrievalPlanner, SearchDocument, SearchIndex

RECORD_COUNT = 100_000
P95_BUDGET_SECONDS = 0.250
RUNS = 60


@pytest.mark.performance
@pytest.mark.skipif(
    os.environ.get("CUPCAKE_RUN_PERF") != "1",
    reason="100k-record hardware benchmark is opt-in and excluded from normal CI",
)
def test_fts_search_p95_over_100k_records(tmp_path: Path) -> None:
    """Acceptance harness for the 250 ms p95 lexical-search product budget.

    Run on the reference Windows/NVMe machine with:
    `CUPCAKE_RUN_PERF=1 pytest tests/retrieval/test_fts_performance.py -s`.
    Dataset construction is deliberately outside the measured interval.
    """
    index = SearchIndex(tmp_path / "retrieval-benchmark.sqlite3")
    planner = RetrievalPlanner()
    batch_size = 2_000
    for start in range(0, RECORD_COUNT, batch_size):
        index.upsert_many(
            tuple(
                SearchDocument(
                    id=f"benchmark-{number}",
                    project_id="benchmark-project",
                    source_kind="file",
                    source_id=f"source-{number // 10}.md",
                    title=f"Cupcake benchmark record {number}",
                    content=(
                        f"lexical-token-{number % 200} retrieval benchmark record {number} "
                        f"project decision group-{number % 37}"
                    ),
                )
                for number in range(start, min(start + batch_size, RECORD_COUNT))
            )
        )

    plans = tuple(
        planner.plan(
            query=f"retrieval benchmark group-{number % 37}",
            project_id="benchmark-project",
            semantic_available=False,
            limit=20,
        )
        for number in range(RUNS)
    )
    for plan in plans[:5]:
        assert index.search(plan)

    durations: list[float] = []
    for plan in plans:
        started = perf_counter()
        hits = index.search(plan)
        durations.append(perf_counter() - started)
        assert hits

    ordered = sorted(durations)
    p95 = ordered[max(0, int(len(ordered) * 0.95) - 1)]
    print(
        f"FTS benchmark: records={RECORD_COUNT} runs={RUNS} "
        f"p95_ms={p95 * 1000:.2f} budget_ms={P95_BUDGET_SECONDS * 1000:.0f}"
    )
    index.close()
    assert p95 <= P95_BUDGET_SECONDS
