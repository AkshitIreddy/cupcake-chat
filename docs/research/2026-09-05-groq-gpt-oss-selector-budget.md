# Groq GPT-OSS selector budget

Checked against Groq's primary documentation on 2026-09-05.

- Groq lists `openai/gpt-oss-20b` as a reasoning model with low, medium, and high effort. Medium is
  the provider default, so omitting the field does not disable reasoning.
- Groq states that reasoning consumes generated tokens and recommends `max_completion_tokens: 1024`
  in its reasoning configuration guidance.
- The Chat Completions API documents `max_completion_tokens`; `max_tokens` is deprecated.
- GPT-OSS can exclude reasoning from the returned response with `include_reasoning: false` while
  still using the chosen reasoning effort.

CupcakeAI therefore advertises low/medium/high for exact Groq GPT-OSS descriptors, pins low as its
quota-conscious default, and gives a Smart group selector 1,024 generated tokens. Selectors that can
explicitly disable reasoning retain the 256-token budget. The selector request excludes private
reasoning from returned events and disables SDK retries, preserving one provider request per routing
decision.

Primary sources:

- [Groq GPT OSS 20B model page](https://console.groq.com/docs/model/openai/gpt-oss-20b)
- [Groq reasoning guide](https://console.groq.com/docs/reasoning)
- [Groq Chat Completions API](https://console.groq.com/docs/api-reference)

## Group-call retry audit

The packaged SDK versions were also inspected because an application-level call count is not a wire
request count when a provider client retries internally. OpenAI and Anthropic each retry eligible
errors twice by default. Google defines five attempts by default and treats one attempt as no retry.
Cohere's packaged `AsyncClientV2` defaults to two retries. The packaged Mistral client has no client
retry policy unless `retry_config` is supplied, but CupcakeAI pins that state explicitly for group
calls rather than relying on a changing SDK default.

Group selectors and responders now carry one request policy through every retained provider route:
SDK retries are disabled, Pydantic output retries are zero, and Pydantic's model-request limit is
one. Solo chats retain their existing retry behavior. Mock transports returning HTTP 503 verify one
wire attempt for OpenAI-compatible selectors and responders plus the Anthropic, Google, and Cohere
native SDK families.

Additional primary sources:

- [OpenAI Python retries](https://github.com/openai/openai-python#retries)
- [Anthropic Python SDK retries](https://github.com/anthropics/anthropic-sdk-python#retries)
- [Google Gen AI HTTP retry options](https://googleapis.github.io/python-genai/)
- [Cohere Python SDK](https://github.com/cohere-ai/cohere-python)
- [Mistral Python SDK retries](https://github.com/mistralai/client-python#retries)
