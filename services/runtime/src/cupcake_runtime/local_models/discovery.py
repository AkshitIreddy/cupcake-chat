"""Discover local runtimes without starting or changing them."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol, TypeGuard, cast
from urllib.parse import urlparse

from .http import JsonHttpClient
from .types import RuntimeEndpoint, RuntimeKind, RuntimeState


class JsonRequestClient(Protocol):
    async def request(
        self, method: str, url: str, payload: Mapping[str, Any] | None = None
    ) -> object: ...


DEFAULT_ENDPOINTS = {
    RuntimeKind.OLLAMA: "http://127.0.0.1:11434",
    RuntimeKind.LM_STUDIO: "http://127.0.0.1:1234",
    RuntimeKind.CUPCAKE_LLAMA_CPP: "http://127.0.0.1:8080",
}


def _is_object(value: object) -> TypeGuard[Mapping[str, object]]:
    if not isinstance(value, Mapping):
        return False
    mapping = cast(Mapping[object, object], value)
    return all(isinstance(key, str) for key in mapping)


def _object_sequence(value: object) -> tuple[Mapping[str, object], ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return ()
    items = cast(Sequence[object], value)
    return tuple(item for item in items if _is_object(item))


def _optional_text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def validate_endpoint(base_url: str, *, allow_remote: bool) -> str:
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("runtime endpoint must be an http(s) URL")
    local = parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    if not local and not allow_remote:
        raise ValueError("local runtime endpoints must use loopback; opt in for remote vLLM")
    return base_url.rstrip("/")


@dataclass(slots=True)
class RuntimeDiscovery:
    client: JsonRequestClient

    def __init__(self, client: JsonRequestClient | None = None):
        self.client = client or JsonHttpClient()

    async def discover_defaults(
        self, *, vllm_endpoints: tuple[str, ...] = ()
    ) -> tuple[RuntimeEndpoint, ...]:
        probes = [self.probe(kind, url) for kind, url in DEFAULT_ENDPOINTS.items()]
        probes.extend(
            self.probe(RuntimeKind.VLLM, url, allow_remote=True) for url in vllm_endpoints
        )
        return tuple(await asyncio.gather(*probes))

    async def probe(
        self, kind: RuntimeKind, base_url: str, *, allow_remote: bool = False
    ) -> RuntimeEndpoint:
        base_url = validate_endpoint(base_url, allow_remote=allow_remote)
        started = time.monotonic()
        try:
            version: str | None
            models: tuple[str, ...]
            if kind == RuntimeKind.OLLAMA:
                version_data, model_data = await asyncio.gather(
                    self.client.request("GET", f"{base_url}/api/version"),
                    self.client.request("GET", f"{base_url}/api/tags"),
                )
                version_object: Mapping[str, object] = (
                    version_data if _is_object(version_data) else {}
                )
                model_object: Mapping[str, object] = model_data if _is_object(model_data) else {}
                version = _optional_text(version_object.get("version"))
                models = tuple(
                    name
                    for item in _object_sequence(model_object.get("models"))
                    if (name := _optional_text(item.get("name"))) is not None
                )
            elif kind == RuntimeKind.LM_STUDIO:
                model_data = await self.client.request("GET", f"{base_url}/api/v1/models")
                model_object = model_data if _is_object(model_data) else {}
                items = _object_sequence(model_object.get("models", model_object.get("data", ())))
                models = tuple(
                    model_id
                    for item in items
                    if (
                        model_id := _optional_text(item.get("key"))
                        or _optional_text(item.get("id"))
                    )
                    is not None
                )
                version = _optional_text(model_object.get("version"))
            else:
                health_path = "/health" if kind == RuntimeKind.CUPCAKE_LLAMA_CPP else "/v1/models"
                data = await self.client.request("GET", f"{base_url}{health_path}")
                data_object: Mapping[str, object] = data if _is_object(data) else {}
                items = _object_sequence(data_object.get("data", ()))
                models = tuple(
                    model_id
                    for item in items
                    if (model_id := _optional_text(item.get("id"))) is not None
                )
                version = _optional_text(data_object.get("version"))
            return RuntimeEndpoint(
                id=f"{kind.value}:{base_url}",
                kind=kind,
                base_url=base_url,
                state=RuntimeState.READY,
                version=version,
                models=models,
                managed=kind == RuntimeKind.CUPCAKE_LLAMA_CPP,
                latency_ms=(time.monotonic() - started) * 1000,
            )
        except Exception as exc:
            return RuntimeEndpoint(
                id=f"{kind.value}:{base_url}",
                kind=kind,
                base_url=base_url,
                state=RuntimeState.ABSENT if kind != RuntimeKind.VLLM else RuntimeState.UNREACHABLE,
                managed=kind == RuntimeKind.CUPCAKE_LLAMA_CPP,
                detail=str(exc),
                latency_ms=(time.monotonic() - started) * 1000,
            )
