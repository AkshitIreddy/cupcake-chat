# CupcakeAI Windows local-runtime decisions — 2026-09-01

Scope: Windows 10/11 x64 with an NVIDIA GPU. These decisions are based on current primary sources
and were rechecked before the corrective implementation.

## llama.cpp memory behavior

- [`llama-server` arguments](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
  document `--n-gpu-layers auto`, automatic `--fit` behavior, and `--fit-target` VRAM headroom.
- [llama.cpp multi-GPU documentation](https://github.com/ggml-org/llama.cpp/blob/master/docs/multi-gpu.md)
  confirms that layers not assigned to a GPU remain CPU-resident. A model therefore does not need to
  fail merely because its full weights exceed dedicated VRAM; it can run as a slower hybrid VRAM +
  system-RAM load when total memory is sufficient.
- [llama.cpp build documentation](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md)
  documents `GGML_CUDA_ENABLE_UNIFIED_MEMORY` for Linux. CupcakeAI does not claim that environment
  variable as its Windows solution. On Windows, the NVIDIA driver's system-memory fallback setting
  remains driver-controlled.

Implementation decision: CupcakeAI launches its managed server with GPU layers set to `auto`,
`--fit on`, and a 1024 MiB fit target. The Models page describes GPU-first, hybrid, CPU-heavy, and
reduced-context outcomes and warns that RAM fallback is slower.

## CUDA 13 on Windows

- [NVIDIA CUDA minor-version compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html)
  requires a Windows driver from the CUDA 13-compatible driver family (580 or newer).
- [CUDA Installation Guide for Microsoft Windows](https://docs.nvidia.com/cuda/pdf/CUDA_Installation_Guide_Windows.pdf)
  describes the Windows toolkit/driver boundary.
- [CUDA 13.0 release notes](https://docs.nvidia.com/cuda/archive/13.0.0/cuda-toolkit-release-notes/index.html)
  note that the toolkit no longer bundles a display driver.

Implementation decision: the signed Cupcake Local CUDA 13 pack bundles and verifies the exact
llama.cpp runtime companions (`cudart64_13.dll`, `cublas64_13.dll`, `cublasLt64_13.dll`, and
`ggml-cuda.dll`) while treating the NVIDIA display driver as a prerequisite. The disposable test
profile contains the verified `b10679` CUDA 13 pack and records it as active.

## Hidden desktop acceptance

- [Tauri `WebviewWindowBuilder::visible`](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html)
  supports creating the window hidden.
- [Microsoft WebView2 DevTools Protocol guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/debug-visual-studio-code)
  documents enabling the Chromium DevTools Protocol for WebView2.
- [Playwright `connectOverCDP`](https://playwright.dev/docs/api/class-browsertype) can attach to
  Chromium-compatible CDP endpoints, with lower fidelity than Playwright's native protocol.

Implementation decision: the packaged acceptance path uses Tauri's hidden window mode, WebView2 CDP,
and a disposable profile under `E:\temp`. It checks that the task-owned process has no visible
top-level window before browser automation attaches.

## Encrypted-workspace unlock

- [Microsoft Data Protection API (`CryptUnprotectData`)](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata)
  binds protected data to the same Windows logon credentials and normally the same computer.

Implementation decision: the unlock screen truthfully describes the Windows session as the unlock
factor. It does not pretend that an unconfigured second password is the source of the existing
SQLCipher and object-store encryption.
