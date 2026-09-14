from __future__ import annotations

from pathlib import Path

from cupcake_runtime.application import RuntimeService
from cupcake_runtime.domain.models import Setting
from cupcake_runtime.groups import GroupStore
from cupcake_runtime.groups.catalog import DEFAULT_PERSONA_CATALOG
from cupcake_runtime.storage.database import Database, DatabaseConfig
from cupcake_runtime.storage.repositories import ProductRepository


def _runtime(path: Path) -> RuntimeService:
    return RuntimeService(path, master_key=b"c" * 32, require_sqlcipher=False)


def test_fresh_profile_receives_broad_ordered_persona_catalog(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path)
    try:
        personas, _ = runtime.handle("personas.list", {})
        assert [item["handle"] for item in personas[:15]] == [
            "pip",
            "sage",
            "quill",
            "patch",
            "tally",
            "muse",
            "scout",
            "circuit",
            "pantry",
            "roam",
            "frame",
            "orbit",
            "ledger",
            "launch",
            "gather",
        ]
        assert len(personas) == len(DEFAULT_PERSONA_CATALOG) == 39
        history = [item for item in personas if item["avatar"].startswith("product:art/history/")]
        assert len(history) == 24
        assert len({item["avatar"] for item in history}) == 24
        for era in ("egyptian", "greek", "roman", "viking", "mongol", "medieval"):
            assert sum(item["handle"].startswith(era + "_") for item in history) == 4
        assert all(item["modelId"] == "mock:cupcake-deterministic" for item in personas)
        assert all("Stay quiet" in item["speakWhen"] for item in personas)
        assert all(len(item["instructions"]) >= 400 for item in personas)
        assert len({item["instructions"] for item in personas}) == len(personas)
    finally:
        runtime.close()


def test_existing_custom_persona_wins_handle_and_catalog_seed_is_idempotent(
    tmp_path: Path,
) -> None:
    database = Database(DatabaseConfig(path=tmp_path / "cupcake.db", require_sqlcipher=False))
    repository = ProductRepository(database)
    repository.set_setting(
        Setting(
            key="models.default",
            value="openai-compatible:groq/openai/gpt-oss-20b",
        )
    )
    custom = GroupStore(database).create_persona(
        name="My Pip",
        handle="pip",
        model_id="mock:cupcake-deterministic",
        instructions="Keep this custom profile exactly as I wrote it.",
    )
    database.close()

    first = _runtime(tmp_path)
    try:
        personas, _ = first.handle("personas.list", {})
        assert len(personas) == len(DEFAULT_PERSONA_CATALOG) + 1
        custom_after = next(item for item in personas if item["id"] == custom.id)
        assert custom_after["name"] == "My Pip"
        assert custom_after["handle"] == "pip"
        assert custom_after["instructions"] == "Keep this custom profile exactly as I wrote it."
        seeded_pip = first.database.connection.execute(
            "SELECT handle,model_id FROM personas WHERE catalog_key='everyday-planner'"
        ).fetchone()
        assert tuple(seeded_pip) == (
            "pip-helper",
            "openai-compatible:groq/openai/gpt-oss-20b",
        )
        before = first.database.connection.execute(
            "SELECT id,updated_at FROM personas WHERE catalog_key IS NOT NULL ORDER BY catalog_key"
        ).fetchall()
    finally:
        first.close()

    reopened = _runtime(tmp_path)
    try:
        after = reopened.database.connection.execute(
            "SELECT id,updated_at FROM personas WHERE catalog_key IS NOT NULL ORDER BY catalog_key"
        ).fetchall()
        assert [tuple(row) for row in after] == [tuple(row) for row in before]
        assert (
            reopened.database.connection.execute("SELECT COUNT(*) FROM personas").fetchone()[0]
            == len(DEFAULT_PERSONA_CATALOG) + 1
        )
    finally:
        reopened.close()


def test_user_edits_and_archives_catalog_persona_without_startup_reverting_it(
    tmp_path: Path,
) -> None:
    runtime = _runtime(tmp_path)
    pip = runtime.database.connection.execute(
        "SELECT id FROM personas WHERE catalog_key='everyday-planner'"
    ).fetchone()
    runtime.handle(
        "personas.update",
        {
            "personaId": pip["id"],
            "name": "My Daily Copilot",
            "instructions": "Use my own planning rules.",
        },
    )
    runtime.handle("personas.archive", {"personaId": pip["id"]})
    runtime.close()

    reopened = _runtime(tmp_path)
    try:
        personas, _ = reopened.handle("personas.list", {"includeArchived": True})
        edited = next(item for item in personas if item["id"] == pip["id"])
        assert edited["name"] == "My Daily Copilot"
        assert edited["instructions"] == "Use my own planning rules."
        assert edited["archivedAt"] is not None
        assert (
            reopened.database.connection.execute(
                "SELECT COUNT(*) FROM personas WHERE catalog_key='everyday-planner'"
            ).fetchone()[0]
            == 1
        )
    finally:
        reopened.close()


def test_untouched_advisors_follow_real_default_but_explicit_model_choice_sticks(
    tmp_path: Path,
) -> None:
    runtime = _runtime(tmp_path)
    first = runtime.providers.register_openai_compatible_endpoint(
        "first-real",
        model="useful-one",
        display_name="Useful One",
        base_url="http://127.0.0.1:44001/v1",
    )
    second = runtime.providers.register_openai_compatible_endpoint(
        "second-real",
        model="useful-two",
        display_name="Useful Two",
        base_url="http://127.0.0.1:44002/v1",
    )
    third = runtime.providers.register_openai_compatible_endpoint(
        "third-real",
        model="useful-three",
        display_name="Useful Three",
        base_url="http://127.0.0.1:44003/v1",
    )
    runtime.handle("models.select", {"modelId": first.id})
    personas, _ = runtime.handle("personas.list", {})
    assert all(item["modelId"] == first.id for item in personas)

    pip = next(item for item in personas if item["name"] == "Pip")
    sage = next(item for item in personas if item["name"] == "Sage")
    runtime.handle(
        "personas.update",
        {
            "personaId": pip["id"],
            "name": "My Pip",
            "instructions": "Keep my planning preferences.",
            "modelId": first.id,
        },
    )
    runtime.handle(
        "personas.update",
        {
            "personaId": sage["id"],
            "name": "My Study Coach",
            "instructions": "Use examples from my course notes.",
        },
    )
    runtime.handle("models.select", {"modelId": second.id})
    after_select, _ = runtime.handle("personas.list", {})
    customized = next(item for item in after_select if item["id"] == pip["id"])
    assert customized["name"] == "My Pip"
    assert customized["instructions"] == "Keep my planning preferences."
    assert customized["modelId"] == first.id
    edited_but_managed = next(item for item in after_select if item["id"] == sage["id"])
    assert edited_but_managed["name"] == "My Study Coach"
    assert edited_but_managed["instructions"] == "Use examples from my course notes."
    assert edited_but_managed["modelId"] == second.id
    assert all(item["modelId"] == second.id for item in after_select if item["id"] != pip["id"])

    runtime.handle("settings.set", {"key": "models.default", "value": third.id})
    after_setting, _ = runtime.handle("personas.list", {})
    assert next(item for item in after_setting if item["id"] == pip["id"])["modelId"] == first.id
    assert all(item["modelId"] == third.id for item in after_setting if item["id"] != pip["id"])
    runtime.close()
