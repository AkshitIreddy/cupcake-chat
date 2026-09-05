# Provider adapter audit — 2026-09-05

## Scope and method

This audit traced the packaged chat path from `RuntimeService` through `CupcakeAgentEngine` and
Pydantic AI, then compared the retained direct adapter normalizers against current official API
documentation. Provider lists and streams were exercised with bounded recorded fixtures. One
explicitly authorized Gemini diagnostic used the owner's key in memory for a single eight-token
request through the real engine; the key and raw SDK objects were never logged. No GUI or GPU call
was used by this lane. The current packaged route is the authority for capability claims; a feature
present in a vendor model but absent from that route is not advertised.

## Findings implemented

- **Binary input now reaches the real model route.** Broker-staged source bytes are persisted in the
  existing content-addressed object store, linked by the generated retrieval source ID, included in
  backup/GC reachability, re-read only after project and conversation ownership checks, and
  converted to Pydantic `BinaryContent`. Renderer paths, provider URLs, and client-supplied bytes
  are never accepted.
- **Binary input is fail-closed.** Only JPEG, PNG, WebP, and PDF are eligible. The claimed MIME type
  is checked against the stored bytes, each inline object is capped at 20 MiB, the provider request
  is capped at 24 MiB total, SVG/HTML/unknown active formats are excluded, and extracted untrusted
  text remains the fallback where a model or transport cannot accept the binary form.
- **The deletion boundary is narrow.** Ingestion deletes only the broker-staged copy after digest
  and root checks. The owner's ordinary source path is never passed to the Python runtime and is not
  deleted.
- **Current model descriptors replace stale aliases.** Limits, reasoning choices, modalities, and
  prices are sourced from current model pages. Cohere Command A+ native vision/reasoning is
  intentionally hidden because Pydantic AI 2.35.3's Cohere transport does not yet encode those
  inputs or controls.
- **Reasoning reaches the transport.** xAI now uses the OpenAI-compatible `reasoning_effort` setting
  on the packaged route; Mistral exposes only its documented `none`/`high` choices; Claude 5 uses
  adaptive thinking plus `output_config.effort`; incompatible sampling temperature is omitted for
  Claude 5 and reasoning OpenAI/xAI calls.
- **Continuity is honest.** Only OpenAI Responses persists a response ID because it is the only
  retained route that consumes it on the next request. Other providers continue from canonical
  visible history instead of recording opaque state that the app cannot replay.
- **Streaming terminal states are explicit.** OpenAI incomplete responses finish with their actual
  reason, provider cancellations become cancellation errors, and Gemini enum finish reasons
  normalize to their wire value. Truncated streams still fail closed.
- **Catalog discovery follows SDK pagination.** The generic onboarding reader now follows bounded
  `has_next_page` / `get_next_page` SDK pages under one global model and byte cap. Async iterable
  pagers remain supported.
- **Configured base URLs reach the packaged provider model.** OpenAI, Anthropic, Gemini, xAI,
  Mistral, and Cohere builders now pass their configured endpoint to the Pydantic provider instead
  of using it only during the connection test.

## Built-in packaged catalog

| Product ID                      | Packaged input                     |                                          Context / output | Reasoning exposed                                 |           Snapshot pricing (input/output per 1M) |
| ------------------------------- | ---------------------------------- | --------------------------------------------------------: | ------------------------------------------------- | -----------------------------------------------: |
| `openai:gpt-6-astra`            | text, image, PDF                   |                                       1,050,000 / 128,000 | low, medium, high, xhigh, max                     |                                        $10 / $50 |
| `anthropic:claude-sonnet-5`     | text, image, PDF                   |                                       1,000,000 / 128,000 | none, low, medium, high, xhigh, max; high default |                                         $2 / $10 |
| `google:gemini-3.8-flash`       | text, image, PDF                   |                                        1,048,576 / 65,536 | low, medium, high                                 |                       $0.75 / $3.75 introductory |
| `xai:grok-4.6`                  | text, image                        |               500,000 / provider has no text output limit | low, medium, high, xhigh                          |             $2 / $6 below long-context threshold |
| `mistral:mistral-medium-3-5`    | text, image, PDF                   | 256,000 / provider does not publish a separate output cap | none, high                                        |                                    $1.50 / $7.50 |
| `cohere:command-a-plus-05-2026` | text in current packaged transport |                                          128,000 / 64,000 | hidden until transport support                    | provider says free within applicable rate limits |

Prices are UI estimates, not billing authority. Long-context tiers, caching, regional pricing,
hosted tools, and account-specific terms can change the invoice.

## NVIDIA NIM qualification

NVIDIA's hosted `/v1/models` response can contain only identity fields, so discovery must not infer
chat support from a name. The adapter uses declared task/capability metadata where present, excludes
explicit embed/rerank/guard/media tasks, and otherwise requires an exact NVIDIA model-card allowlist
or a visible compatibility confirmation. Current official hosted chat candidates suitable for owner
live verification are:

- `nvidia/nemotron-3-super-120b-a12b` — official hosted Chat/Reasoning endpoint, 1M context; the
  model card requires temperature 1.0 and supports thinking on/off.
- `nvidia/nemotron-3.5-lightning-30b-a3b` — current fast 30B-A3B hosted text model, 1M context.
- `deepseek-ai/deepseek-v4-flash-0731` — hosted chat example, 1M context, reasoning.
- `moonshotai/kimi-k3` — hosted multimodal agent model, 1,048,576 context; current packaged NIM
  route remains text-only until its exact image wire contract is added.

The owner's live test should first save the bounded `/v1/models` result, confirm the chosen exact ID
appears, then run a short streamed chat with usage and cancellation. The non-thinking packaged
default remains deliberate: several Nemotron templates put raw reasoning in ordinary content unless
`enable_thinking` is disabled.

The first packaged owner run exposed an important distinction between a discovered limit and a
conservative fallback. `/v1/models` omitted an output limit for `nvidia/nemotron-3-super-120b-a12b`,
so the app displayed its 1,024-token planning fallback as if it were a hard model limit. An explicit
6,144-token request was then rejected before reaching NVIDIA. NVIDIA's exact inference reference
publishes `max_tokens` from 1 through 32,768, with a default of 16,384. The descriptor now pins
32,768 for that exact model. For any still-unknown NIM model, a conservative default remains useful
for planning but no longer rejects a larger explicit request as though the fallback were provider
evidence. The original owner responses persisted `canonical_metadata.finishReason: "length"`; the
partial-response UI and Continue action use that durable value rather than treating the cut-off text
as a complete answer.

## Named compatible presets

Groq, OpenRouter, and Cloudflare Workers AI use the retained OpenAI-compatible transport while
keeping distinct setup, vault, endpoint, and model identities. Their fixed routes are
`openai-compatible:groq/...`, `openai-compatible:openrouter/...`, and
`openai-compatible:cloudflare/...`. The setup policy never falls through to a paid model:

- Groq defaults to `openai/gpt-oss-20b` and admits only exact models currently listed in Groq's Free
  Plan limits. Free-tier availability depends on the account.
- OpenRouter defaults to the exact `nvidia/nemotron-3.5-lightning:free` route and admits only exact
  `:free` variants whose published price is zero.
- Cloudflare defaults to `@cf/meta/llama-3.1-8b-instruct-fp8`, requires a separate validated Account
  ID, and excludes the models Cloudflare marks as requiring a paid billing method. Workers AI
  includes a daily free allocation; account plan and usage determine whether later requests can
  incur charges.

The first packaged Cloudflare connection reached the authenticated search endpoint but reported
`free_model_unavailable`. The search response carries a catalog record identity separately from the
invocable Workers AI `name`; the generic normalizer had preferred `id`, so the `@cf/...` allowlist
could never match. The Cloudflare-specific reader now searches for the exact default, requests one
bounded page of 100 through the API's documented `search`/`per_page` parameters, and emits only
`name` values that start with `@cf/`. Malformed or empty results still fail closed. The fresh
packaged connection then succeeded and discovered the one pinned model.

Its first 200-token inference ended as `UsageLimitExceeded`. That class is Pydantic AI's local
run-budget exception, so it is not evidence that the Cloudflare account exhausted a plan quota. A
no-network transport capture reproduced the cause: the generic OpenAI profile translated the app's
200-token setting into `max_completion_tokens`, while this model's Cloudflare schema accepts
`max_tokens` and otherwise defaults to 256. Cloudflare could therefore complete its documented
default allowance, after which the app's local 200-token guard rejected the reported 256-token
usage. Cloudflare and OpenRouter now receive an explicit compatibility profile that emits
`max_tokens`; other compatible endpoints, local models, native OpenAI, and NVIDIA NIM retain their
existing profiles. No further Cloudflare or OpenRouter inference was used during diagnosis.

The first packaged OpenRouter response exhausted its 200-token allowance on visible planning text
and ended mid-response. The exact free route remains `nvidia/nemotron-3.5-lightning:free`; the
variable `openrouter/free` router is not the default. OpenRouter documents
`reasoning.effort: "none"` as the switch that disables reasoning and `reasoning.exclude: true` as
the response-privacy control. The engine now sends both explicitly for a no-reasoning request.
Exclusion alone would not save tokens, because OpenRouter states that excluded reasoning can still
be generated and billed. The next packaged run must verify a final answer and terminal finish
reason, not merely accept non-empty assistant text.

## Packaged SDK and error-path incidents

The failed packaged Mistral connection was not caused by PyInstaller omitting the package. The build
environment contains `mistralai` 2.9.4, and inspection of the frozen archive confirmed the
`mistralai.client` module and its generated model tree were present. Version 2 exposes `Mistral`
from `mistralai.client`; importing the namespace and looking for a top-level `mistralai.Mistral`
incorrectly produced the product's `missing_provider_dependency` diagnostic. Both onboarding and
chat model construction now import `from mistralai.client import Mistral`. Packaging also runs a
no-network `--provider-load-check` inside the frozen runtime and refuses the candidate unless the
OpenAI, Anthropic, Google, xAI, Mistral, and Cohere clients and Pydantic AI models all construct
successfully.

The owner account successfully connected Google and discovered 54 models, including the exact
`gemini-3.8-flash` ID, but its first two chats ended in the old generic `agent_error`. The lane's
single eight-token diagnostic reproduced an outer `UnexpectedModelBehavior`; that tiny allowance can
itself be consumed before visible text and therefore did not prove whether the owner's earlier
failure was quota, request validation, or another provider response. The engine now requests Gemini
3 low thinking explicitly, does not request thought summaries, and safely traverses wrapped
exceptions for numeric status codes. It reports stable product categories: 400 as `invalid_request`,
404 as `model_unavailable`, 429 as `rate_limit`, 5xx as provider unavailable, and a known
thinking-only token exhaustion as `output_limit`. Provider response bodies and credentials remain
excluded. A fresh packaged Gemini request is still required; the ambiguous diagnostic is not
recorded as a successful route proof.

Named presets are rehydrated from DPAPI-backed endpoint metadata before the model catalog is
returned, without a startup network request. A persisted exact NVIDIA NIM selection is reconstructed
from the official model-card allowlist after a runtime restart; the credential is still lent only
when that model is used.

## Official sources reviewed

### OpenAI and provider-neutral runtime

1. [OpenAI Responses create reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
   — Responses inputs, tools, reasoning, streaming, and prior response IDs.
2. [OpenAI streaming response events](https://developers.openai.com/api/reference/cli/resources/beta/subresources/responses)
   — completed, incomplete, failed, cancelled, usage, text, tool, and annotation events.
3. [GPT-6 Astra model](https://developers.openai.com/api/docs/models/gpt-6-astra) — exact ID,
   limits, modalities, endpoints, reasoning choices, and pricing.
4. [OpenAI model comparison](https://developers.openai.com/api/docs/models/compare) — current
   flagship comparison and capability matrix.
5. [Pydantic AI input](https://ai.pydantic.dev/input/) — in-memory `BinaryContent` for images and
   documents and the warning against untrusted client URLs.
6. [Pydantic AI model overview](https://ai.pydantic.dev/models/overview/) — native provider models
   and OpenAI-compatible route behavior.

### Anthropic

7. [Claude API primer](https://platform.claude.com/docs/en/claude_api_primer) — Messages
   request/response and streaming foundation.
8. [Claude model list API](https://platform.claude.com/docs/en/api/models/list) — paginated model
   discovery and current capability metadata.
9. [Claude thinking](https://platform.claude.com/docs/en/build-with-claude/thinking) — adaptive
   versus manual thinking and safe summarized display.
10. [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort) —
    `output_config.effort`, supported levels, defaults, and interaction with thinking.
11. [Claude Sonnet 5 migration](https://platform.claude.com/docs/en/models/sonnet-5/migration-guide)
    — exact model ID, 1M/128K limits, default adaptive thinking, and sampling restrictions.
12. [Fine-grained tool streaming](https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming)
    — partial JSON tool parameter streaming semantics.

### Google Gemini

13. [Gemini 3.8 Flash model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) — exact
    ID, 1,048,576/65,536 limits, image/PDF support, and reasoning levels.
14. [Gemini streaming](https://ai.google.dev/gemini-api/docs/streaming) — generate-content streaming
    contract.
15. [Gemini thinking](https://ai.google.dev/gemini-api/docs/thinking) — thinking levels, summaries,
    signatures, and token accounting.
16. [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling) — tool
    declarations, streamed calls, and multimodal function responses.
17. [Gemini file input methods](https://ai.google.dev/gemini-api/docs/file-input-methods) — inline
    bytes versus uploaded Files API inputs.
18. [Gemini document processing](https://ai.google.dev/gemini-api/docs/document-processing) — PDF
    input behavior and limits.

### xAI

19. [Grok 4.6 model](https://docs.x.ai/developers/models/grok-4.6) — exact ID, 500K context, image
    input, reasoning levels, APIs, and prices.
20. [xAI text streaming](https://docs.x.ai/developers/model-capabilities/text/streaming) —
    chat/Responses streaming behavior.
21. [xAI tool streaming](https://docs.x.ai/developers/tools/streaming-and-sync) — streamed
    server/client tool results.
22. [xAI citations](https://docs.x.ai/developers/tools/citations) — citation fields and their
    dependency on search tools.
23. [xAI image understanding](https://docs.x.ai/developers/model-capabilities/images/understanding)
    — supported image input forms and limits.
24. [xAI language model catalog API](https://docs.x.ai/developers/rest-api-reference/inference/models)
    — richer modality/capability/pricing discovery surface.

### Mistral, Cohere, and NVIDIA

25. [Mistral Medium 3.5](https://docs.mistral.ai/models/mistral-medium-3-5-26-04) — exact alias,
    256K context, multimodal/document Q&A, tools, and pricing.
26. [Mistral reasoning](https://docs.mistral.ai/studio/conversations/reasoning) — exact `none` and
    `high` reasoning values.
27. [Mistral function calling](https://docs.mistral.ai/studio/conversations/function-calling) — tool
    request and result contract.
28. [Mistral vision](https://docs.mistral.ai/studio/conversations/vision) — image/document content
    forms.
29. [Cohere Command A+](https://docs.cohere.com/docs/command-a-plus) — exact ID, limits, native
    vision/reasoning/tools/citations/structured output, and availability.
30. [Cohere v2 chat stream](https://docs.cohere.com/v2/reference/chat-stream) — event taxonomy,
    finish, usage, citation, and tool events.
31. [Cohere tool streaming](https://docs.cohere.com/v2/docs/tool-use-streaming) — tool-call
    start/delta/end shapes.
32. [Cohere list models](https://docs.cohere.com/v2/reference/list-models) — endpoint filtering and
    pagination.
33. [NVIDIA NIM LLM APIs](https://docs.api.nvidia.com/nim/reference/llm-apis) — hosted
    OpenAI-compatible inference base and model listing.
34. [NVIDIA Nemotron 3 Super hosted page](https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b)
    — exact hosted ID, Chat classification, 1M context, and reasoning template controls.
35. [NVIDIA Nemotron 3 Super inference reference](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-super-120b-a12b-infer)
    — exact 1–32,768 `max_tokens` range, 16,384 default, streaming, and reasoning controls.
36. [NVIDIA Nemotron 3.5 Lightning hosted page](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b)
    — exact hosted ID, availability, and 1M context.
37. [NVIDIA DeepSeek V4 Flash hosted page](https://build.nvidia.com/deepseek-ai/deepseek-v4-flash-0731)
    — exact hosted ID and chat-completions example.
38. [NVIDIA Kimi K3 model card](https://build.nvidia.com/moonshotai/kimi-k3/modelcard) — exact
    hosted ID, modalities, context, tools, and reasoning.

### Named compatible providers

39. [Groq OpenAI compatibility](https://console.groq.com/docs/openai) — fixed OpenAI-compatible base
    URL and request differences.
40. [Groq supported models](https://console.groq.com/docs/models) — current production IDs, limits,
    pricing, and model-list endpoint.
41. [Groq rate limits](https://console.groq.com/docs/rate-limits) — current Free Plan model
    eligibility and quotas.
42. [OpenRouter free variant](https://openrouter.ai/docs/guides/routing/model-variants/free) — exact
    `:free` suffix contract.
43. [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/get-models) — model
    discovery fields and price filtering.
44. [OpenRouter reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
    — `reasoning.effort`, disabling, exclusion, token accounting, and per-model mandatory reasoning
    metadata.
45. [Cloudflare OpenAI compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)
    — account-scoped base URL and chat-completions contract.
46. [Cloudflare model search API](https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/)
    — authenticated account-scoped model discovery and its `search`, `per_page`, and `result`
    contract.
47. [Cloudflare Llama 3.1 8B FP8](https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fp8/)
    — exact model ID, streaming, context, and usage.
48. [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
    — daily free allocation and models that require paid billing.

## Remaining live-only evidence

Source checks now pass the complete runtime suite with one existing skip, strict Pyright, Ruff, and
the no-network provider-load check for all six retained SDK-backed routes. Those results do not
qualify a fresh Windows package. The new onedir build must pass the same frozen provider-load check,
then the owner-profile pass must retry Mistral, Gemini, Cloudflare, OpenRouter, and the 6,144-token
NIM code response. It must verify first token, terminal finish reason, final usage, and durable
reload state; non-empty but truncated or reasoning-only text is not success. Account access, quota,
regional availability, and current server-side aliases remain live-only evidence. Failures must
retain the redacted provider error category and must not be replaced by mock success.
