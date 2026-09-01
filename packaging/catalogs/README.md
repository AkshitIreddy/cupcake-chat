# Cupcake Local local-candidate catalogs

These signed catalogs are metadata inputs for private corrective testing. They are not production
trust roots and do not establish that a model has been downloaded, loaded, benchmarked, or accepted.

`cupcake-local-runtime-v1.json` pins the official llama.cpp `b10679` Windows x64 CPU asset and its
source revision. GitHub release API metadata reported archive digest
`c0dec4dfb52919e17f0a108a94bfbe877c67d77825145079e7703fc84f63986e`; a separate HTTPS download on
2026-08-28 produced the same SHA-256. The catalog additionally pins all 51 extracted files.

Primary provenance:

- Release: <https://github.com/ggml-org/llama.cpp/releases/tag/b10679>
- Asset:
  <https://github.com/ggml-org/llama.cpp/releases/download/b10679/llama-b10679-bin-win-cpu-x64.zip>
- Source revision:
  <https://github.com/ggml-org/llama.cpp/commit/50f068ffffc3e0e4c9c2e4139281c6075224f429>
- Release API: <https://api.github.com/repos/ggml-org/llama.cpp/releases/378714505>

The `cupcake-local-rc-2026-08` Ed25519 key is a local release-candidate trust root only. It is not a
production key and must not be reused for a published release. Its ignored private half is stored at
`.secrets/cupcake-local-rc-2026-08-ed25519.pem` in the local workspace. The committed key file
contains only the raw 32-byte public key encoded as base64.

The runtime catalog contains runtime executables and DLLs only. The separate
`cupcake-local-models-v1.json` catalog contains installable-model metadata only; the packaging
pipeline rejects every staged `.gguf` file. The public-key document also sets minimum accepted
runtime and model catalog versions so a correctly signed older catalog cannot silently roll back the
local candidate.

## Installable model catalog

`cupcake-local-models-v1.json` is signed by the same local-candidate key and currently records 11
public, directly downloadable artifacts from upstream publishers or the llama.cpp team:

- Qwen3 0.6B Q8_0; Qwen3 1.7B Q8_0; Qwen3 4B, 8B, and 14B Q4_K_M;
- IBM Granite 3.3 2B and 8B Instruct Q4_K_M;
- Mistral Ministral 3 3B and 8B Instruct Q4_K_M for text chat;
- Microsoft Phi-4 14B Q4_K_S;
- Qwen3 30B-A3B Q4_K_M for system-RAM plus GPU hybrid offload.

Each entry pins an immutable Hugging Face source revision, exact filename/byte length/SHA-256,
Apache license and source, parameter count, quantization, architecture, context choices, capability
and task tags, and minimum Cupcake Local runtime requirements. Larger entries explicitly warn when
reduced context or hybrid offload may be required. The Ministral entries do not claim vision because
their separate projector files are outside this text-model contract. Gated models are omitted until
the product has explicit upstream-license and token UX. Device ranking remains runtime-derived;
catalog presence is not a compatibility promise.

## Optional acceleration packs

The same signed catalog contains three download-only packs. None is copied into the installer:

- **Vulkan:** `llama-b10679-bin-win-vulkan-x64.zip`, SHA-256
  `d288a375a324f650a587d3b876afe692ca3586110f20b863fadbe91dd3b93469`. It requires a Vulkan-capable
  NVIDIA, AMD, or Intel GPU/iGPU and a current vendor graphics driver. CupcakeAI must successfully
  run `llama-server.exe --list-devices` before activating it.
- **CUDA 12.4:** `llama-b10679-bin-win-cuda-12.4-x64.zip`, SHA-256
  `46e8c7f80b540befb10625f20c54b54777857e6c2df51c349312ccfb4a0a83fb`, plus the required
  `cudart-llama-bin-win-cuda-12.4-x64.zip`, SHA-256
  `8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6`. It requires a supported NVIDIA
  GPU and Windows driver 551.61 or newer. The companion CUDA DLLs are governed by the
  [NVIDIA CUDA Toolkit EULA](https://docs.nvidia.com/cuda/eula/index.html), which must be disclosed
  and accepted before download.
- **CUDA 13.3:** `llama-b10679-bin-win-cuda-13.3-x64.zip`, SHA-256
  `2936f7230732df0dda2070960a940a7ca69d4debbd5edff4a1b98c2dad339efb`, plus the required
  `cudart-llama-bin-win-cuda-13.3-x64.zip`, SHA-256
  `1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e`. It is the preferred NVIDIA
  pack when NVML reports Windows driver 580.00 or newer and the installed runtime independently
  passes `llama-server.exe --list-devices`. Its companion DLLs have the same explicit NVIDIA CUDA
  Toolkit EULA acceptance boundary as the CUDA 12.4 pack.

The CPU pack remains the safe bundled baseline and rollback target. Optional packs are installed
side-by-side, verified before activation, and can roll back without replacing or deleting CPU.
