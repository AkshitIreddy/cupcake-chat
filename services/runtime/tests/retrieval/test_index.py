from __future__ import annotations

import unittest

from cupcake_runtime.retrieval import (
    ContextBoundaryError,
    ContextInspector,
    ContextItem,
    DestinationKind,
    RetrievalPlanner,
    SearchDocument,
    SearchIndex,
)


class RetrievalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.index = SearchIndex()
        self.planner = RetrievalPlanner()

    def tearDown(self) -> None:
        self.index.close()

    def test_project_isolation_and_citations(self) -> None:
        self.index.upsert(
            SearchDocument(
                id="alpha-doc",
                project_id="alpha",
                source_kind="file",
                source_id="alpha.py",
                title="Alpha",
                content="The cupcake uses berry frosting.",
                locator={"path": "alpha.py", "line_start": 4, "line_end": 4},
            )
        )
        self.index.upsert(
            SearchDocument(
                id="beta-doc",
                project_id="beta",
                source_kind="file",
                source_id="beta.py",
                title="Beta",
                content="The private beta uses berry frosting.",
                locator={"path": "beta.py", "line_start": 99},
            )
        )
        plan = self.planner.plan(
            query="berry frosting", project_id="alpha", semantic_available=False
        )
        hits = self.index.search(plan)
        self.assertEqual([hit.document.id for hit in hits], ["alpha-doc"])
        self.assertEqual(hits[0].citation.locator["line_start"], 4)
        self.assertIn("berry frosting", hits[0].citation.excerpt)

    def test_context_inspector_rejects_cross_project_items(self) -> None:
        with self.assertRaises(ContextBoundaryError):
            ContextInspector().assemble(
                run_id="run",
                project_id="alpha",
                model_id="model",
                destination=DestinationKind.CLOUD,
                items=[ContextItem("file", "f", "Foreign", 10, "beta", DestinationKind.CLOUD)],
            )

        with self.assertRaises(ContextBoundaryError):
            ContextInspector().assemble(
                run_id="run",
                project_id="alpha",
                model_id="cloud-model",
                destination=DestinationKind.CLOUD,
                items=[
                    ContextItem("file", "local-only", "Private", 10, "alpha", DestinationKind.LOCAL)
                ],
            )

    def test_exact_source_resolution_is_deterministic_and_project_scoped(self) -> None:
        self.index.upsert_many(
            (
                SearchDocument(
                    id="alpha-2",
                    project_id="alpha",
                    source_kind="file",
                    source_id="attachment",
                    title="Alpha second",
                    content="second exact chunk",
                ),
                SearchDocument(
                    id="alpha-1",
                    project_id="alpha",
                    source_kind="file",
                    source_id="attachment",
                    title="Alpha first",
                    content="first exact chunk",
                ),
                SearchDocument(
                    id="beta-1",
                    project_id="beta",
                    source_kind="file",
                    source_id="attachment",
                    title="Private beta",
                    content="must never cross the boundary",
                ),
            )
        )

        documents = self.index.documents_for_sources(
            project_id="alpha", source_ids=("attachment",), max_documents=10
        )

        self.assertEqual([document.id for document in documents], ["alpha-1", "alpha-2"])
        self.assertNotIn("must never cross", " ".join(item.content for item in documents))


if __name__ == "__main__":
    unittest.main()
