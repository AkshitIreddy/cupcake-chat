# Cupcake Local release-candidate catalog

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

This catalog contains runtime executables and DLLs only. It contains no model records and the
packaging pipeline rejects any staged `.gguf` file.

## Optional acceleration packs

The same signed catalog contains two download-only packs. Neither is copied into the installer:

- **Vulkan:** `llama-b10679-bin-win-vulkan-x64.zip`, SHA-256
  `d288a375a324f650a587d3b876afe692ca3586110f20b863fadbe91dd3b93469`. It requires a Vulkan-capable
  NVIDIA, AMD, or Intel GPU/iGPU and a current vendor graphics driver. CUPCAKEAGI must successfully
  run `llama-server.exe --list-devices` before activating it.
- **CUDA 12.4:** `llama-b10679-bin-win-cuda-12.4-x64.zip`, SHA-256
  `46e8c7f80b540befb10625f20c54b54777857e6c2df51c349312ccfb4a0a83fb`, plus the required
  `cudart-llama-bin-win-cuda-12.4-x64.zip`, SHA-256
  `8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6`. It requires a supported NVIDIA
  GPU and Windows driver 551.61 or newer. The companion CUDA DLLs are governed by the
  [NVIDIA CUDA Toolkit EULA](https://docs.nvidia.com/cuda/eula/index.html), which must be disclosed
  and accepted before download.

The CPU pack remains the safe bundled baseline and rollback target. Optional packs are installed
side-by-side, verified before activation, and can roll back without replacing or deleting CPU.
