#!/usr/bin/env python3
"""Exercise CUPCAKEAGI's managed llama.cpp path without opening the desktop UI."""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "services" / "runtime" / "src"))

from cupcake_runtime.local_models.manager import LlamaCppSupervisor


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--gpu-marker", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--context-size", type=int, default=4096)
    return parser.parse_args()


def chat(supervisor: LlamaCppSupervisor) -> dict[str, Any]:
    expected = "CUPCAKE LOCAL CUDA HEADLESS ACCEPTED"
    body = json.dumps(
        {
            "model": "qwen3-8b-q4-k-m",
            "messages": [
                {
                    "role": "user",
                    "content": f"/no_think\nReply with exactly: {expected}",
                }
            ],
            "temperature": 0,
            "seed": 1,
            "max_tokens": 48,
            "stream": False,
        }
    ).encode("utf-8")
    request = Request(
        f"{supervisor.base_url}/v1/chat/completions",
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            **supervisor.authorization_headers(),
        },
    )
    with urlopen(request, timeout=180) as response:
        payload = json.loads(response.read(2 * 1024 * 1024))
    content = str(payload["choices"][0]["message"]["content"]).strip()
    if expected not in content:
        raise RuntimeError(f"local chat did not return the acceptance phrase: {content[:240]}")
    return {
        "expected": expected,
        "content": content,
        "usage": payload.get("usage", {}),
        "timings": payload.get("timings", {}),
    }


def gpu_snapshot() -> str:
    result = subprocess.run(
        [
            "nvidia-smi.exe",
            "--query-gpu=name,driver_version,memory.used,utilization.gpu",
            "--format=csv,noheader",
        ],
        capture_output=True,
        check=False,
        text=True,
        timeout=15,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    return result.stdout.strip()[:512]


async def run(args: argparse.Namespace) -> dict[str, Any]:
    if args.gpu_marker.read_text(encoding="utf-8").strip().lower() != "yes":
        raise RuntimeError("GPU marker must be yes before local-runtime acceptance starts")
    executable = args.executable.resolve(strict=True)
    model = args.model.resolve(strict=True)
    supervisor = LlamaCppSupervisor(executable)
    started_at = datetime.now(UTC)
    try:
        pid = supervisor.start(
            model,
            context_size=args.context_size,
            gpu_layers="auto",
            device=None,
            parallel=1,
        )
        endpoint = await supervisor.wait_until_ready(timeout_seconds=180)
        benchmark = await supervisor.benchmark(
            runtime_id="llama-b10679-cuda-13",
            model_id="qwen3-8b-q4-k-m",
            max_tokens=32,
            timeout_seconds=180,
        )
        conversation = await asyncio.to_thread(chat, supervisor)
        return {
            "startedAt": started_at.isoformat(),
            "finishedAt": datetime.now(UTC).isoformat(),
            "runtimeState": endpoint.state.value,
            "runtimePid": pid,
            "modelBytes": model.stat().st_size,
            "contextSize": args.context_size,
            "gpu": gpu_snapshot(),
            "benchmark": asdict(benchmark),
            "chat": conversation,
        }
    finally:
        await supervisor.stop()


def main() -> None:
    args = arguments()
    evidence = asyncio.run(run(args))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
