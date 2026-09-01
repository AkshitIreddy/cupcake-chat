#!/usr/bin/env python3
"""Minimal Cohere adapter smoke test with secret-safe output.

The ignored provider key file is read only in memory. The trial/evaluation key
is always attempted first; the production key is used only after a confirmed
HTTP 429/rate-limit response. Neither credentials nor response text are logged.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import re
import sys
from pathlib import Path

from cupcake_runtime.providers.base import ProviderConfig
from cupcake_runtime.providers.catalog import ModelCatalog
from cupcake_runtime.providers.cohere import CohereAdapter
from cupcake_runtime.providers.types import CanonicalMessage, ModelRequest, StreamEventType


def credentials(path: Path) -> tuple[str | None, str | None]:
    trial: str | None = None
    production: str | None = None
    for raw in path.read_text(encoding="utf-8", errors="strict").splitlines():
        if "cohere" not in raw.casefold():
            continue
        parts = re.split(r"\s*[:=]\s*", raw.strip(), maxsplit=1)
        if len(parts) == 2:
            label, value = parts
        else:
            tokens = raw.split()
            if len(tokens) < 2:
                continue
            label, value = " ".join(tokens[:-1]), tokens[-1]
        if len(value) < 20:
            continue
        if "prod" in label.casefold() or "production" in raw.casefold():
            production = value.strip()
        else:
            trial = value.strip()
    return trial, production


async def smoke(api_key: str) -> tuple[int, int, int]:
    descriptor = ModelCatalog.builtins().get("cohere:command-a-03-2025")
    adapter = CohereAdapter(descriptor, ProviderConfig(api_key=api_key, timeout_seconds=30))
    request = ModelRequest(
        descriptor.id,
        (CanonicalMessage("user", "Say hello in one short sentence."),),
        max_output_tokens=128,
        metadata={"run_id": "cohere-smoke"},
    )
    events = 0
    characters = 0
    tokens = 0
    async for event in adapter.stream(request):
        events += 1
        if event.type is StreamEventType.TEXT_DELTA:
            characters += len(event.text or "")
        if event.usage:
            tokens += event.usage.total_tokens
    return events, characters, tokens


async def safe_shape(api_key: str) -> list[dict[str, object]]:
    """Return field names and value types only; never response content."""
    from cohere import AsyncClientV2

    client = AsyncClientV2(api_key=api_key, timeout=30)
    stream = client.v2.chat_stream(
        model="command-a-03-2025",
        messages=[{"role": "user", "content": "Say hello in one short sentence."}],
        max_tokens=128,
        thinking={"type": "disabled"},
    )
    shapes: list[dict[str, object]] = []
    async for event in stream:
        data = event.model_dump() if hasattr(event, "model_dump") else vars(event)
        shapes.append({"eventType": str(getattr(event, "type", "unknown")), "shape": field_shape(data)})
    return shapes


def field_shape(value: object, prefix: str = "") -> list[str]:
    paths: list[str] = []
    if isinstance(value, dict):
        for key in sorted(value):
            path = f"{prefix}.{key}" if prefix else str(key)
            paths.append(f"{path}:{type(value[key]).__name__}")
            paths.extend(field_shape(value[key], path))
    elif isinstance(value, list) and value:
        path = f"{prefix}[]"
        paths.append(f"{path}:{type(value[0]).__name__}")
        paths.extend(field_shape(value[0], path))
    return paths


def throttled(error: Exception) -> bool:
    status = getattr(error, "status_code", None)
    return status == 429 or "ratelimit" in type(error).__name__.casefold()


async def main() -> int:
    trial, production = credentials(Path(".secrets/provider-keys.txt"))
    if not trial:
        print("COHERE_SMOKE=skipped reason=trial_key_missing")
        return 2
    if "--signature" in sys.argv:
        from cohere import AsyncClientV2

        signature = inspect.signature(AsyncClientV2(api_key=trial).v2.chat_stream)
        print(
            "COHERE_CHAT_STREAM_PARAMS="
            + ",".join(signature.parameters)
        )
        thinking = signature.parameters["thinking"]
        print(f"COHERE_THINKING_ANNOTATION={thinking.annotation!s} DEFAULT={thinking.default!s}")
        from cohere.types import Thinking

        print(
            "COHERE_THINKING_FIELDS="
            + ",".join(
                f"{name}:{field.annotation!s}" for name, field in Thinking.model_fields.items()
            )
        )
        return 0
    if "--diagnose-shape" in sys.argv:
        print(json.dumps(await safe_shape(trial), separators=(",", ":")))
        return 0
    try:
        events, characters, tokens = await smoke(trial)
        print(
            f"COHERE_TRIAL_SMOKE=passed events={events} "
            f"text_chars={characters} tokens={tokens}"
        )
        return 0
    except Exception as error:
        status = getattr(error, "status_code", "unavailable")
        if "--diagnose-error" in sys.argv:
            safe = re.sub(
                r"[A-Za-z0-9_-]{20,}",
                "<redacted>",
                str(getattr(error, "body", None)),
            )
            print(f"COHERE_SAFE_ERROR_BODY={safe[:1000]}")
        if not throttled(error):
            print(
                f"COHERE_TRIAL_SMOKE=failed error_type={type(error).__name__} "
                f"status={status} production_key_used=false"
            )
            return 1
        print("COHERE_TRIAL_SMOKE=throttled status=429")
        if not production:
            print("COHERE_PRODUCTION_SMOKE=skipped reason=production_key_missing")
            return 1
        try:
            events, characters, tokens = await smoke(production)
            print(
                f"COHERE_PRODUCTION_SMOKE=passed events={events} "
                f"text_chars={characters} tokens={tokens}"
            )
            return 0
        except Exception as production_error:
            print(
                f"COHERE_PRODUCTION_SMOKE=failed "
                f"error_type={type(production_error).__name__} "
                f"status={getattr(production_error, 'status_code', 'unavailable')}"
            )
            return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
