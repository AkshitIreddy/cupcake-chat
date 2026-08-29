# ADR-0003: Cloud providers and local models

**Status:** Accepted **Date:** 2026-08-28

## Context

CUPCAKEAGI must support changing provider capabilities without making provider SDK shapes part of
stored history. Users must choose models explicitly and understand privacy, capability, and
approximate cost before sending data. Local inference must work without bundled weights.

## Decision

Define a product-owned `ProviderAdapter` around `ModelDescriptor`, canonical input, cancellation,
and streamed `RunEvent`s. Use Pydantic AI Core for model/provider mechanics while keeping
CUPCAKEAGI's adapter and persistence boundary authoritative.

Ship direct adapters for OpenAI, Anthropic, Gemini, xAI, Mistral, Cohere, and NVIDIA-hosted NIM,
plus a generic OpenAI-compatible endpoint. The OpenAI adapter uses the Responses API. NVIDIA NIM
uses its fixed hosted OpenAI-compatible base and one broker-owned key, but remains a distinct cloud
privacy route. It discovers models dynamically, filters explicit non-chat surfaces, and labels
unknown compatibility without inventing tool, reasoning, modality, context, or price support. Every
adapter normalizes text, citations, tool intents, safe provider reasoning summaries, usage, finish
state, retry metadata, and errors; it tolerates additive unknown provider event types without
inventing completion.

`ModelDescriptor` contains provider/model IDs, display name, modality and tool capabilities,
supported reasoning presets, context/output limits, streaming support, privacy route, speed/cost
class, pricing value/currency/unit/effective date/source, and catalog provenance. The UI disables
unsupported controls rather than coercing them. Pricing is an estimate, clearly dated, and
reconciled with provider-reported usage when available.

Model selection is always explicit. A default model may be saved, but there is no automatic routing.
Fallbacks are off by default and user-authored; a fallback crossing provider, Local/Cloud route, or
cost class requires confirmation at failure time.

Canonical visible history is recompiled whenever provider/model family changes. Opaque continuity
IDs may be retained only for the same provider and compatible model family, are never rendered as
history, and are discarded on edit/branch or privacy-policy change. Hidden reasoning is neither
requested for display nor persisted. Provider storage is disabled where supported by default (for
OpenAI, `store: false`); any feature requiring remote continuity has a separate disclosure.

## Local model manager

- **Cupcake Local:** app-managed, versioned llama.cpp runtime with a safe CPU baseline and
  separately verified acceleration packs. No weights are bundled.
- **Ollama:** detect and manage via its native loopback API; do not scrape UI or spawn an unrelated
  server.
- **LM Studio:** detect and integrate through its documented developer/server APIs.
- **GGUF:** signed catalog metadata, license display/acceptance, resumable range downloads,
  partial-file staging, SHA-256 verification, atomic promotion, versioning, and removal.
- **vLLM:** connect to a user-configured external endpoint; never install or administer vLLM.

Loopback endpoints are treated as local only after address resolution proves loopback and redirects
are disabled. Custom endpoints show the resolved destination and TLS state. Model files and runtimes
are untrusted inputs: verify catalog signatures/checksums, constrain extraction, and keep runtime
execution outside the renderer.

Hardware detection reports OS, architecture, CPU features, RAM, GPU/backend, VRAM, free disk, and
measured runtime performance. Recommendations are labeled estimates: near 12 GB VRAM, prefer 7–9B
Q4_K_M; allow 12–14B only with context/headroom warnings; classify larger models as
hybrid/unsuitable unless measured fit proves otherwise. Actual load and tokens/sec replace estimates
after testing.

## Deterministic testing

Pydantic `TestModel`/`FunctionModel` or a product mock adapter emits recorded canonical sequences
for ordinary development and CI. Provider fixtures cover fragmented UTF-8, partial tool JSON,
citations, usage, cancellation, timeouts, 429/Retry-After, mid-stream errors, unknown events, and
malformed terminal states. Live smoke tests are opt-in and require user-supplied vault credentials.

## Consequences

- Provider additions do not migrate product history.
- Capability and price catalogs must be maintained, signed, dated, and testable; stale entries
  remain visible as stale rather than silently refreshed.
- The local manager has substantial download/runtime lifecycle work but preserves offline and
  private use.
- Provider parity means a consistent product contract, not pretending every provider has identical
  features.

## Verification

- Contract tests for all seven direct providers and OpenAI-compatible endpoints; recorded fixtures
  are required, live credentials optional.
- Switch providers mid-branch and prove only canonical visible history crosses the boundary.
- Validate unsupported reasoning controls, store/privacy flags, cancellation, usage/cost, and
  fallback confirmation.
- Test absent/stopped/running local services, checksum mismatch, pause/resume/cancel, insufficient
  disk/RAM/VRAM, load/unload, and offline chat after a verified download.
