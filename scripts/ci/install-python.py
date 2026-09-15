#!/usr/bin/env python3
"""Install the runtime and the validation toolchain in an isolated CI interpreter."""

from __future__ import annotations

import pathlib
import subprocess
import sys


ROOT = pathlib.Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "services" / "runtime"


def run(*args: str) -> None:
    print("\n>", sys.executable, "-m", *args, flush=True)
    subprocess.run([sys.executable, "-m", *args], cwd=ROOT, check=True)


if not (RUNTIME / "pyproject.toml").is_file():
    raise SystemExit("services/runtime/pyproject.toml is required for the Python CI lane")

run("pip", "install", "--disable-pip-version-check", "--upgrade", "pip==26.2.1")
if sys.platform == "linux":
    # Hosted Linux runners have no GPU. Avoid downloading several GB of CUDA
    # libraries through Docling's Torch dependency before tests can even start.
    run("pip", "install", "-r", str(ROOT / "scripts/ci/requirements-cpu.txt"))
run(
    "pip",
    "install",
    "--disable-pip-version-check",
    "-e",
    f"{RUNTIME}[documents,durability,providers,sqlcipher,test]",
)
run(
    "pip",
    "install",
    "--disable-pip-version-check",
    "pyright==1.1.411",
    "pytest==8.4.2",
    "pytest-asyncio==0.26.0",
    "ruff==0.16.5",
)
