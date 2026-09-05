# Local inference audit — Windows and NVIDIA

Date: 2026-09-05

This audit independently reviewed the current runtime, the preserved `v1.0.0` tree, the accepted
architecture decisions, the signed local-model catalog, and current primary documentation. It did
not start a model, acquire the GPU lock, mutate an owner profile, or launch the app. Hardware
detection used NVML only.

## Decision

Keep the signed, managed llama.cpp runtime-pack design as the production local GGUF lane. Prefer
CUDA 13 on a supported NVIDIA driver, then CUDA 12, Vulkan, and CPU. Treat every accelerated pack as
usable only after its installed `llama-server --list-devices` output proves the expected backend.
Use current free VRAM plus model weights, KV cache, and runtime-buffer estimates for preflight, pass
the requested reserve to llama.cpp `--fit-target`, and let llama.cpp's load-time fit remain
authoritative.

Windows ML with ONNX Runtime GenAI and the TensorRT RTX execution provider is a credible future lane
for ONNX-format models on Windows 11 24H2 and newer. It is not a drop-in replacement for the current
GGUF catalog. TensorRT-LLM's official build and install path remains Linux/container oriented, so a
native Windows TensorRT-LLM backend should not be promised.

## Evidence from this repository

### Observed

- `v1.0.0` has no managed local GGUF/CUDA serving path. Its model integration is the older
  provider/LangChain stack with PyTorch and Transformers dependencies.
- Current hardware detection reported Windows 11 build 26200, an NVIDIA GeForce RTX 4080 Laptop GPU,
  driver 581.29, 11.994 GiB total VRAM, and 11.331 GiB free VRAM at the instant sampled. System RAM
  was 31.628 GiB total and 15.225 GiB available. The GPU ownership file contained `no` and was not
  changed.
- Preserved headless evidence records a Qwen3 8B Q4_K_M run at 4096 context, about 5894 MiB GPU
  memory, 58% utilization, and roughly 65 tokens/second. That is useful runtime evidence, but it
  does not prove the packaged UI flow.
- Hardware detection previously discarded free VRAM and the load preflight used total VRAM. Another
  application could therefore make an unsafe load appear safe.
- Windows previously advertised Vulkan unconditionally, without even checking for the Vulkan loader.
- Runtime activation verified signed bytes but did not run the catalog-required device probe. A
  mislabeled or nonfunctional CUDA/Vulkan pack could become active.
- Load preflight compared only the GGUF file size with memory capacity. It omitted KV cache and
  runtime buffers. It also did not forward the user's VRAM reserve to llama.cpp's `--fit-target`.
- Direct runtime calls accepted negative reserve values, bypassing the intended safety margin.
- The application's “RAM ceiling” is a preflight refusal policy. It is not an operating-system or
  job-object limit on the child process.

### Implemented in this audit

- Added point-in-time `available_vram_gb` from NVML and the `nvidia-smi` fallback while retaining
  total VRAM separately.
- Advertise Vulkan only when the Windows Vulkan loader is present. Runtime pack activation still
  requires the stronger `--list-devices` probe.
- Reject activation when the installed executable cannot enumerate the backend named by its signed
  catalog entry.
- Estimate F16 K/V memory from the upstream layer, KV-head, and head-dimension shapes for all signed
  catalog models. The formula is `2 * layers * kv_heads * head_dim * 2 bytes` per token, plus ten
  percent headroom. Signed catalog metadata may override this. Unknown architectures use a
  conservative fallback.
- Include weights, KV cache, allocator/graph overhead, and host-memory headroom in recommendations
  and load refusal decisions.
- Refuse VRAM-only loading when free VRAM cannot be measured; total capacity is not treated as free
  capacity.
- Validate reserve arguments and pass the VRAM reserve through to llama.cpp `--fit-target` in MiB.

## Backend comparison

| Backend                   | Current primary-source evidence                                                                                                                                                                                                      | Product conclusion                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| llama.cpp CUDA 13         | llama.cpp supports CUDA builds, automatic/full GPU layers, device listing, and load-time fitting. NVIDIA defines CUDA 13.x minor-version compatibility at driver 580 or newer; CUDA 13.3's paired toolkit driver is 610.43 or newer. | First choice on this machine, but driver 581.29 is a compatibility-mode case. Require the real binary/device probe and a packaged load test.                          |
| llama.cpp CUDA 12         | Same managed llama.cpp surface, with NVIDIA's CUDA 12.x compatibility floor at driver 525 and below 580.                                                                                                                             | Retain as a signed fallback for older supported drivers and for CUDA 13 regressions.                                                                                  |
| llama.cpp Vulkan          | llama.cpp supports Vulkan and device enumeration. A loader file alone does not prove a working device.                                                                                                                               | Useful vendor-neutral fallback. Require `--list-devices`; do not infer it from Windows alone.                                                                         |
| llama.cpp CPU             | llama.cpp supports an explicit CPU path.                                                                                                                                                                                             | Safe baseline and recovery lane. Mark it slow; check available system RAM with the same full model estimate.                                                          |
| ONNX Runtime / Windows ML | Windows ML can dynamically select vendor execution providers on Windows 11 24H2+. ONNX Runtime GenAI supports Windows builds, and Windows ML exposes the NVIDIA TensorRT RTX EP. DirectML is in sustained engineering.               | Viable additional ONNX model lane. It needs a separate signed model format, tokenizer/generation integration, and tests; it cannot consume the existing GGUF catalog. |
| TensorRT RTX              | NVIDIA documents TensorRT RTX for native Windows deployment and ONNX Runtime integration. Its documentation directs LLM workloads through ORT GenAI/Windows ML and says it is not integrated with TensorRT-LLM.                      | Promising optimization under a Windows ML/ORT lane, not a standalone replacement for llama.cpp.                                                                       |
| TensorRT-LLM              | Official installation/build documentation specifies Linux x86_64/aarch64 and container workflows; the source build is large.                                                                                                         | Do not advertise native Windows TensorRT-LLM. A WSL/container service would violate the present native/offline packaging goals and add large operational cost.        |

## Memory and OOM policy

The preflight estimate is deliberately conservative and should be described as an estimate. GGUF
tensor placement, graph buffers, backend kernels, cache type, driver allocations, concurrent GPU
activity, and llama.cpp changes can alter the real peak. Recommendations use the context they
display. Load requests use the requested context, current free VRAM, the configured system/VRAM
reserves, and the signed artifact metadata. llama.cpp `--fit` and `--fit-target` make the final
placement decision.

The failure contract should remain explicit:

1. Refuse before launch if signed model metadata is unavailable, reserve values are invalid, free
   VRAM is unknown for VRAM-only mode, or the conservative estimate exceeds policy.
2. Let the managed runtime fit or offload only within the user's declared RAM fallback choice.
3. Surface load failures and exits as local-runtime errors with remediation: close GPU-heavy
   programs, lower context, select a smaller quantization/model, allow RAM fallback, or choose CPU.
4. Never describe the policy check as a hard RAM cap until Windows Job Object memory limits or an
   equivalent process-level enforcement mechanism exists.

## Primary-source ledger

All conclusions above distinguish documentation that was directly observed from product inferences
made from it.

| Source                                                                                                                          | Evidence used                                                            | Status                         |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------ |
| [llama.cpp server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)                             | `--n-gpu-layers`, `--fit`, `--fit-target`, `--fit-ctx`, server endpoints | Observed                       |
| [llama.cpp build guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md)                                        | Windows CUDA/Vulkan builds, devices, unified-memory behavior             | Observed                       |
| [llama.cpp multi-GPU guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/multi-gpu.md)                                | split modes and per-device placement                                     | Observed                       |
| [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases)                                                            | upstream runtime is fast-moving                                          | Observed                       |
| [CUDA minor-version compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html)          | driver floors for CUDA 12.x and 13.x                                     | Observed                       |
| [CUDA 13.3 release notes](https://docs.nvidia.com/cuda/pdf/CUDA_Toolkit_Release_Notes.pdf)                                      | CUDA 13.3 toolkit/driver versions and packaging change                   | Observed                       |
| [NVML device queries](https://docs.nvidia.com/deploy/nvml-api/group__nvmlDeviceQueries.html)                                    | total and free framebuffer memory are separately queryable               | Observed                       |
| [ONNX Runtime CUDA EP](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)                             | CUDA compatibility and `gpu_mem_limit` scope                             | Observed                       |
| [ONNX Runtime TensorRT EP](https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html)                     | partitioning, caching, timing/cache tradeoffs                            | Observed                       |
| [ONNX Runtime execution providers](https://onnxruntime.ai/docs/execution-providers/)                                            | provider selection architecture                                          | Observed                       |
| [ONNX Runtime DirectML EP](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html)                     | DirectML is in sustained engineering                                     | Observed                       |
| [ONNX Runtime on Windows](https://onnxruntime.ai/docs/get-started/with-windows.html)                                            | Windows deployment options                                               | Observed                       |
| [Windows ML overview](https://learn.microsoft.com/windows/ai/new-windows-ml/overview)                                           | dynamic EP distribution and Windows integration                          | Observed                       |
| [Windows ML supported execution providers](https://learn.microsoft.com/windows/ai/new-windows-ml/supported-execution-providers) | OS floor and NVIDIA TensorRT RTX availability                            | Observed                       |
| [Windows ML samples](https://learn.microsoft.com/windows/ai/new-windows-ml/samples)                                             | supported native integration patterns                                    | Observed                       |
| [ONNX Runtime GenAI installation](https://onnxruntime.ai/docs/genai/howto/install.html)                                         | Windows packages and API availability                                    | Observed                       |
| [ONNX Runtime GenAI source build](https://onnxruntime.ai/docs/genai/howto/build-from-source.html)                               | Windows DirectML and TensorRT RTX build lanes                            | Observed                       |
| [ONNX Runtime GenAI repository](https://github.com/microsoft/onnxruntime-genai)                                                 | project scope and active implementation surface                          | Observed                       |
| [TensorRT RTX EP](https://onnxruntime.ai/docs/execution-providers/TensorRTRTX-ExecutionProvider.html)                           | standalone EP direction and ABI packaging                                | Observed                       |
| [TensorRT RTX architecture](https://docs.nvidia.com/deeplearning/tensorrt-rtx/latest/architecture/architecture-overview.html)   | native runtime and engine architecture                                   | Observed                       |
| [TensorRT RTX quick start](https://docs.nvidia.com/deeplearning/tensorrt-rtx/latest/getting-started/quick-start-guide.html)     | Windows deployment workflow                                              | Observed                       |
| [TensorRT RTX porting guide](https://docs.nvidia.com/deeplearning/tensorrt-rtx/latest/getting-started/porting-guide.html)       | migration boundaries and unsupported integrations                        | Observed                       |
| [TensorRT RTX CPU AOT engines](https://docs.nvidia.com/deeplearning/tensorrt-rtx/latest/performance/cpu-aot.html)               | engine generation/deployment tradeoff                                    | Observed                       |
| [TensorRT-LLM installation](https://nvidia.github.io/TensorRT-LLM/installation/build-from-source-linux.html)                    | supported Linux/container build path and build footprint                 | Observed                       |
| [TensorRT-LLM repository](https://github.com/NVIDIA/TensorRT-LLM)                                                               | framework scope and deployment targets                                   | Observed                       |
| [Qwen3 0.6B config](https://huggingface.co/Qwen/Qwen3-0.6B/blob/main/config.json)                                               | 28 layers, 8 KV heads, 128 head dimension                                | Observed                       |
| [Qwen3 1.7B config](https://huggingface.co/Qwen/Qwen3-1.7B/blob/main/config.json)                                               | 28 layers, 8 KV heads, 128 head dimension                                | Observed                       |
| [Qwen3 4B config](https://huggingface.co/Qwen/Qwen3-4B/blob/main/config.json)                                                   | 36 layers, 8 KV heads, 128 head dimension                                | Observed                       |
| [Qwen3 8B config](https://huggingface.co/Qwen/Qwen3-8B/blob/main/config.json)                                                   | 36 layers, 8 KV heads, 128 head dimension                                | Observed                       |
| [Qwen3 14B config](https://huggingface.co/Qwen/Qwen3-14B/blob/main/config.json)                                                 | 40 layers, 8 KV heads, 128 head dimension                                | Observed                       |
| [Qwen3 30B-A3B config](https://huggingface.co/Qwen/Qwen3-30B-A3B/blob/main/config.json)                                         | MoE model has 48 layers and 4 KV heads                                   | Observed                       |
| [Granite 3.3 2B config](https://huggingface.co/ibm-granite/granite-3.3-2b-instruct/blob/main/config.json)                       | 40 layers, 8 KV heads, 64 inferred head dimension                        | Observed + inferred arithmetic |
| [Granite 3.3 8B config](https://huggingface.co/ibm-granite/granite-3.3-8b-instruct/blob/main/config.json)                       | 40 layers, 8 KV heads, 128 inferred head dimension                       | Observed + inferred arithmetic |
| [Ministral 3 3B params](https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512/blob/main/params.json)                    | 26 layers, 8 KV heads, 128 head dimension                                | Observed                       |
| [Ministral 3 8B params](https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512/blob/main/params.json)                    | 34 layers, 8 KV heads, 128 head dimension                                | Observed                       |
| [Phi-4 config](https://huggingface.co/microsoft/phi-4/blob/main/config.json)                                                    | 40 layers, 10 KV heads, 128 inferred head dimension                      | Observed + inferred arithmetic |

The backend ordering and future-lane recommendation are inferences from these primary sources plus
this product's signed-artifact and offline-first constraints. They are not vendor benchmark claims.
Throughput and peak memory must be measured again in the real packaged executable after rebuilding
the modified sidecar.
