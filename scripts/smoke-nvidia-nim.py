"""Tiny opt-in NVIDIA NIM smoke test without printing credentials or content."""

from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

REPOSITORY = Path(__file__).resolve().parents[1]
RUNTIME_SOURCE = REPOSITORY / "services" / "runtime" / "src"
SECRETS_FILE = REPOSITORY / ".secrets" / "provider-keys.txt"
sys.path.insert(0, str(RUNTIME_SOURCE))

from cupcake_runtime.providers.base import ProviderConfig
from cupcake_runtime.providers.nvidia_nim import (
    NVIDIA_NIM_BASE_URL,
    NvidiaNimCatalogDiscovery,
)

KEY_PATTERN = re.compile(r"\bnvapi-[A-Za-z0-9_-]{20,}\b")
SAFE_LIMIT_HEADER = re.compile(r"^[0-9][0-9 .:/_-]{0,127}$")
PREFERRED_MODELS = (
    "nvidia/nemotron-3-nano-30b-a3b",
    "openai/gpt-oss-20b",
    "ibm/granite-3.0-3b-a800m-instruct",
    "google/gemma-3-4b-it",
    "mistralai/mistral-7b-instruct-v0.3",
    "meta/llama-3.1-8b-instruct",
)


class CapturingModels:
    def __init__(self, client: Any) -> None:
        self.client = client
        self.limit_headers: dict[str, str] = {}

    async def list(self) -> Any:
        raw = await self.client.models.with_raw_response.list()
        for name, value in raw.headers.items():
            lowered = name.casefold()
            if any(
                marker in lowered
                for marker in ("ratelimit", "rate-limit", "quota", "credit")
            ):
                normalized = str(value).strip()
                self.limit_headers[lowered] = (
                    normalized if SAFE_LIMIT_HEADER.fullmatch(normalized) else "present"
                )
        return raw.parse()


def load_key() -> str:
    try:
        contents = SECRETS_FILE.read_text(encoding="utf-8")
    except OSError as exc:
        raise RuntimeError("ignored provider key file is unavailable") from exc
    match = KEY_PATTERN.search(contents)
    if match is None:
        raise RuntimeError("NVIDIA NIM key was not found")
    return match.group(0)


def choose_models(model_ids: list[str]) -> list[str]:
    lookup = {model.casefold(): model for model in model_ids}
    selected: list[str] = []
    for preferred in PREFERRED_MODELS:
        if preferred in lookup:
            selected.append(lookup[preferred])

    def score(model: str) -> tuple[int, float, str]:
        lowered = model.casefold()
        instruction = (
            0 if any(token in lowered for token in ("instruct", "chat", "-it")) else 1
        )
        size = re.search(r"(?:^|[-_/])(\d+(?:\.\d+)?)b(?:[-_/]|$)", lowered)
        billions = float(size.group(1)) if size else 10_000.0
        return instruction, billions, lowered

    if not model_ids:
        raise RuntimeError("NVIDIA NIM returned no text-model candidates")
    selected.extend(sorted(model_ids, key=score))
    return list(dict.fromkeys(selected))[:3]


async def smoke() -> None:
    from openai import AsyncOpenAI

    key = load_key()
    client = AsyncOpenAI(api_key=key, base_url=NVIDIA_NIM_BASE_URL, timeout=30.0)
    capturing = CapturingModels(client)
    discovery = NvidiaNimCatalogDiscovery(ttl_seconds=0)
    catalog = await discovery.discover(
        ProviderConfig(api_key=key, timeout_seconds=30.0),
        client=SimpleNamespace(models=capturing),
        force=True,
    )
    candidates = choose_models([descriptor.model for descriptor in catalog.models])

    model: str | None = None
    prompt_tokens = completion_tokens = total_tokens = text_characters = attempts = 0
    for candidate in candidates:
        attempts += 1
        stream = None
        try:
            stream = await client.chat.completions.create(
                model=candidate,
                messages=[{"role": "user", "content": "Reply with exactly: NIM OK"}],
                max_tokens=8,
                temperature=0,
                stream=True,
                stream_options={"include_usage": True},
            )
            async for chunk in stream:
                if chunk.choices:
                    text_characters += len(chunk.choices[0].delta.content or "")
                if chunk.usage is not None:
                    prompt_tokens = chunk.usage.prompt_tokens
                    completion_tokens = chunk.usage.completion_tokens
                    total_tokens = chunk.usage.total_tokens
            model = candidate
            break
        except Exception as exc:
            if getattr(exc, "status_code", None) != 404:
                raise
            prompt_tokens = completion_tokens = total_tokens = text_characters = 0
        finally:
            if stream is not None:
                await stream.close()
    if model is None:
        raise RuntimeError(
            "NVIDIA NIM returned 404 for the bounded chat-model candidates"
        )

    print(
        "NVIDIA_NIM_SMOKE=passed "
        f"model={model} attempts={attempts} catalog_models={len(catalog.models)} "
        f"filtered_non_chat={catalog.filtered_non_chat} "
        f"unknown_compatibility={catalog.unknown_chat_compatibility} "
        f"response_chars={text_characters} prompt_tokens={prompt_tokens} "
        f"completion_tokens={completion_tokens} total_tokens={total_tokens}"
    )
    if capturing.limit_headers:
        rendered = ",".join(
            f"{name}={value}" for name, value in sorted(capturing.limit_headers.items())
        )
        print(f"NVIDIA_NIM_LIMIT_HEADERS={rendered}")
    else:
        print("NVIDIA_NIM_LIMIT_HEADERS=not_reported")
    await client.close()


def main() -> int:
    try:
        asyncio.run(smoke())
    except Exception as exc:  # noqa: BLE001 - CLI boundary emits only classified safe fields.
        status = getattr(exc, "status_code", None)
        safe_status = str(status) if isinstance(status, int) else "unavailable"
        print(
            "NVIDIA_NIM_SMOKE=failed "
            f"error_type={type(exc).__name__} status={safe_status}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
