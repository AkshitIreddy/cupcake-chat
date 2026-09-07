from dataclasses import replace
from pathlib import Path

import pytest

from cupcake_runtime.application import RuntimeCommandError, RuntimeService
from cupcake_runtime.local_models.catalog import SignedModelCatalog
from cupcake_runtime.local_models.types import (
    ModelArtifact,
    RuntimeEndpoint,
    RuntimeKind,
    RuntimeState,
)
from cupcake_runtime.providers.types import PrivacyRoute


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
    assert runtime.cupcake_local.status()["activeModelId"] is None
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
    assert reopened.cupcake_local.status()["activeModelId"] is None
    with pytest.raises(RuntimeCommandError) as error:
        reopened.handle(
            "personas.create",
            {"name": "Unknown", "handle": "unknown", "modelId": canonical + "-invented"},
        )
    assert error.value.code == "PERSONA_MODEL_NOT_FOUND"
    reopened.close()


@pytest.mark.parametrize("unload_kind", ["explicit", "idle"])
def test_group_local_readiness_tracks_live_exact_model_lifecycle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, unload_kind: str
) -> None:
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
    live = RuntimeEndpoint(
        id="cupcake_llama_cpp:managed",
        kind=RuntimeKind.CUPCAKE_LLAMA_CPP,
        base_url="",
        state=RuntimeState.STOPPED,
        managed=True,
    )

    def readiness() -> RuntimeEndpoint:
        return live

    async def unload() -> RuntimeEndpoint:
        nonlocal live
        live = RuntimeEndpoint(
            id="cupcake_llama_cpp:managed",
            kind=RuntimeKind.CUPCAKE_LLAMA_CPP,
            base_url="",
            state=RuntimeState.STOPPED,
            managed=True,
        )
        return live

    monkeypatch.setattr(runtime.cupcake_local, "readiness", readiness)
    monkeypatch.setattr(runtime.cupcake_local, "unload", unload)
    created, _ = runtime.handle("conversations.create", {"title": "Private council"})
    persona, _ = runtime.handle(
        "personas.create", {"name": "Juniper", "handle": "juniper", "modelId": canonical}
    )
    runtime.handle(
        "conversations.participants.add",
        {"conversationId": created["conversation"]["id"], "personaId": persona["id"]},
    )

    def availability() -> str:
        participants, _ = runtime.handle(
            "conversations.participants.list",
            {"conversationId": created["conversation"]["id"]},
        )
        return str(participants[0]["availability"]["status"])

    assert availability() == "local_not_loaded"
    runtime._register_local_endpoint_model(  # pyright: ignore[reportPrivateUsage]
        endpoint_id="cupcake-local",
        model=artifact.id,
        display_name=artifact.display_name,
        base_url="http://127.0.0.1:49152/v1",
        privacy=PrivacyRoute.LOCAL,
        runtime_kind="cupcake_llama_cpp",
        runtime_loaded=True,
    )
    live = RuntimeEndpoint(
        id="cupcake_llama_cpp:test",
        kind=RuntimeKind.CUPCAKE_LLAMA_CPP,
        base_url="http://127.0.0.1:49152/v1",
        state=RuntimeState.READY,
        models=(artifact.id,),
        managed=True,
    )
    assert availability() == "ready"

    live = replace(live, state=RuntimeState.FAILED)
    assert availability() == "local_not_loaded"
    live = replace(live, state=RuntimeState.READY, models=("another-installed-model",))
    assert availability() == "local_not_loaded"
    live = replace(live, models=(artifact.id,))
    assert availability() == "ready"

    if unload_kind == "explicit":
        runtime.handle("local_models.cupcake.unload", {})
    else:
        runtime._unload_idle_local_model()  # pyright: ignore[reportPrivateUsage]
    assert availability() == "local_not_loaded"
    # Keep the installed/persona route configured. Readiness comes from the
    # managed service's live state rather than mutating persisted selection.
    assert runtime.providers.catalog.select(canonical).metadata["runtime_loaded"] is True
    personas, _ = runtime.handle("personas.list", {})
    assert next(item for item in personas if item["id"] == persona["id"])["modelId"] == canonical
    runtime.close()
