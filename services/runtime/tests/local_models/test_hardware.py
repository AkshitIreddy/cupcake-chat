# pyright: reportPrivateUsage=false

from pathlib import Path
from types import SimpleNamespace
from typing import NoReturn

import pytest

import cupcake_runtime.local_models.hardware as hardware_module


def test_nvidia_prefers_canonical_windows_system_executable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    executable = tmp_path / "System32" / "nvidia-smi.exe"
    executable.parent.mkdir()
    executable.write_bytes(b"")
    monkeypatch.setattr(hardware_module.os, "name", "nt")
    monkeypatch.setattr(hardware_module, "_nvidia_nvml", lambda: (None, None, None, None))
    monkeypatch.setenv("SYSTEMROOT", str(tmp_path))

    def missing_executable(_name: str) -> None:
        return None

    captured: dict[str, object] = {}

    def completed_process(*_args: object, **kwargs: object) -> SimpleNamespace:
        captured.update(kwargs)
        return SimpleNamespace(stdout="NVIDIA GeForce RTX 4080 Laptop GPU, 12282, 8192, 581.29\n")

    monkeypatch.setattr(hardware_module.shutil, "which", missing_executable)
    monkeypatch.setattr(
        hardware_module.subprocess,
        "run",
        completed_process,
    )

    name, vram, available_vram, driver = hardware_module._nvidia()
    assert name == "NVIDIA GeForce RTX 4080 Laptop GPU"
    assert vram is not None and abs(vram - 12282 / 1024) < 1e-9
    assert available_vram is not None and abs(available_vram - 8) < 1e-9
    assert driver == "581.29"
    assert captured["creationflags"] == hardware_module.subprocess.CREATE_NO_WINDOW


def test_nvidia_prefers_in_process_nvml_over_child_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        hardware_module,
        "_nvidia_nvml",
        lambda: ("NVIDIA GeForce RTX 4090", 24.0, 18.5, "610.43"),
    )

    def child_process_must_not_run(*_args: object, **_kwargs: object) -> NoReturn:
        pytest.fail("nvidia-smi should not be spawned after NVML works")

    monkeypatch.setattr(hardware_module.subprocess, "run", child_process_must_not_run)

    assert hardware_module._nvidia() == (
        "NVIDIA GeForce RTX 4090",
        24.0,
        18.5,
        "610.43",
    )


def test_hardware_profile_includes_device_identity_and_installed_packs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def memory() -> tuple[float, float]:
        return 32.0, 24.0

    def nvidia() -> tuple[str, float, float, str]:
        return "NVIDIA GeForce RTX 4070", 12.0, 9.25, "555.99"

    def features() -> tuple[str, ...]:
        return "avx", "avx2"

    def windows_identity() -> tuple[str, str]:
        return "Windows 11 10.0.26100", "26100"

    def disk_usage(_path: Path) -> SimpleNamespace:
        return SimpleNamespace(free=500 * 2**30)

    monkeypatch.setattr(hardware_module, "_memory", memory)
    monkeypatch.setattr(
        hardware_module,
        "_nvidia",
        nvidia,
    )
    monkeypatch.setattr(hardware_module, "_cpu_features", features)
    monkeypatch.setattr(hardware_module, "_windows_identity", windows_identity)
    monkeypatch.setattr(hardware_module.platform, "system", lambda: "Windows")
    monkeypatch.setattr(hardware_module.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(hardware_module.platform, "processor", lambda: "Test CPU")
    monkeypatch.setattr(hardware_module.shutil, "disk_usage", disk_usage)
    monkeypatch.setattr(hardware_module.os, "name", "nt")
    monkeypatch.setattr(hardware_module, "_vulkan_available", lambda: True)

    profile = hardware_module.detect_hardware(
        tmp_path, installed_acceleration_packs=("cuda-12", "cpu", "cuda-12")
    )

    assert profile.architecture == "AMD64"
    assert profile.cpu_name == "Test CPU"
    assert profile.cpu_features == ("avx", "avx2")
    assert profile.windows_build == "26100"
    assert profile.installed_acceleration_packs == ("cpu", "cuda-12")
    assert profile.vram_gb == 12.0
    assert profile.available_vram_gb == 9.25


def test_windows_does_not_advertise_vulkan_without_a_loader(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(hardware_module, "_memory", lambda: (16.0, 12.0))
    monkeypatch.setattr(hardware_module, "_nvidia", lambda: (None, None, None, None))
    monkeypatch.setattr(hardware_module, "_vulkan_available", lambda: False)
    monkeypatch.setattr(hardware_module, "_cpu_features", lambda: ())
    monkeypatch.setattr(hardware_module, "_windows_identity", lambda: ("Windows 11", "26100"))
    monkeypatch.setattr(hardware_module.platform, "system", lambda: "Windows")
    monkeypatch.setattr(hardware_module.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(hardware_module.platform, "processor", lambda: "Test CPU")

    def disk_usage(_path: Path) -> SimpleNamespace:
        return SimpleNamespace(free=100 * 2**30)

    monkeypatch.setattr(
        hardware_module.shutil,
        "disk_usage",
        disk_usage,
    )
    monkeypatch.setattr(hardware_module.os, "name", "nt")

    profile = hardware_module.detect_hardware(tmp_path)

    assert "vulkan" not in profile.acceleration
