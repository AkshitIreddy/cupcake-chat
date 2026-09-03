# CupcakeAI model intelligence research — 2026-09-03

## What the catalog counts mean

NVIDIA publishes several overlapping catalogs, so one number cannot truthfully represent every
NVIDIA model. The public Models page currently exposes 98 mixed-purpose entries, while the
authenticated OpenAI-compatible `GET /v1/models` qualification for the configured test account
returned 64 bounded text candidates on 2026-09-03. CupcakeAI conservatively removes known
embedding, reranking, guard, image-generation, audio, and other specialized endpoints. The default
product surface no longer shows that whole account inventory: it shows only the small qualified
shortlist described below.

Primary catalog references:

- [NVIDIA Models catalog](https://build.nvidia.com/models)
- [NVIDIA hosted LLM API table](https://docs.api.nvidia.com/nim/reference/llm-apis)
- [NIM LLM API reference](https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html)
- [NIM support matrix](https://docs.nvidia.com/nim/large-language-models/latest/support-matrix.html)
- [NVIDIA API trial terms](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-api-trial-terms-of-service/)

Hugging Face is different: it is an open Hub with hundreds of thousands of repositories, not a
curated list of models guaranteed to run in Cupcake Local. CupcakeAI now keeps Hub search off by
default. A user must enable **Search Hugging Face too** and type at least two characters; the app
then requests at most 48 current GGUF cards. These remain model-card links rather than pretending
every community repository is compatible, complete, or installable.

- [Hugging Face Hub model search API](https://huggingface.co/docs/huggingface_hub/package_reference/hf_api#huggingface_hub.HfApi.list_models)
- [Hugging Face model cards](https://huggingface.co/docs/hub/model-cards)
- [Hugging Face model card metadata](https://huggingface.co/docs/hub/model-card-metadata)
- [GGUF documentation](https://huggingface.co/docs/hub/gguf)
- [Hub gated models](https://huggingface.co/docs/hub/models-gated)

## Verification policy

`/v1/models` identifies models but does not declare endpoint compatibility. CupcakeAI therefore does
not infer chat support merely from a fashionable model name. Twenty exact IDs retain official model
card evidence in `providers/nvidia_nim.py`, but documentation is not called an endpoint test. The
ordinary Models page and picker expose only IDs that also passed the bounded connected-account chat
probe. Unknown rows remain internal catalog metadata and never receive an “unverified” suffix in a
user-facing name.

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

## Qualification result and why the cupcake score was removed

A one-token chat probe ran against every proposed NIM shortlist entry through the configured owner
account. Eight passed and are allowed into the default UI: Nemotron 3 Ultra, Nemotron 3 Super,
Nemotron 3.5 Lightning, Nemotron 3 Nano Omni, GPT-OSS 20B, Laguna XS 2.1, Muse Glimmer 30B, and
Mistral-Nemotron. Kimi K3, DeepSeek V4 Pro/Flash, and Gemma 4 timed out during this bounded run;
Kimi K2.6 returned 404; GPT-OSS 120B was not in the connected catalog. Those entries remain useful
research evidence but are excluded from the ordinary picker until they pass a later qualification.

The synthetic cupcake benchmark score has been removed. The upstream cards use different harness
versions, prompting, tool policies, and model configurations, so collapsing those values into one
decorative scalar looked more precise than the evidence permits. Cards now show plain task labels,
size tier, route, complete curated descriptions, and an explicit endpoint-tested badge where the
bounded probe passed.

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
