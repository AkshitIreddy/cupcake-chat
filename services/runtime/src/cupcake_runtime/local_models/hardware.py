"""Best-effort local hardware detection with no mandatory third-party package."""

from __future__ import annotations

import os
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import cast

from .types import HardwareProfile


def _memory() -> tuple[float, float]:
    try:
        import psutil

        memory = psutil.virtual_memory()
        return memory.total / 2**30, memory.available / 2**30
    except ImportError:
        sysconf = cast(Callable[[str], int] | None, getattr(os, "sysconf", None))
        if callable(sysconf):
            page = sysconf("SC_PAGE_SIZE")
            total = sysconf("SC_PHYS_PAGES") * page / 2**30
            available = sysconf("SC_AVPHYS_PAGES") * page / 2**30
            return total, available
        return 0.0, 0.0


def _nvidia() -> tuple[str | None, float | None, str | None]:
    executable = shutil.which("nvidia-smi")
    if not executable:
        return None, None, None
    try:
        result = subprocess.run(
            [
                executable,
                "--query-gpu=name,memory.total,driver_version",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        name, memory, driver = result.stdout.splitlines()[0].rsplit(",", 2)
        return name.strip(), float(memory.strip()) / 1024, driver.strip()
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None, None, None


def detect_hardware(data_directory: Path) -> HardwareProfile:
    total, available = _memory()
    gpu, vram, driver = _nvidia()
    acceleration: list[str] = []
    if gpu:
        acceleration.append("cuda")
    if os.name == "nt":
        acceleration.append("vulkan")
    elif os.uname().sysname == "Darwin":
        acceleration.append("metal")
    disk = shutil.disk_usage(data_directory if data_directory.exists() else data_directory.parent)
    return HardwareProfile(
        total,
        available,
        gpu,
        vram,
        os.cpu_count() or 1,
        tuple(acceleration),
        disk.free / 2**30,
        driver,
    )
