# Ready-to-chat Windows research ledger — 2026-09-01

This ledger records the primary sources checked before implementing the app-owned password gate,
Windows/NVIDIA runtime setup, hosted-provider setup, and the broader signed local-model catalog. It
is an implementation input, not a claim that every listed model or service was installed or tested.

## Password and encrypted-profile boundary

1. [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html) — single-factor password
   length, Unicode, paste/password-manager support, blocklists, and rate limiting.
2. [NIST password guidance](https://pages.nist.gov/800-63-4/sp800-63b/passwords/) — user-facing
   password rules and usability.
3. [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
   — Argon2id selection, salts, and work-factor guidance.
4. [RFC 9106](https://www.rfc-editor.org/rfc/rfc9106.html) — Argon2id algorithm and parameter
   semantics.
5. [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
   — key lifecycle and separation of password verification from data-encryption keys.
6. [Microsoft CryptProtectData](https://learn.microsoft.com/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)
   — Windows DPAPI user-bound protection used by the existing profile and credential vault.

Decision: use a salted Argon2id verifier as an app lock; keep DPAPI as the separate at-rest
protection for the profile key and provider credentials. Sidecars do not start until setup or unlock
succeeds. CupcakeAI accepts 15–128 Unicode characters, permits paste, and rate-limits failures.

## Windows NVIDIA execution

7. [NVIDIA CUDA Installation Guide for Microsoft Windows](https://docs.nvidia.com/cuda/cuda-installation-guide-microsoft-windows/)
   — Windows prerequisites and driver/toolkit boundaries.
8. [NVIDIA CUDA Compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/) — driver and
   CUDA compatibility model.
9. [CUDA 13.0 release notes](https://docs.nvidia.com/cuda/archive/13.0.0/cuda-toolkit-release-notes/index.html)
   — CUDA 13 driver/runtime requirements.
10. [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases/tag/b10679) — pinned Windows
    CPU, Vulkan, CUDA 12.4, and CUDA 13.3 assets.
11. [llama.cpp server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
    — OpenAI-compatible local serving and runtime controls.
12. [llama.cpp build documentation](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md)
    — supported Windows acceleration backends.
13. [llama.cpp GGUF documentation](https://github.com/ggml-org/llama.cpp/blob/master/docs/gguf.md)
    — model container boundary.

Decision: retain the verified CPU baseline and side-by-side Vulkan/CUDA packs; activate CUDA 13 only
after the signed pack passes `--list-devices`. Model fit uses VRAM plus system RAM and can select
hybrid offload rather than treating VRAM as a hard all-or-nothing limit.

## Public, directly installable GGUF sources

14. [Qwen3 0.6B GGUF](https://huggingface.co/Qwen/Qwen3-0.6B-GGUF) — official Apache-2.0 Q8_0,
    32K context.
15. [Qwen3 1.7B GGUF](https://huggingface.co/Qwen/Qwen3-1.7B-GGUF) — official Apache-2.0 Q8_0.
16. [Qwen3 4B GGUF](https://huggingface.co/ggml-org/Qwen3-4B-GGUF) — llama.cpp-team conversion.
17. [Qwen3 8B GGUF](https://huggingface.co/Qwen/Qwen3-8B-GGUF) — official Apache-2.0 Q4_K_M.
18. [Qwen3 14B GGUF](https://huggingface.co/Qwen/Qwen3-14B-GGUF) — official Apache-2.0 Q4_K_M.
19. [Qwen3 30B-A3B GGUF](https://huggingface.co/Qwen/Qwen3-30B-A3B-GGUF) — official MoE
    Q4_K_M with 3.3B active parameters.
20. [IBM Granite 3.3 2B Instruct GGUF](https://huggingface.co/ibm-granite/granite-3.3-2b-instruct-GGUF)
    — official Apache-2.0 Q4_K_M.
21. [IBM Granite 3.3 8B Instruct GGUF](https://huggingface.co/ibm-granite/granite-3.3-8b-instruct-GGUF)
    — official Apache-2.0 Q4_K_M and 128K context.
22. [Ministral 3 3B Instruct GGUF](https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512-GGUF)
    — official Apache-2.0 Q4_K_M.
23. [Ministral 3 8B Instruct GGUF](https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512-GGUF)
    — official Apache-2.0 Q4_K_M and 256K context.
24. [Microsoft Phi-4 GGUF](https://huggingface.co/microsoft/phi-4-gguf) — official MIT Q4_K_S,
    14B dense model and 16K context.
25. [Hugging Face Hub repository API](https://huggingface.co/docs/hub/api) — immutable revision,
    sibling, byte-length, and LFS SHA-256 metadata used for catalog pinning.

Decision: catalog only public, direct-download artifacts with immutable revisions, exact lengths,
SHA-256 values, and a clear license. Gated Gemma/Meta artifacts and community-only conversions are
not presented as one-click installs until CupcakeAI has an explicit license/authentication flow.
Multimodal Ministral weights are listed for text chat only because their separate vision projector is
not part of the current install contract.

## Hosted provider catalogs

26. [OpenAI models](https://platform.openai.com/docs/models) — current OpenAI model catalog.
27. [Anthropic models overview](https://docs.anthropic.com/en/docs/about-claude/models/overview) —
    Claude families and identifiers.
28. [Google Gemini models](https://ai.google.dev/gemini-api/docs/models) — Gemini API catalog.
29. [xAI models](https://docs.x.ai/docs/models) — Grok model identifiers and capabilities.
30. [Mistral model catalog](https://docs.mistral.ai/getting-started/models/models_overview/) — hosted
    Mistral models.
31. [Cohere models](https://docs.cohere.com/docs/models) — Command and retrieval model catalog.
32. [NVIDIA API catalog](https://build.nvidia.com/models) — NVIDIA NIM discovery source.

Decision: hosted provider models stay dynamically discovered through the provider API where the API
supports it; credentials remain DPAPI-protected in the broker vault and never enter the repository,
catalog, screenshots, or evidence JSON.
