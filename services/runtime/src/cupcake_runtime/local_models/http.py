"""Tiny injectable JSON client for localhost model-management APIs."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping
from typing import Any
from urllib.request import Request, urlopen


class JsonHttpClient:
    def __init__(self, timeout_seconds: float = 2.0):
        self.timeout_seconds = timeout_seconds

    async def request(self, method: str, url: str, payload: Mapping[str, Any] | None = None) -> Any:
        def perform() -> Any:
            body = json.dumps(payload).encode() if payload is not None else None
            request = Request(
                url, body, method=method, headers={"Content-Type": "application/json"}
            )
            with urlopen(request, timeout=self.timeout_seconds) as response:
                data = response.read()
            return json.loads(data) if data else None

        return await asyncio.to_thread(perform)

    async def stream_json(
        self, method: str, url: str, payload: Mapping[str, Any]
    ) -> AsyncIterator[Any]:
        def collect() -> list[Any]:
            body = json.dumps(payload).encode()
            request = Request(
                url, body, method=method, headers={"Content-Type": "application/json"}
            )
            with urlopen(request, timeout=max(self.timeout_seconds, 120.0)) as response:
                return [json.loads(line) for line in response if line.strip()]

        for item in await asyncio.to_thread(collect):
            yield item
