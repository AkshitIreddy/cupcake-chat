from __future__ import annotations

import unittest
from datetime import UTC, datetime, timedelta

from cupcake_runtime.memory import (
    Evidence,
    MemoryKind,
    MemoryQuery,
    MemoryScope,
    MemoryState,
    MemoryStore,
    ScopeKind,
    SuggestionKind,
)


class MemoryStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = MemoryStore()

    def tearDown(self) -> None:
        self.store.close()

    def test_project_isolation_is_a_hard_boundary(self) -> None:
        alpha = MemoryScope(ScopeKind.PROJECT, project_id="alpha")
        beta = MemoryScope(ScopeKind.PROJECT, project_id="beta")
        self.store.remember(key="secret", content="alpha only", kind=MemoryKind.FACT, scope=alpha)
        self.store.remember(key="secret", content="beta only", kind=MemoryKind.FACT, scope=beta)

        unscoped = self.store.query(MemoryQuery(text="only"))
        alpha_results = self.store.query(MemoryQuery(text="only", project_id="alpha"))

        self.assertEqual(unscoped, [])
        self.assertEqual([item.content for item in alpha_results], ["alpha only"])

    def test_forget_writes_tombstone_and_prevents_active_query(self) -> None:
        scope = MemoryScope(ScopeKind.PROJECT, project_id="alpha")
        original = self.store.remember(
            key="color",
            content="berry",
            kind=MemoryKind.PREFERENCE,
            scope=scope,
            evidence=[Evidence("message", "message-1", "I like berry", {"turn": 1})],
        )
        tombstone = self.store.forget(key="color", scope=scope, reason="user request")

        self.assertEqual(self.store.query(MemoryQuery(project_id="alpha")), [])
        self.assertEqual(
            self.store.get(original.id, include_forgotten=True).state, MemoryState.FORGOTTEN
        )
        self.assertEqual(tombstone.state, MemoryState.FORGOTTEN)
        self.assertTrue(tombstone.metadata["tombstone"])
        with self.assertRaises(KeyError):
            self.store.get(original.id)

    def test_candidate_activation_supersedes_and_records_conflict(self) -> None:
        scope = MemoryScope(ScopeKind.GLOBAL)
        original = self.store.remember(
            key="tone", content="quiet", kind=MemoryKind.PREFERENCE, scope=scope
        )
        candidate = self.store.propose(
            key="tone",
            content="playful",
            kind=MemoryKind.PREFERENCE,
            scope=scope,
            sensitive=True,
        )
        self.assertEqual(candidate.state, MemoryState.CANDIDATE)
        activated = self.store.activate(candidate.id)
        self.assertEqual(activated.state, MemoryState.ACTIVE)
        self.assertIn(original.id, activated.conflict_ids)
        self.assertEqual(self.store.get(original.id).state, MemoryState.SUPERSEDED)

    def test_expiry_usage_and_opt_in_suggestions(self) -> None:
        scope = MemoryScope(ScopeKind.GLOBAL)
        active = self.store.remember(
            key="temporary",
            content="short lived",
            kind=MemoryKind.TEMPORARY_CONTEXT,
            scope=scope,
            expires_at=datetime.now(UTC) + timedelta(seconds=5),
        )
        self.store.record_usage(active.id, "run-1", "helpful")
        self.assertEqual(self.store.usage_for(active.id)[0].outcome, "helpful")
        self.store.expire_due(at=datetime.now(UTC) + timedelta(minutes=1))
        self.assertEqual(self.store.get(active.id).state, MemoryState.EXPIRED)

        self.assertIsNone(
            self.store.create_suggestion(
                kind=SuggestionKind.THOUGHT, title="Notice", content="A pattern", scope=scope
            )
        )
        self.store.set_suggestions_enabled(True)
        suggestion = self.store.create_suggestion(
            kind=SuggestionKind.DREAM,
            title="Consolidate",
            content="Merge related facts",
            scope=scope,
        )
        self.assertIsNotNone(suggestion)
        assert suggestion is not None
        self.assertEqual(self.store.list_suggestions()[0].id, suggestion.id)
        dismissed = self.store.dismiss_suggestion(suggestion.id)
        self.assertIsNotNone(dismissed.dismissed_at)
        self.assertEqual(self.store.list_suggestions(), [])


if __name__ == "__main__":
    unittest.main()
