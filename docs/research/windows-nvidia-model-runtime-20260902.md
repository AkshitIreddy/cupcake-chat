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

## 2026-09-03 discovery and onboarding pass

The follow-up compared the rendered CupcakeAI flows with additional first-party material rather than
treating one search page or one screenshot as the full benchmark:

- [LM Studio: discover and download models](https://beta.lmstudio.ai/docs/app/basics/download-model)
- [LM Studio: model catalog](https://lmstudio.ai/models)
- [LM Studio CLI: search](https://lmstudio.ai/docs/cli/local-models/get)
- [LM Studio CLI: list installed models](https://lmstudio.ai/docs/cli/local-models/ls)
- [LM Studio REST: list models](https://beta.lmstudio.ai/docs/developer/rest/list)
- [LM Studio: model.yaml metadata](https://beta.lmstudio.ai/docs/app/modelyaml)
- [Hugging Face Hub: model repository documentation](https://huggingface.co/docs/hub/models)
- [Hugging Face Hub: model cards](https://huggingface.co/docs/hub/model-cards)
- [NVIDIA NIM: OpenAI-compatible API reference](https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html)
- [NVIDIA NIM: getting started](https://docs.nvidia.com/nim/large-language-models/latest/get-started/index.html)
- [NVIDIA NIM: architecture](https://docs.nvidia.com/nim/large-language-models/latest/reference/architecture.html)
- [Microsoft Windows apps: usability](https://learn.microsoft.com/en-us/windows/apps/design/usability/)
- [Microsoft Windows apps: accessibility overview](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-overview)
- [Microsoft Windows apps: dialogs and flyouts](https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/dialogs-and-flyouts/)
- [Microsoft Windows apps: in-app help](https://learn.microsoft.com/en-us/windows/apps/design/in-app-help/guidelines-for-app-help)

This pass changed the implementation in four specific ways. Hub discovery now accepts family
keywords, publisher/model identifiers, and pasted Hugging Face URLs, retrieves up to 120 bounded
results, and renders them progressively instead of implying that the first 30 are the entire Hub.
Connected NVIDIA NIM inventory is presented separately and consumes the top-level `models` payload
returned by the native provider bridge. First-run setup uses a replayable, state-aware walkthrough
with profile and route readiness instead of a static slideshow. Finally, customization and modal
composition follow Windows guidance: centered predictable dialogs, restrained overlays, explicit
security choices, reduced-motion support, and wallpapers that preserve readable negative space.
