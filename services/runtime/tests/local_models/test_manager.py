from __future__ import annotations

from typing import Any

import pytest

from cupcake_runtime.local_models.manager import LMStudioManager, LocalModelManager
from cupcake_runtime.local_models.types import RuntimeEndpoint, RuntimeKind, RuntimeState


class _RecordingClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, Any] | None]] = []

    async def request(
        self, method: str, url: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        self.calls.append((method, url, payload))
        return {"ok": True}


def test_lm_studio_uses_long_management_timeout_by_default() -> None:
    manager = LMStudioManager()

    assert manager.client.timeout_seconds == 120.0


@pytest.mark.asyncio
async def test_lm_studio_management_uses_native_api_and_model_key() -> None:
    client = _RecordingClient()
    manager = LMStudioManager(client=client)  # type: ignore[arg-type]

    await manager.load("qwen/qwen3.5-9b", context_length=8_192)
    await manager.unload("qwen/qwen3.5-9b")

    assert client.calls == [
        (
            "POST",
            "http://127.0.0.1:1234/api/v1/models/load",
            {"model": "qwen/qwen3.5-9b", "context_length": 8_192},
        ),
        (
            "POST",
            "http://127.0.0.1:1234/api/v1/models/unload",
            {"model": "qwen/qwen3.5-9b"},
        ),
    ]


class _Discovery:
    async def discover_defaults(
        self, *, vllm_endpoints: tuple[str, ...] = ()
    ) -> tuple[RuntimeEndpoint, ...]:
        assert vllm_endpoints == ()
        return (
            RuntimeEndpoint(
                id="lm_studio:http://127.0.0.1:1234",
                kind=RuntimeKind.LM_STUDIO,
                base_url="http://127.0.0.1:1234",
                state=RuntimeState.READY,
                models=("stale",),
            ),
        )

    async def probe(
        self, kind: RuntimeKind, base_url: str, *, allow_remote: bool = False
    ) -> RuntimeEndpoint:
        raise AssertionError((kind, base_url, allow_remote))


class _LMStudioCatalog:
    async def list_models(self) -> dict[str, Any]:
        return {
            "models": [
                {
                    "type": "llm",
                    "key": "google/gemma-3n-e4b",
                    "display_name": "Gemma 3n E4B",
                    "loaded_instances": [{"id": "google/gemma-3n-e4b"}],
                    "max_context_length": 32_768,
                },
                {
                    "type": "llm",
                    "key": "qwen/qwen3.5-9b",
                    "loaded_instances": [],
                    "max_context_length": 262_144,
                },
                {"type": "embedding", "key": "text-embedding-nomic-embed-text-v1.5"},
            ]
        }


@pytest.mark.asyncio
async def test_discovery_enriches_lm_studio_loaded_state_and_filters_embeddings() -> None:
    manager = LocalModelManager(
        discovery=_Discovery(),
        lm_studio=_LMStudioCatalog(),
    )

    (endpoint,) = await manager.discover()

    assert endpoint.models == ("google/gemma-3n-e4b", "qwen/qwen3.5-9b")
    assert endpoint.metadata["model_states"] == {
        "google/gemma-3n-e4b": {
            "display_name": "Gemma 3n E4B",
            "loaded": True,
            "context_window": 32_768,
        },
        "qwen/qwen3.5-9b": {
            "display_name": None,
            "loaded": False,
            "context_window": 262_144,
        },
    }
