#!/usr/bin/env python3
"""Run secret-safe Cohere onboarding and chat without opening the desktop UI."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import asdict, replace
from datetime import UTC, datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "services" / "runtime" / "src"))

from cupcake_runtime.providers.base import ProviderConfig
from cupcake_runtime.providers.catalog import ModelCatalog
from cupcake_runtime.providers.cohere import CohereAdapter
from cupcake_runtime.providers.onboarding import ProviderOnboardingService, ProviderTestState
from cupcake_runtime.providers.types import (
    CanonicalMessage,
    ModelRequest,
    StreamEventType,
)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def cohere_key(path: Path) -> str:
    candidates: list[tuple[bool, str]] = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if "cohere" not in line.casefold() or "=" not in line:
            continue
        label, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 20 and not any(character.isspace() for character in value):
            candidates.append(("production" in label.casefold(), value))
    if not candidates:
        raise RuntimeError("The authorized key file does not contain a Cohere key")
    return next((value for production, value in candidates if not production), candidates[0][1])


async def run(args: argparse.Namespace) -> dict[str, object]:
    credential = cohere_key(args.key_file)
    config = ProviderConfig(api_key=credential, timeout_seconds=180)
    service = ProviderOnboardingService()
    execution = await service.test_connection_with_evidence(
        "cohere",
        config,
    )
    result = execution.result
    if result.state is not ProviderTestState.READY:
        diagnostic = result.diagnostic.code if result.diagnostic else "unknown"
        raise RuntimeError(f"Cohere onboarding did not become ready: {diagnostic}")
    discovered = next(
        (item for item in result.models if item.model == "command-a-03-2025"),
        next((item for item in result.models if "command-a" in item.model.casefold()), None),
    )
    if discovered is None:
        raise RuntimeError("Cohere discovery returned no Command A chat model")
    template = ModelCatalog.builtins().get("cohere:command-a-03-2025")
    descriptor = replace(
        template,
        id=f"cohere:{discovered.model}",
        model=discovered.model,
        display_name=discovered.display_name,
    )
    adapter = CohereAdapter(descriptor, config)
    marker = "CUPCAKE HOSTED HEADLESS ACCEPTED"
    request = ModelRequest(
        model_id=descriptor.id,
        messages=(
            CanonicalMessage(
                "user",
                f"Write one short plain-text sentence containing the codeword {marker}. "
                "Do not call tools.",
            ),
        ),
        max_output_tokens=128,
        temperature=0,
    )
    text_parts: list[str] = []
    usage: dict[str, object] = {}
    finish_reason: str | None = None
    async for event in adapter.stream(request):
        if event.type is StreamEventType.TEXT_DELTA and event.text:
            text_parts.append(event.text)
        elif event.type is StreamEventType.USAGE and event.usage:
            usage = asdict(event.usage)
        elif event.type is StreamEventType.FINISH:
            finish_reason = event.finish_reason
        elif event.type is StreamEventType.ERROR:
            try:
                await adapter._client_or_create().v2.chat(**adapter.build_request(request))
            except Exception as error:
                body = str(getattr(error, "body", "")).replace(credential, "[redacted]")
                status = getattr(error, "status_code", None)
                raise RuntimeError(
                    f"Cohere validation failed for {descriptor.model}: "
                    f"{type(error).__name__} status={status} body={body[:500]}"
                ) from None
            raise RuntimeError(
                f"Cohere chat failed for {descriptor.model}: {event.error_code}; {event.text}"
            )
    content = "".join(text_parts).strip()
    if marker not in content or finish_reason is None:
        raise RuntimeError(f"Cohere chat did not complete with the acceptance marker: {content[:240]}")
    return {
        "finishedAt": datetime.now(UTC).isoformat(),
        "provider": "cohere",
        "onboardingState": result.state.value,
        "discoveryState": result.discovery.value,
        "discoveredModels": len(result.models),
        "latencyMs": result.latency_ms,
        "selectedModel": descriptor.model,
        "chat": {
            "expected": marker,
            "content": content,
            "finishReason": finish_reason,
            "usage": usage,
        },
    }


def main() -> None:
    args = arguments()
    evidence = asyncio.run(run(args))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
