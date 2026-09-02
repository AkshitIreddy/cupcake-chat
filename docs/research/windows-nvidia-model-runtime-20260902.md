# Windows NVIDIA model-runtime review — 2026-09-02

This review used current first-party documentation to compare CupcakeAI's Windows/NVIDIA local model
experience with LM Studio, Hugging Face Hub discovery, and NVIDIA NIM. It informed the second-pass
model hub, lazy startup, memory safety, and local-runtime settings.

## Sources reviewed

- [LM Studio: idle TTL and auto-evict](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict)
- [LM Studio: headless and just-in-time loading](https://lmstudio.ai/docs/developer/core/headless)
- [LM Studio: model loading and memory estimates](https://lmstudio.ai/docs/cli/local-models/load)
- [LM Studio: model search and quantization selection](https://lmstudio.ai/docs/cli/local-models/get)
- [LM Studio: model download API](https://lmstudio.ai/docs/developer/rest/download)
- [Hugging Face Hub: HfApi model search](https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_api)
- [Hugging Face Hub: GGUF support](https://huggingface.co/docs/hub/en/gguf)
- [Hugging Face Hub: security scanning](https://huggingface.co/docs/hub/security)
- [NVIDIA NIM: model profiles and memory-aware selection](https://docs.nvidia.com/nim/large-language-models/latest/deployment/model-profiles-and-selection.html)
- [NVIDIA NIM: current model and hardware support matrix](https://docs.nvidia.com/nim/large-language-models/latest/reference/support-matrix.html)

## Product conclusions

1. Startup should open encrypted history first. A selected local model should load only when a local
   inference request actually needs it. This follows the useful part of LM Studio's JIT behavior
   without reintroducing LM Studio as a dependency.
2. App-managed local models should have an idle TTL and automatic unload enabled by default. The
   timer resets after use and users can disable or tune it.
3. Memory fit is not just model-file size. We reserve explicit RAM for Windows and VRAM for the
   desktop, account for runtime/KV overhead, classify reduced-context and hybrid paths distinctly,
   and fail clearly when RAM fallback is disabled.
4. Broad discovery and trusted installation are different security boundaries. CupcakeAI performs
   bounded, read-only Hugging Face searches for GGUF model cards. Community results cannot enter the
   signed managed-download pipeline; users review the upstream card first.
5. NVIDIA NIM stays a hosted provider catalog, not a local consumer-GPU runtime. A connected NIM
   account refreshes its live `/v1/models` catalog. Local NVIDIA inference remains Cupcake Local's
   verified llama.cpp CUDA pack.
6. NVIDIA's compatible / low-memory / incompatible model-profile categories support CupcakeAI's
   recommended / reduced-context / incompatible language. Hybrid CPU+GPU is an additional
   llama.cpp-specific state and is disclosed as slower.

## Implementation consequences

- `app.bootstrap` no longer scans hardware or autoloads the selected local model.
- local hardware scanning and CUDA pack work happen on demand;
- local loads enforce user-configured RAM/VRAM reserves and fallback policy;
- idle model eviction is configurable in Settings;
- the Models page includes live Hugging Face GGUF discovery plus provider-managed NVIDIA NIM
  discovery;
- community search is response-size, timeout, query-length, and result-count bounded;
- the encrypted unlock and workspace-opening states explain which resources are still asleep.
