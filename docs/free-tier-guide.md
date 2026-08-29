# Try CUPCAKEAGI before upgrading

**Last checked: 2026-08-29.** This guide uses provider-owned pricing, billing, and developer
documentation. Offers, model access, regional availability, rate limits, and verification
requirements can change without notice, so treat the provider dashboard as the final word.

CUPCAKEAGI never needs a subscription of its own. You choose one model for each message and can
begin with a local model or a provider's published evaluation allowance. A consumer chat
subscription is not the same thing as API credit.

## Seven direct text providers

| Provider                  | Classification                         | What the official offer currently says                                                                                                                                                                                                                                                                       | Start here                                                                                                                                                                                                  |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI                    | **Free test/account grant, then paid** | The official quickstart includes a free test request and then directs developers to add credits. Current chat-model pages list the Free API tier as unsupported, so do not assume a recurring allowance.                                                                                                     | [Quickstart](https://platform.openai.com/docs/quickstart) · [API keys](https://platform.openai.com/api-keys) · [model pricing and limits](https://developers.openai.com/api/docs/models)                    |
| Anthropic                 | **Paid-only for general API use**      | Claude API and playground usage consume prepaid credits; invoicing is available to qualifying organizations. Separate research-credit programs are not a general developer free tier.                                                                                                                        | [Billing explanation](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage) · [Console](https://console.anthropic.com/)                                                      |
| Gemini / Google AI Studio | **Ongoing free tier**                  | New accounts begin on a Free Tier with selected models and model-specific rate limits. Free-tier inputs and outputs are free of charge; the exact quota is shown in AI Studio.                                                                                                                               | [Billing and tiers](https://ai.google.dev/gemini-api/docs/billing) · [pricing](https://ai.google.dev/gemini-api/docs/pricing) · [create a key](https://aistudio.google.com/app/apikey)                      |
| xAI                       | **Paid-only for general API use**      | Current billing documentation lists prepaid credits and approved monthly invoicing. The widely quoted $25/month offer belonged to the public beta through the end of 2024, not the current general offer.                                                                                                    | [Current billing](https://docs.x.ai/console/billing) · [Console](https://console.x.ai/) · [expired 2024 beta announcement](https://x.ai/news/api)                                                           |
| Mistral                   | **Ongoing monthly free allowance**     | Free mode is the default for new accounts. Mistral currently lists **$10/month in API credits** on the Free plan, shared across Studio/API usage and subject to plan limits.                                                                                                                                 | [subscriptions](https://docs.mistral.ai/admin/billing-usage/subscriptions) · [current pricing](https://mistral.ai/pricing/) · [Studio](https://console.mistral.ai/)                                         |
| Cohere                    | **Free evaluation key**                | Trial/evaluation calls are free, rate limited, and not permitted for production or commercial use. Cohere currently documents 1,000 calls/month and 20 chat requests/minute for listed chat models.                                                                                                          | [key types and limits](https://docs.cohere.com/v2/docs/rate-limits) · [pricing terms](https://cohere.com/pricing) · [API keys](https://dashboard.cohere.com/api-keys)                                       |
| NVIDIA NIM                | **Free developer prototyping access**  | NVIDIA Developer Program members can use NVIDIA-hosted NIM APIs for prototyping, development, and testing. This is a trial/developer route, not a production entitlement; availability, per-model limits, and promotional terms can change. One developer API key can access multiple available text models. | [NIM for Developers](https://developer.nvidia.com/nim) · [hosted API quickstart](https://docs.api.nvidia.com/nim/docs/api-quickstart) · [technology access terms](https://developer.nvidia.com/legal/terms) |

"Ongoing" means the provider publishes a recurring allowance today, not that the offer is guaranteed
forever. CUPCAKEAGI should display the provider-returned limit or billing error rather than silently
changing models.

### Set up NVIDIA NIM once for several text models

1. Open the [NVIDIA API Catalog](https://build.nvidia.com/) and sign in. NVIDIA's quickstart says
   that requesting a key enrolls a new account in the free NVIDIA Developer Program.
2. Open any LLM model page, acknowledge that model's separate terms when shown, and select **Get API
   Key**. Copy the generated `nvapi-...` key; do not paste it into a project file.
3. In CUPCAKEAGI, open **Models**, choose **Add provider → NVIDIA NIM**, and enter the key in the
   Windows credential prompt. The Rust broker stores it with per-user DPAPI protection.
4. CUPCAKEAGI asks NVIDIA's hosted `/v1/models` endpoint for the current catalog. Choose one model
   explicitly. It filters clearly non-chat surfaces and labels catalog entries whose chat
   compatibility NVIDIA did not declare; it never treats unknown tool, reasoning, image, or context
   capabilities as supported.
5. Confirm the NVIDIA-hosted Cloud destination before sending project context. Check the selected
   model page and your NVIDIA account for current limits and third-party model terms.

This route reduces account setup because the same NVIDIA developer key can expose several hosted
text models. It does not make those models interchangeable, permit automatic routing, or grant
production use. NVIDIA directs production deployments to NVIDIA AI Enterprise or dedicated hosted
partners.

## Official OpenAI-compatible free paths

These are optional generic endpoints, not direct CUPCAKEAGI provider adapters. Capabilities differ:
a compatible Chat Completions endpoint does not guarantee Responses API state, every reasoning
control, tool behavior, citations, or identical streaming events.

| Service               | Published free path                                          | Compatibility and caveat                                                                                                                                                                                         | Official links                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GroqCloud             | **Free Plan** with per-model request/token limits            | Mostly OpenAI compatible. Exact organization limits are visible in the Groq console; free capacity and model availability may change.                                                                            | [Free Plan limits](https://console.groq.com/docs/rate-limits) · [OpenAI compatibility](https://console.groq.com/docs/openai) · [API keys](https://console.groq.com/keys)                                                                   |
| OpenRouter            | **Specific free model variants** for experimentation         | Use a specific model ending in `:free` when explicit model choice matters. Free variants have lower availability and rate limits; requests may be handled by an underlying provider with its own logging policy. | [free variants](https://openrouter.ai/docs/guides/routing/model-variants/free) · [free-model limitations](https://openrouter.ai/docs/cookbook/get-started/free-models-router-playground) · [API keys](https://openrouter.ai/settings/keys) |
| Cloudflare Workers AI | **10,000 Neurons/day** at no charge on the Workers Free plan | Supports OpenAI-compatible chat and embedding endpoints. Some models require paid billing; the free allocation resets at 00:00 UTC and requests fail after it is exhausted.                                      | [free allocation](https://developers.cloudflare.com/workers-ai/platform/pricing/) · [compatible endpoint](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/) · [dashboard](https://dash.cloudflare.com/)   |

Free aggregator capacity is useful for learning, but it adds another data processor and may be less
predictable than a direct provider. Configure the exact base URL, choose a visible model yourself,
and test streaming/tool support before depending on it.

## Local and no-key options

| Runtime                      | Provider API charge       | What you need                                                                                                                              |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| CUPCAKEAGI Local / llama.cpp | **None**                  | Download a compatible GGUF model. llama.cpp runs inference locally and exposes an OpenAI-compatible server.                                |
| Ollama                       | **None for local models** | Install Ollama and download a model; the local API is served at `http://localhost:11434`. Ollama cloud models are a separate hosted route. |
| LM Studio                    | **None for local models** | Install LM Studio, download a model, load it, and start the local server; OpenAI-compatible endpoints are available.                       |

Official references: [llama.cpp](https://github.com/ggml-org/llama.cpp),
[Ollama local API](https://docs.ollama.com/api/introduction), and
[LM Studio developer docs](https://lmstudio.ai/docs/developer).

The runtime may be free while the model has its own license or acceptable-use conditions. Local
inference also uses disk space, RAM/VRAM, electricity, and download bandwidth. Keep local servers
bound to localhost unless you intentionally secure and expose them; many local endpoints are not
authenticated by default.

## Privacy and cost checklist

- **Free does not mean private.** Hosted prompts, attachments, retrieved project text, tool results,
  and responses leave your computer. Google's pricing page explicitly says free-tier content may be
  used to improve its products; check every provider's current data terms before sending sensitive
  material.
- **Routers add a party.** With a compatible aggregator, both the router and the underlying
  inference provider may process the request. Review the actual route and logging policy, not only
  the model name.
- **Set a hard budget where possible.** Disable automatic top-ups while experimenting, choose short
  output limits, and check the provider dashboard after the first request. A rate limit is not
  necessarily a spending limit.
- **Keep keys out of files.** Add credentials only through CUPCAKEAGI's provider setup so the
  Windows per-user DPAPI vault can protect them. Never commit, paste into chat, screenshot, or place
  keys in `.env` files in this repository. Revoke a key immediately if it may have leaked.
- **Verify the destination indicator.** Before sending a file or project context, confirm that
  CUPCAKEAGI shows the intended Local or Cloud destination and the exact provider/model.
- **Expect free capacity to stop.** CUPCAKEAGI does not silently fall back to another provider. A
  depleted grant, expired trial, or rate limit should produce a visible error until you retry later,
  select another model, or deliberately enable paid use.

For confidential work, begin with a local model. For hosted experimentation, Gemini's free tier,
Mistral's monthly credits, Cohere's evaluation key, and NVIDIA NIM's multi-model developer catalog
are the clearest direct-provider starting points today. Cohere and NVIDIA's hosted developer access
are non-production routes, while Mistral and Gemini still require their current terms and limits to
fit your use.
