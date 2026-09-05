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
