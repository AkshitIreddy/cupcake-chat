from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest

from cupcake_runtime.events import (
    EventConflictError,
    EventKind,
    RunEvent,
    SqliteEventJournal,
    deterministic_event_id,
)


def event(run_id: str, sequence: int, key: str, payload: dict[str, object]) -> RunEvent:
    return RunEvent(
        event_id=deterministic_event_id(run_id, key),
        run_id=run_id,
        sequence=sequence,
        kind=EventKind.RUN_STATUS,
        payload=payload,
    )


def test_journal_is_ordered_and_semantically_idempotent(tmp_path) -> None:
    journal = SqliteEventJournal(str(tmp_path / "events.sqlite"))
    first = event("run-1", 1, "one", {"status": "queued"})
    second = event("run-1", 2, "two", {"status": "running"})

    assert journal.append_many([first, second]) == 2
    replayed_later = RunEvent(
        event_id=first.event_id,
        run_id=first.run_id,
        sequence=99,
        kind=first.kind,
        payload=first.payload,
        created_at=first.created_at + timedelta(days=1),
    )
    assert journal.append(replayed_later) is False
    assert [item.sequence for item in journal.read("run-1")] == [1, 2]
    assert journal.next_sequence("run-1") == 3

    replayed = journal.append_next(replayed_later)
    assert replayed.sequence == 1
    assert journal.next_sequence("run-1") == 3


def test_journal_rejects_id_and_sequence_conflicts(tmp_path) -> None:
    journal = SqliteEventJournal(str(tmp_path / "events.sqlite"))
    original = event("run-1", 1, "same", {"value": 1})
    journal.append(original)

    with pytest.raises(EventConflictError):
        journal.append(event("run-1", 2, "same", {"value": 2}))
    with pytest.raises(EventConflictError):
        journal.append(event("run-1", 1, "different", {"value": 1}))


def test_append_many_is_transactional(tmp_path) -> None:
    journal = SqliteEventJournal(str(tmp_path / "events.sqlite"))
    with pytest.raises(EventConflictError):
        journal.append_many(
            [
                event("run-1", 1, "one", {"value": 1}),
                event("run-1", 1, "two", {"value": 2}),
            ]
        )
    assert journal.read("run-1") == []


def test_append_next_allocates_unique_sequences_concurrently(tmp_path) -> None:
    journal = SqliteEventJournal(str(tmp_path / "events.sqlite"))

    def append(index: int) -> None:
        journal.append_next(event("run-1", 0, f"event-{index}", {"index": index}))

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(append, range(40)))

    recorded = journal.read("run-1")
    assert [item.sequence for item in recorded] == list(range(1, 41))
    assert {item.payload["index"] for item in recorded} == set(range(40))
