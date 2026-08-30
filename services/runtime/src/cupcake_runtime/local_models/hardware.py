"""Best-effort local hardware detection with no mandatory third-party package."""

from __future__ import annotations

import ctypes
import os
import platform
import shutil
import subprocess
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from typing import Any, cast

from .types import HardwareProfile


class _NvmlMemory(ctypes.Structure):
    _fields_ = [
        ("total", ctypes.c_ulonglong),
        ("free", ctypes.c_ulonglong),
        ("used", ctypes.c_ulonglong),
    ]


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


def _nvml_candidates() -> tuple[Path, ...]:
    if os.name != "nt":
        return ()
    candidates: list[Path] = []
    system_root = os.environ.get("SYSTEMROOT") or os.environ.get("WINDIR")
    if system_root:
        candidates.append(Path(system_root) / "System32" / "nvml.dll")
    program_files = os.environ.get("PROGRAMW6432") or os.environ.get("PROGRAMFILES")
    if program_files:
        candidates.append(Path(program_files) / "NVIDIA Corporation" / "NVSMI" / "nvml.dll")
    return tuple(dict.fromkeys(candidates))


def _nvidia_nvml() -> tuple[str | None, float | None, str | None]:
    """Query the trusted NVIDIA driver DLL without spawning a child process.

    Packaged desktop processes run in a Windows Job, where creating a second
    process such as ``nvidia-smi.exe`` can be denied. NVML is the supported API
    beneath nvidia-smi and DCH drivers place it in System32, so it is both more
    reliable in the sandbox and a narrower hardware-discovery boundary.
    """

    if os.name != "nt":
        return None, None, None
    loader = getattr(ctypes, "WinDLL", None)
    if loader is None:
        return None, None, None
    for candidate in _nvml_candidates():
        if not candidate.is_file():
            continue
        initialized = False
        shutdown: Any = None
        try:
            library = loader(str(candidate))
            init = library.nvmlInit_v2
            init.restype = ctypes.c_int
            shutdown = library.nvmlShutdown
            shutdown.restype = ctypes.c_int
            get_count = library.nvmlDeviceGetCount_v2
            get_count.argtypes = [ctypes.POINTER(ctypes.c_uint)]
            get_count.restype = ctypes.c_int
            get_handle = library.nvmlDeviceGetHandleByIndex_v2
            get_handle.argtypes = [ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)]
            get_handle.restype = ctypes.c_int
            get_name = library.nvmlDeviceGetName
            get_name.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint]
            get_name.restype = ctypes.c_int
            get_memory = library.nvmlDeviceGetMemoryInfo
            get_memory.argtypes = [ctypes.c_void_p, ctypes.POINTER(_NvmlMemory)]
            get_memory.restype = ctypes.c_int
            get_driver = library.nvmlSystemGetDriverVersion
            get_driver.argtypes = [ctypes.c_char_p, ctypes.c_uint]
            get_driver.restype = ctypes.c_int
            if init() != 0:
                continue
            initialized = True
            count = ctypes.c_uint()
            if get_count(ctypes.byref(count)) != 0 or count.value == 0:
                continue
            driver_buffer = ctypes.create_string_buffer(80)
            driver = (
                driver_buffer.value.decode("ascii", errors="replace").strip()
                if get_driver(driver_buffer, len(driver_buffer)) == 0
                else None
            )
            devices: list[tuple[str, float]] = []
            for index in range(count.value):
                handle = ctypes.c_void_p()
                if get_handle(index, ctypes.byref(handle)) != 0:
                    continue
                name_buffer = ctypes.create_string_buffer(96)
                memory = _NvmlMemory()
                if get_name(handle, name_buffer, len(name_buffer)) != 0:
                    continue
                if get_memory(handle, ctypes.byref(memory)) != 0:
                    continue
                devices.append(
                    (
                        name_buffer.value.decode("utf-8", errors="replace").strip(),
                        memory.total / 2**30,
                    )
                )
            if devices:
                name, vram = max(devices, key=lambda item: item[1])
                return name, vram, driver
        except (AttributeError, OSError, TypeError, ValueError):
            continue
        finally:
            if initialized and shutdown is not None:
                with suppress(AttributeError, OSError):
                    shutdown()
    return None, None, None


def _nvidia() -> tuple[str | None, float | None, str | None]:
    detected = _nvidia_nvml()
    if detected[0]:
        return detected
    executable: str | None = None
    if os.name == "nt":
        system_root = os.environ.get("SYSTEMROOT") or os.environ.get("WINDIR")
        if system_root:
            system_executable = Path(system_root) / "System32" / "nvidia-smi.exe"
            if system_executable.is_file():
                executable = str(system_executable)
    executable = executable or shutil.which("nvidia-smi")
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


def _cpu_features() -> tuple[str, ...]:
    """Return a conservative set of instruction features we can prove locally."""

    features: set[str] = set()
    if os.name == "nt":
        try:
            import ctypes

            checks = {
                "sse3": 13,
                "cmpxchg16b": 14,
                "xsave": 17,
                "avx": 18,
            }
            kernel32 = ctypes.windll.kernel32
            for name, feature_id in checks.items():
                if kernel32.IsProcessorFeaturePresent(feature_id):
                    features.add(name)
        except (AttributeError, OSError):
            pass
    else:
        try:
            for line in Path("/proc/cpuinfo").read_text(encoding="utf-8").splitlines():
                if line.casefold().startswith(("flags", "features")) and ":" in line:
                    features.update(line.split(":", 1)[1].strip().casefold().split())
                    break
        except OSError:
            pass
    return tuple(sorted(features))


def _windows_identity() -> tuple[str | None, str | None]:
    if os.name != "nt":
        return None, None
    release, version, _service_pack, _type = platform.win32_ver()
    build = version.rsplit(".", 1)[-1] if version else None
    display = " ".join(part for part in (release, version) if part) or None
    return display, build


def detect_hardware(
    data_directory: Path, *, installed_acceleration_packs: tuple[str, ...] = ()
) -> HardwareProfile:
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
    windows_version, windows_build = _windows_identity()
    processor = platform.processor().strip() or os.environ.get("PROCESSOR_IDENTIFIER") or None
    return HardwareProfile(
        total,
        available,
        gpu,
        vram,
        os.cpu_count() or 1,
        tuple(acceleration),
        disk.free / 2**30,
        driver,
        platform.system() or None,
        platform.machine() or None,
        processor,
        _cpu_features(),
        windows_version,
        windows_build,
        tuple(sorted(set(installed_acceleration_packs))),
    )
