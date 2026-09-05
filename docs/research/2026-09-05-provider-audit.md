# Provider adapter audit — 2026-09-05

## Scope and method

This audit traced the packaged chat path from `RuntimeService` through
`CupcakeAgentEngine` and Pydantic AI, then compared the retained direct adapter
normalizers against current official API documentation. No credential, live API,
GUI, or GPU call was used. Provider lists and streams were exercised with bounded
recorded fixtures. The current packaged route is the authority for capability
claims; a feature present in a vendor model but absent from that route is not
advertised.

## Findings implemented

- **Binary input now reaches the real model route.** Broker-staged source bytes are
  persisted in the existing content-addressed object store, linked by the generated
  retrieval source ID, included in backup/GC reachability, re-read only after project
  and conversation ownership checks, and converted to Pydantic `BinaryContent`.
  Renderer paths, provider URLs, and client-supplied bytes are never accepted.
- **Binary input is fail-closed.** Only JPEG, PNG, WebP, and PDF are eligible. The
  claimed MIME type is checked against the stored bytes, each inline object is capped
  at 20 MiB, the provider request is capped at 24 MiB total, SVG/HTML/unknown active
  formats are excluded, and extracted untrusted text remains the fallback where a
  model or transport cannot accept the binary form.
- **The deletion boundary is narrow.** Ingestion deletes only the broker-staged copy
  after digest and root checks. The owner's ordinary source path is never passed to
  the Python runtime and is not deleted.
- **Current model descriptors replace stale aliases.** Limits, reasoning choices,
  modalities, and prices are sourced from current model pages. Cohere Command A+
  native vision/reasoning is intentionally hidden because Pydantic AI 2.35.3's
  Cohere transport does not yet encode those inputs or controls.
- **Reasoning reaches the transport.** xAI now uses the OpenAI-compatible
  `reasoning_effort` setting on the packaged route; Mistral exposes only its
  documented `none`/`high` choices; Claude 5 uses adaptive thinking plus
  `output_config.effort`; incompatible sampling temperature is omitted for Claude 5
  and reasoning OpenAI/xAI calls.
- **Continuity is honest.** Only OpenAI Responses persists a response ID because it
  is the only retained route that consumes it on the next request. Other providers
  continue from canonical visible history instead of recording opaque state that the
  app cannot replay.
- **Streaming terminal states are explicit.** OpenAI incomplete responses finish
  with their actual reason, provider cancellations become cancellation errors, and
  Gemini enum finish reasons normalize to their wire value. Truncated streams still
  fail closed.
- **Catalog discovery follows SDK pagination.** The generic onboarding reader now
  follows bounded `has_next_page` / `get_next_page` SDK pages under one global model
  and byte cap. Async iterable pagers remain supported.
- **Configured base URLs reach the packaged provider model.** OpenAI, Anthropic,
  Gemini, xAI, Mistral, and Cohere builders now pass their configured endpoint to the
  Pydantic provider instead of using it only during the connection test.

## Built-in packaged catalog

| Product ID | Packaged input | Context / output | Reasoning exposed | Snapshot pricing (input/output per 1M) |
|---|---|---:|---|---:|
| `openai:gpt-6-astra` | text, image, PDF | 1,050,000 / 128,000 | low, medium, high, xhigh, max | $10 / $50 |
| `anthropic:claude-sonnet-5` | text, image, PDF | 1,000,000 / 128,000 | none, low, medium, high, xhigh, max; high default | $2 / $10 |
| `google:gemini-3.8-flash` | text, image, PDF | 1,048,576 / 65,536 | low, medium, high | $0.75 / $3.75 introductory |
| `xai:grok-4.6` | text, image | 500,000 / provider has no text output limit | low, medium, high, xhigh | $2 / $6 below long-context threshold |
| `mistral:mistral-medium-3-5` | text, image, PDF | 256,000 / provider does not publish a separate output cap | none, high | $1.50 / $7.50 |
| `cohere:command-a-plus-05-2026` | text in current packaged transport | 128,000 / 64,000 | hidden until transport support | provider says free within applicable rate limits |

Prices are UI estimates, not billing authority. Long-context tiers, caching,
regional pricing, hosted tools, and account-specific terms can change the invoice.

## NVIDIA NIM qualification

NVIDIA's hosted `/v1/models` response can contain only identity fields, so discovery
must not infer chat support from a name. The adapter uses declared task/capability
metadata where present, excludes explicit embed/rerank/guard/media tasks, and otherwise
requires an exact NVIDIA model-card allowlist or a visible compatibility confirmation.
Current official hosted chat candidates suitable for owner live verification are:

- `nvidia/nemotron-3-super-120b-a12b` — official hosted Chat/Reasoning endpoint,
  1M context; the model card requires temperature 1.0 and supports thinking on/off.
- `nvidia/nemotron-3.5-lightning-30b-a3b` — current fast 30B-A3B hosted text model,
  1M context.
- `deepseek-ai/deepseek-v4-flash-0731` — hosted chat example, 1M context, reasoning.
- `moonshotai/kimi-k3` — hosted multimodal agent model, 1,048,576 context; current
  packaged NIM route remains text-only until its exact image wire contract is added.

The owner's live test should first save the bounded `/v1/models` result, confirm the
chosen exact ID appears, then run a short streamed chat with usage and cancellation.
The non-thinking packaged default remains deliberate: several Nemotron templates put
raw reasoning in ordinary content unless `enable_thinking` is disabled.

## Named compatible presets

Groq, OpenRouter, and Cloudflare Workers AI use the retained OpenAI-compatible
transport while keeping distinct setup, vault, endpoint, and model identities.
Their fixed routes are `openai-compatible:groq/...`,
`openai-compatible:openrouter/...`, and `openai-compatible:cloudflare/...`.
The setup policy never falls through to a paid model:

- Groq defaults to `openai/gpt-oss-20b` and admits only exact models currently
  listed in Groq's Free Plan limits. Free-tier availability depends on the account.
- OpenRouter defaults to the exact
  `nvidia/nemotron-3.5-lightning:free` route and admits only exact `:free`
  variants whose published price is zero.
- Cloudflare defaults to `@cf/meta/llama-3.1-8b-instruct-fp8`, requires a separate
  validated Account ID, and excludes the models Cloudflare marks as requiring a
  paid billing method. Workers AI includes a daily free allocation; account plan
  and usage determine whether later requests can incur charges.

Named presets are rehydrated from DPAPI-backed endpoint metadata before the model
catalog is returned, without a startup network request. A persisted exact NVIDIA
NIM selection is reconstructed from the official model-card allowlist after a
runtime restart; the credential is still lent only when that model is used.

## Official sources reviewed

### OpenAI and provider-neutral runtime

1. [OpenAI Responses create reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create) — Responses inputs, tools, reasoning, streaming, and prior response IDs.
2. [OpenAI streaming response events](https://developers.openai.com/api/reference/cli/resources/beta/subresources/responses) — completed, incomplete, failed, cancelled, usage, text, tool, and annotation events.
3. [GPT-6 Astra model](https://developers.openai.com/api/docs/models/gpt-6-astra) — exact ID, limits, modalities, endpoints, reasoning choices, and pricing.
4. [OpenAI model comparison](https://developers.openai.com/api/docs/models/compare) — current flagship comparison and capability matrix.
5. [Pydantic AI input](https://ai.pydantic.dev/input/) — in-memory `BinaryContent` for images and documents and the warning against untrusted client URLs.
6. [Pydantic AI model overview](https://ai.pydantic.dev/models/overview/) — native provider models and OpenAI-compatible route behavior.

### Anthropic

7. [Claude API primer](https://platform.claude.com/docs/en/claude_api_primer) — Messages request/response and streaming foundation.
8. [Claude model list API](https://platform.claude.com/docs/en/api/models/list) — paginated model discovery and current capability metadata.
9. [Claude thinking](https://platform.claude.com/docs/en/build-with-claude/thinking) — adaptive versus manual thinking and safe summarized display.
10. [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort) — `output_config.effort`, supported levels, defaults, and interaction with thinking.
11. [Claude Sonnet 5 migration](https://platform.claude.com/docs/en/models/sonnet-5/migration-guide) — exact model ID, 1M/128K limits, default adaptive thinking, and sampling restrictions.
12. [Fine-grained tool streaming](https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming) — partial JSON tool parameter streaming semantics.

### Google Gemini

13. [Gemini 3.8 Flash model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) — exact ID, 1,048,576/65,536 limits, image/PDF support, and reasoning levels.
14. [Gemini streaming](https://ai.google.dev/gemini-api/docs/streaming) — generate-content streaming contract.
15. [Gemini thinking](https://ai.google.dev/gemini-api/docs/thinking) — thinking levels, summaries, signatures, and token accounting.
16. [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling) — tool declarations, streamed calls, and multimodal function responses.
17. [Gemini file input methods](https://ai.google.dev/gemini-api/docs/file-input-methods) — inline bytes versus uploaded Files API inputs.
18. [Gemini document processing](https://ai.google.dev/gemini-api/docs/document-processing) — PDF input behavior and limits.

### xAI

19. [Grok 4.6 model](https://docs.x.ai/developers/models/grok-4.6) — exact ID, 500K context, image input, reasoning levels, APIs, and prices.
20. [xAI text streaming](https://docs.x.ai/developers/model-capabilities/text/streaming) — chat/Responses streaming behavior.
21. [xAI tool streaming](https://docs.x.ai/developers/tools/streaming-and-sync) — streamed server/client tool results.
22. [xAI citations](https://docs.x.ai/developers/tools/citations) — citation fields and their dependency on search tools.
23. [xAI image understanding](https://docs.x.ai/developers/model-capabilities/images/understanding) — supported image input forms and limits.
24. [xAI language model catalog API](https://docs.x.ai/developers/rest-api-reference/inference/models) — richer modality/capability/pricing discovery surface.

### Mistral, Cohere, and NVIDIA

25. [Mistral Medium 3.5](https://docs.mistral.ai/models/mistral-medium-3-5-26-04) — exact alias, 256K context, multimodal/document Q&A, tools, and pricing.
26. [Mistral reasoning](https://docs.mistral.ai/studio/conversations/reasoning) — exact `none` and `high` reasoning values.
27. [Mistral function calling](https://docs.mistral.ai/studio/conversations/function-calling) — tool request and result contract.
28. [Mistral vision](https://docs.mistral.ai/studio/conversations/vision) — image/document content forms.
29. [Cohere Command A+](https://docs.cohere.com/docs/command-a-plus) — exact ID, limits, native vision/reasoning/tools/citations/structured output, and availability.
30. [Cohere v2 chat stream](https://docs.cohere.com/v2/reference/chat-stream) — event taxonomy, finish, usage, citation, and tool events.
31. [Cohere tool streaming](https://docs.cohere.com/v2/docs/tool-use-streaming) — tool-call start/delta/end shapes.
32. [Cohere list models](https://docs.cohere.com/v2/reference/list-models) — endpoint filtering and pagination.
33. [NVIDIA NIM LLM APIs](https://docs.api.nvidia.com/nim/reference/llm-apis) — hosted OpenAI-compatible inference base and model listing.
34. [NVIDIA Nemotron 3 Super hosted page](https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b) — exact hosted ID, Chat classification, 1M context, and reasoning template controls.
35. [NVIDIA Nemotron 3.5 Lightning hosted page](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b) — exact hosted ID, availability, and 1M context.
36. [NVIDIA DeepSeek V4 Flash hosted page](https://build.nvidia.com/deepseek-ai/deepseek-v4-flash-0731) — exact hosted ID and chat-completions example.
37. [NVIDIA Kimi K3 model card](https://build.nvidia.com/moonshotai/kimi-k3/modelcard) — exact hosted ID, modalities, context, tools, and reasoning.

### Named compatible providers

38. [Groq OpenAI compatibility](https://console.groq.com/docs/openai) — fixed OpenAI-compatible base URL and request differences.
39. [Groq supported models](https://console.groq.com/docs/models) — current production IDs, limits, pricing, and model-list endpoint.
40. [Groq rate limits](https://console.groq.com/docs/rate-limits) — current Free Plan model eligibility and quotas.
41. [OpenRouter free variant](https://openrouter.ai/docs/guides/routing/model-variants/free) — exact `:free` suffix contract.
42. [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/get-models) — model discovery fields and price filtering.
43. [Cloudflare OpenAI compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/) — account-scoped base URL and chat-completions contract.
44. [Cloudflare model search API](https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/) — authenticated account-scoped model discovery.
45. [Cloudflare Llama 3.1 8B FP8](https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fp8/) — exact model ID, streaming, context, and usage.
46. [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) — daily free allocation and models that require paid billing.

## Remaining live-only evidence

The code and recorded tests cannot prove owner-account access, quota, regional model
availability, or current server-side aliases. The packaged owner-profile pass must run
one real stream per configured provider, verify first token and final usage, cancel one
long response, run one tool request through the Rust broker, test one supported image
and one PDF, and confirm the chosen NIM ID from that account's bounded model response.
Failures should retain the redacted provider error category and must not be replaced by
mock success.
