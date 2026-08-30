# Try-before-upgrading provider guide

**Review date:** 2026-08-30. Provider plans, eligibility, limits, models, and data terms can change.
Verify the linked official dashboard immediately before testing. CUPCAKEAGI does not promise an
allowance or silently switch providers when one is exhausted.

| Route                              | Starting point                                                       | Important caveat                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gemini                             | [Google AI Studio keys](https://aistudio.google.com/app/apikey)      | Selected models may have a free API tier; region, quota, and data-use terms vary.                                                                                                                                                                                                                                                                                           |
| Mistral                            | [Mistral console](https://console.mistral.ai/)                       | The optional free Experiment mode has lower limits and different data-use terms than paid Scale access; review the current consent and privacy text before enabling it. Do not describe it as a recurring cash credit.                                                                                                                                                      |
| Cohere                             | [Cohere API keys](https://dashboard.cohere.com/api-keys)             | Trial/evaluation keys are limited to 1,000 API calls per month; current Chat limits are generally 20 requests/minute. Production limits and pricing vary by model—Command A+ currently has special terms—so check the official [rate-limit table](https://docs.cohere.com/v2/docs/rate-limits) and model page.                                                              |
| NVIDIA NIM                         | [NVIDIA API Catalog](https://build.nvidia.com/)                      | NVIDIA currently offers Developer Program members hosted NIM endpoints for prototyping. Endpoint/model availability and service limits can vary; it is neither unlimited nor CUPCAKEAGI's default, and production requires an appropriate NVIDIA entitlement. See NVIDIA's current [NIM access and pricing guidance](https://docs.api.nvidia.com/nim/re/docs/run-anywhere). |
| OpenAI                             | [OpenAI API quickstart](https://platform.openai.com/docs/quickstart) | No recurring free chat-model tier should be assumed; grants are account-specific.                                                                                                                                                                                                                                                                                           |
| Anthropic                          | [Anthropic Console](https://console.anthropic.com/)                  | General API access is paid unless the account shows a specific credit.                                                                                                                                                                                                                                                                                                      |
| xAI                                | [xAI Console](https://console.x.ai/)                                 | Credits/promotions are account-specific.                                                                                                                                                                                                                                                                                                                                    |
| Generic remote compatible endpoint | Provider's official API documentation                                | The router and underlying inference provider may both process data. Verify base URL, exact model, streaming, tools, usage, and logging.                                                                                                                                                                                                                                     |
| Cupcake Local                      | In-app Models catalog                                                | No provider API charge after download, but licenses, hardware, storage, bandwidth, and electricity apply.                                                                                                                                                                                                                                                                   |

## Data disclosures shown in the app

An API key is protected locally, but hosted prompts, selected attachments, retrieved context, and
model responses are processed by the route the user selects. Free and evaluation access can have
different privacy and production-use rules from paid access. The in-app review step must link to
current provider terms and must not reduce these distinctions to a generic “cloud” label.

- **OpenAI:** API inputs and outputs are not used for training by default unless the organization
  opts in. Default abuse-monitoring logs can contain prompts and responses for up to 30 days, while
  endpoint-specific application state can last longer. See
  [OpenAI platform data controls](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint).
- **Anthropic:** commercial/API inputs and outputs are not used for training by default and are
  normally deleted within 30 days, subject to stateful features, policy enforcement, legal duties,
  feedback, and different agreements. See Anthropic's
  [training](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training) and
  [retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)
  explanations.
- **Gemini:** unpaid AI Studio/Gemini API content can be used to improve Google products and may be
  reviewed by humans after de-linking; users should not submit sensitive or confidential data to
  that route. Paid-service terms say prompts and responses are not used to improve products, but
  limited safety, abuse, and legal logging remains. Regional rules and grounded-search retention can
  differ. See the [Gemini API terms](https://ai.google.dev/gemini-api/terms).
- **xAI:** current enterprise terms say user content is not used to train foundation models or
  develop new products, subject to disclosed customer-controlled settings. Retention is normally no
  later than 30 days after a session, with documented, legal, safety, and compliance exceptions;
  zero-data-retention is a separate elected mode. See the
  [xAI enterprise terms](https://x.ai/legal/terms-of-service-enterprise).
- **Mistral:** do not promise that free API data is never used for training. Free Experiment mode
  exposes an anonymous-improvement-data opt-out, pay-as-you-go customers are opted out by default,
  and Labs/Preview routes can have broader training terms. Standard API input/output is generally
  kept for processing plus a rolling 30-day abuse-monitoring period; zero-data-retention is
  separately approved and limited. See Mistral's
  [privacy controls](https://docs.mistral.ai/admin/monitor-comply/privacy-data-controls) and
  [free-mode opt-out](https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training).
- **Cohere:** enterprise data commitments apply to paying commercial customers, not automatically to
  trial-key users. Trial use follows Cohere's general terms and privacy policy; do not inherit
  paid-customer training controls or zero-data-retention promises. See
  [Cohere enterprise data commitments](https://cohere.com/enterprise-data-commitments).
- **NVIDIA NIM:** hosted evaluation is limited internal testing, not production access. The trial
  terms generally say content is not stored after the session except for disclosed, fine-tuning,
  security, fraud, or abuse cases, while allowing non-user-identifying content/output collection to
  improve NVIDIA products. Do not send confidential, controlled, sensitive, or personal data unless
  the selected service expressly permits it. See the
  [NVIDIA API Trial Terms](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf).
- **Generic compatible endpoint:** no universal privacy, retention, training, free-tier, or
  production rule exists. Show the operator-supplied identity and policy; never inherit OpenAI's
  terms merely because the endpoint uses a similar API shape.
- **Cupcake Local:** prompts and model responses remain on the device after weights are explicitly
  downloaded, but an initial catalog/runtime/model download still contacts the disclosed artifact
  host. Tools can separately transmit data only through their own visible approval and policy path.

## Safe first test

1. Create a disposable provider key and set a small budget where possible.
2. In CUPCAKEAGI, read the provider privacy/cost disclosure and obtain-key link.
3. Paste the key into the masked field; do not use a repository file or environment variable.
4. Test the connection and inspect discovered models/capabilities.
5. Send a small non-sensitive prompt, verify usage/destination, then remove the credential if
   finished.

Never put keys in Git, `.env`, screenshots, chat, logs, snapshots, crash reports, or diagnostics.
Revoke any key that may have leaked. For confidential work, start with Cupcake Local and verify that
the destination remains Local.
