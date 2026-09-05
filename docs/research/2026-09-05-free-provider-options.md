# Renewable free API options — 2026-09-05

The owner requested generous free options for people trying CupcakeAI and subsequently added keys
for Groq, Google Gemini, Mistral, OpenRouter, and Cloudflare to the authorized local credential
file. Keys are for the owner test profile; shipped applications must use each user's own account. A
free tier is a provider allowance, not a product guarantee. Limits must be read from the actual
account and models discovered/tested before showing operational availability.

| Provider                                                                                | Current primary-source finding                                                                                                                                                                   | Product decision                                                                                                                 |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| [Groq](https://console.groq.com/docs/rate-limits)                                       | Free-plan GPT-OSS 120B/20B and listed Qwen routes show 30 requests/minute, 1,000 requests/day, 8,000 tokens/minute and 200,000 tokens/day. Any limit may bind first; account exceptions exist.   | Prioritize explicit free chat/coding routes; disclose Groq as server and the actual model publisher separately.                  |
| [Google Gemini](https://ai.google.dev/gemini-api/docs/pricing)                          | Selected models have free input/output. Free-tier data may be used to improve Google's products. [Actual quotas](https://ai.google.dev/gemini-api/docs/rate-limits) are account/model dependent. | Useful multimodal/document option. Do not imply privacy equivalence with local inference or paid data policies.                  |
| [Mistral](https://docs.mistral.ai/admin/billing-usage/usage-limits)                     | Free mode permits keys and included monthly usage. The account Limits page controls current allowance.                                                                                           | Retain native Mistral integration; do not promise an unsupported fixed monthly token quota.                                      |
| [OpenRouter](https://openrouter.ai/docs/faq)                                            | Free models allow 50 requests/day without the qualifying credit purchase; purchasing at least $10 credits raises free-model allowance to 1,000/day. Model availability varies.                   | Offer explicit free model IDs. Do not silently use a paid alternative or a random-model router when the user selected one model. |
| [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/) | 10,000 neurons/day renews daily. Per-model compute pricing determines usable tokens. Some new models require a paid billing method.                                                              | Account-ID-aware endpoint and scoped API token; discover models and choose a free-eligible explicit model.                       |

## A stale recommendation rejected

Search excerpts still advertised Cerebras's previous renewable free tier. Opening its current
[rate-limit documentation](https://inference-docs.cerebras.ai/support/rate-limits) instead shows a
$5 trial, 30-day expiry, and a verified payment method requirement. Its FAQ explicitly says no
permanently free tier currently exists. It is therefore not recommended as a renewable free option.

## Verification boundary

These are published plan findings, not successful calls. Live account verification, exact model IDs,
responses, and persisted demo evidence belong in the final owner showcase ledger. Free quota
exhaustion must remain a visible recoverable error and must not trigger undisclosed paid fallback.
