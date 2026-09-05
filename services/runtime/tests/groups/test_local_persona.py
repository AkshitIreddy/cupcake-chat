from pathlib import Path

import pytest

from cupcake_runtime.application import RuntimeCommandError, RuntimeService
from cupcake_runtime.local_models.catalog import SignedModelCatalog
from cupcake_runtime.local_models.types import ModelArtifact


def test_catalog_local_persona_survives_restart_without_loading(tmp_path: Path) -> None:
    artifact = ModelArtifact(
        id="qwen3-8b-q4-k-m",
        display_name="Qwen3 8B Q4_K_M",
        family="qwen3",
        parameter_billions=8,
        quantization="Q4_K_M",
        size_bytes=1,
        sha256="a" * 64,
        urls=("https://example.invalid/model.gguf",),
        filename="model.gguf",
        license="Apache-2.0",
        license_url="https://example.invalid/license",
        context_window=32768,
        capability_tags=("chat",),
    )
    catalog = SignedModelCatalog(1, "2026-09-05T00:00:00Z", (artifact,), "test")
    canonical = "openai-compatible:cupcake-local/qwen3-8b-q4-k-m"
    runtime = RuntimeService(tmp_path, master_key=b"l" * 32, require_sqlcipher=False)
    runtime.cupcake_local.configure_catalogs(models=catalog)
    created, _ = runtime.handle("conversations.create", {"title": "Private council"})
    persona, _ = runtime.handle(
        "personas.create", {"name": "Juniper", "handle": "juniper", "modelId": canonical}
    )
    participant, _ = runtime.handle(
        "conversations.participants.add",
        {"conversationId": created["conversation"]["id"], "personaId": persona["id"]},
    )
    assert participant["availability"]["status"] == "local_not_loaded"
    assert runtime.cupcake_local._supervisor is None
    # Configuring a future route must not make the generic registry think it is loaded.
    with pytest.raises(KeyError):
        runtime.providers.catalog.select(canonical)
    runtime.close()

    reopened = RuntimeService(tmp_path, master_key=b"l" * 32, require_sqlcipher=False)
    reopened.cupcake_local.configure_catalogs(models=catalog)
    roster, _ = reopened.handle(
        "conversations.participants.list", {"conversationId": created["conversation"]["id"]}
    )
    assert roster[0]["persona"]["modelId"] == canonical
    assert roster[0]["availability"]["status"] == "local_not_loaded"
    assert reopened.cupcake_local._supervisor is None
    with pytest.raises(RuntimeCommandError) as error:
        reopened.handle(
            "personas.create",
            {"name": "Unknown", "handle": "unknown", "modelId": canonical + "-invented"},
        )
    assert error.value.code == "PERSONA_MODEL_NOT_FOUND"
    reopened.close()
