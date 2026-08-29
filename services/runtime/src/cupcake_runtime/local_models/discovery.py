"""Discover local runtimes without starting or changing them."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlparse

from .http import JsonHttpClient
from .types import RuntimeEndpoint, RuntimeKind, RuntimeState


class JsonRequestClient(Protocol):
    async def request(
        self, method: str, url: str, payload: Mapping[str, Any] | None = None
    ) -> Any: ...


DEFAULT_ENDPOINTS = {
    RuntimeKind.OLLAMA: "http://127.0.0.1:11434",
    RuntimeKind.LM_STUDIO: "http://127.0.0.1:1234",
    RuntimeKind.CUPCAKE_LLAMA_CPP: "http://127.0.0.1:8080",
}


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
            if kind == RuntimeKind.OLLAMA:
                version_data, model_data = await asyncio.gather(
                    self.client.request("GET", f"{base_url}/api/version"),
                    self.client.request("GET", f"{base_url}/api/tags"),
                )
                version = (version_data or {}).get("version")
                models = tuple(
                    item.get("name", "")
                    for item in (model_data or {}).get("models", [])
                    if item.get("name")
                )
            elif kind == RuntimeKind.LM_STUDIO:
                model_data = await self.client.request("GET", f"{base_url}/api/v1/models")
                items = (model_data or {}).get("models", (model_data or {}).get("data", []))
                models = tuple(
                    item.get("key") or item.get("id")
                    for item in items
                    if item.get("key") or item.get("id")
                )
                version = (model_data or {}).get("version")
            else:
                health_path = "/health" if kind == RuntimeKind.CUPCAKE_LLAMA_CPP else "/v1/models"
                data = await self.client.request("GET", f"{base_url}{health_path}")
                items = (data or {}).get("data", []) if isinstance(data, dict) else []
                models = tuple(item.get("id") for item in items if item.get("id"))
                version = (data or {}).get("version") if isinstance(data, dict) else None
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
