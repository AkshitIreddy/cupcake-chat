# CupcakeAI model intelligence research — 2026-09-03

## What the catalog counts mean

NVIDIA publishes several overlapping catalogs, so one number cannot truthfully represent every
NVIDIA model. The public Models page currently exposes 98 mixed-purpose entries, while the
authenticated OpenAI-compatible `GET /v1/models` probe for the configured test account returned 82
raw IDs on 2026-09-03. CupcakeAI conservatively removes known embedding, reranking, guard, vision,
image, audio, and other specialized endpoints from its text-chat picker; this explains why the old
UI showed 65 candidates. The product now labels that count **account-discoverable NIM chat
candidates**, not “all NVIDIA models.”

Primary catalog references:

- [NVIDIA Models catalog](https://build.nvidia.com/models)
- [NVIDIA hosted LLM API table](https://docs.api.nvidia.com/nim/reference/llm-apis)
- [NIM LLM API reference](https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html)
- [NIM support matrix](https://docs.nvidia.com/nim/large-language-models/latest/support-matrix.html)
- [NVIDIA API trial terms](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-api-trial-terms-of-service/)

Hugging Face is different: it is an open Hub with hundreds of thousands of repositories, not a
curated list of models guaranteed to run in Cupcake Local. CupcakeAI requests up to 240 current GGUF
search results per query, can accept up to 500 from the runtime, progressively renders 60 at a time,
and keeps gated/license/download metadata visible. This gives broad search without pretending every
repository is compatible or benchmarked.

- [Hugging Face Hub model search API](https://huggingface.co/docs/huggingface_hub/package_reference/hf_api#huggingface_hub.HfApi.list_models)
- [Hugging Face model cards](https://huggingface.co/docs/hub/model-cards)
- [Hugging Face model card metadata](https://huggingface.co/docs/hub/model-card-metadata)
- [GGUF documentation](https://huggingface.co/docs/hub/gguf)
- [Hub gated models](https://huggingface.co/docs/hub/models-gated)

## Verification policy

`/v1/models` identifies models but does not declare endpoint compatibility. CupcakeAI therefore does
not infer chat support merely from a fashionable model name. A NIM model is marked “Chat documented”
only when its exact current ID has an official NVIDIA Build model card/playground that uses the
hosted chat-completions route. Twenty current account IDs are pinned with their evidence URLs in
`providers/nvidia_nim.py`; unknown rows remain discoverable in Models but are hidden from the chat
picker by default.

The twenty documented IDs cover DeepSeek V4 Flash/Pro, Gemma 4, MiniMax M3, Mistral Large and
Mistral-Nemotron, Kimi K2.6/K3, the current Nemotron families, GPT-OSS 20B/120B, and Poolside
Laguna. Representative exact evidence:

- [DeepSeek V4 Pro](https://build.nvidia.com/deepseek-ai/deepseek-v4-pro-0813/modelcard)
- [DeepSeek V4 Flash](https://build.nvidia.com/deepseek-ai/deepseek-v4-flash-0731/modelcard)
- [Gemma 4 31B IT](https://build.nvidia.com/google/gemma-4-31b-it/modelcard)
- [MiniMax M3](https://build.nvidia.com/minimaxai/minimax-m3/modelcard)
- [Mistral-Nemotron](https://build.nvidia.com/mistralai/mistral-nemotron/modelcard)
- [Kimi K2.6](https://build.nvidia.com/moonshotai/kimi-k2.6/modelcard)
- [Kimi K3](https://build.nvidia.com/moonshotai/kimi-k3/modelcard)
- [Nemotron 3 Nano Omni](https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning/modelcard)
- [Nemotron 3 Super](https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b/modelcard)
- [Nemotron 3 Ultra](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b/modelcard)
- [Nemotron 3.5 Lightning](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/modelcard)
- [GPT-OSS 120B](https://build.nvidia.com/openai/gpt-oss-120b/modelcard)
- [GPT-OSS 20B](https://build.nvidia.com/openai/gpt-oss-20b/modelcard)
- [Poolside Laguna XS 2.1](https://build.nvidia.com/poolside/laguna-xs-2.1/modelcard)

## Cupcake ratings

Cupcakes are an evidence display, not a universal leaderboard. Comparing raw scores from different
harnesses as though they were one scalar would be misleading. Each capability keeps the benchmark
name and raw reported score in the UI tooltip. Ratings are capability-specific and provisional when
only one benchmark family is available.

The current mapping is intentionally coarse:

- 5 cupcakes: frontier result in the cited model-card cohort, usually around the top decile.
- 4.5 cupcakes: excellent, broadly competitive result.
- 4 cupcakes: strong result suitable for demanding work.
- 3–3.5 cupcakes: capable but with material gaps or mixed benchmark evidence.
- No rating: insufficient comparable evidence; absence is not a zero.

The first evidence-backed set covers DeepSeek V4 Pro/Flash, Gemma 4 31B, Mistral-Nemotron, Kimi
K2.6/K3, Nemotron 3 Super/Ultra, Nemotron 3.5 Lightning, Nemotron 3 Nano Omni, GPT-OSS 20B/120B, and
Laguna XS 2.1. It spans chat/instruction following, reasoning, coding, mathematics, tool use,
agentic work, vision, documents, computer use, speech, and long context. MiniMax M3 is classified by
documented capability but deliberately receives no cupcake score because its NVIDIA card says the
evaluation score is undisclosed.

Benchmark interpretation references:

- [SWE-bench](https://www.swebench.com/)
- [SWE-bench Verified](https://openai.com/index/introducing-swe-bench-verified/)
- [Terminal-Bench](https://www.tbench.ai/)
- [LiveCodeBench](https://livecodebench.github.io/)
- [GPQA paper](https://arxiv.org/abs/2311.12022)
- [MMLU-Pro paper](https://arxiv.org/abs/2406.01574)
- [MMMU benchmark](https://mmmu-benchmark.github.io/)
- [OSWorld benchmark](https://os-world.github.io/)
- [RULER long-context benchmark](https://arxiv.org/abs/2404.06654)
- [IFEval paper](https://arxiv.org/abs/2311.07911)
- [Tau-bench paper](https://arxiv.org/abs/2406.12045)

## Runtime and memory decision

The old 24 GB value was a static manual ceiling, not detected system capacity. Auto mode now uses a
fresh hardware sample at load time: `max(0, available system RAM - the user's Windows reserve)`.
Before the live sample reaches the UI, CupcakeAI shows a conservative estimate that reserves at
least 25% of physical RAM. The runtime rechecks the live number immediately before loading, so a
stale UI cannot overcommit memory. Manual mode remains available for users who explicitly want a
fixed ceiling.

VRAM spill to RAM is supported through llama.cpp layer placement, but it is deliberately labeled as
much slower than full-GPU placement. CUDA 13 remains the preferred verified Windows/NVIDIA pack;
CUDA 12, Vulkan, and CPU packs are fallbacks rather than parallel background startup work.
