# Architecture research ledger

**Reviewed:** 2026-08-28
**Method:** Primary specifications, vendor documentation, standards, and maintained upstream repositories were read before recording the architecture. Search snippets and third-party summaries are not evidence entries. Provider details, prices, model limits, and draft specifications can change; implementation pins tested versions and dates catalog metadata.

## Desktop and process isolation

| Primary source | Material finding | Decision it supports |
|---|---|---|
| [Why Electron](https://www.electronjs.org/docs/latest/why-electron) | Electron ships one Chromium/Node desktop runtime and supports cross-platform native applications. | Electron provides the controlled rendering target for the text-first workbench. |
| [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model) | Main, sandboxed renderers, preload, and utility/child processes have distinct roles; privileged APIs should be bridged narrowly. | Renderer/main separation and sidecar supervision in ADR-0001. |
| [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security) | Recommends secure local content, context isolation, sandboxing, restrictive CSP, navigation limits, sender validation, and no exposed Electron APIs. | Binding renderer security invariants and tests. |
| [Electron process sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox) | A sandboxed renderer has no Node environment and must delegate privileged work over IPC; context isolation remains necessary. | No Node/files/processes in the renderer. |
| [Electron context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation) | Exposing a generic IPC send function is unsafe; expose one filtered method per operation. | Narrow generated preload bridge. |
| [Electron IPC](https://www.electronjs.org/docs/latest/tutorial/ipc) | IPC is the normal boundary for native actions and supports one-way, request/response, and main-to-renderer patterns. | Typed renderer command/event design. |
| [JSON Schema Draft 2020-12 core](https://json-schema.org/draft/2020-12/json-schema-core) | Defines vocabulary, identifiers, references, instances, and validation-oriented schema behavior. | Versioned schema source for TypeScript/Pydantic/Serde generation. |
| [RFC 9562 UUIDs](https://www.rfc-editor.org/rfc/rfc9562.html) | Standardizes UUIDv7 as a Unix-time-ordered UUID with random bits. | Product-owned, roughly sortable identifiers without provider coupling. |

## Agent and durable runtime

| Primary source | Material finding | Decision it supports |
|---|---|---|
| [Pydantic AI model providers](https://pydantic.dev/docs/ai/models/overview/) | Pydantic AI separates models, providers, and profiles; supports the six selected vendors, capability inspection, test models, custom/OpenAI-compatible providers, and concurrency/error handling. | Provider-neutral mechanics behind CUPCAKEAGI-owned adapters. |
| [Pydantic AI deferred tools](https://pydantic.dev/docs/ai/tools-toolsets/deferred-tools/) | Tool calls can be deferred for external approval/execution and resumed with approved/denied results. | `ToolIntent`/approval boundary and recoverable `input_required` tasks. |
| [Pydantic AI durable execution with DBOS](https://pydantic.dev/docs/ai/capabilities/durable_execution/dbos/) | Pydantic agent operations can participate in DBOS durable workflows. | Integration feasibility for agent tasks. |
| [DBOS workflow tutorial](https://docs.dbos.dev/python/tutorials/workflow-tutorial) | Interrupted workflows recover from their last completed step; steps are the side-effect/checkpoint boundary. | Checkpoint placement and recovery in ADR-0006. |
| [DBOS database connections](https://docs.dbos.dev/python/tutorials/database-connection) | DBOS supports SQLite and PostgreSQL, defaults to SQLite, and cautions that SQLite is not for distributed deployments. | Separate SQLite workflow DB only because CUPCAKEAGI is single-device/single-process. |
| [OpenTelemetry trace specification](https://opentelemetry.io/docs/specs/otel/trace/) | Defines trace/span relationships, context propagation, events, links, and status. | Local redacted diagnostics with standard trace IDs, not a proprietary event model. |

## Provider adapters

| Primary source | Material finding | Decision it supports |
|---|---|---|
| [OpenAI Responses streaming events](https://platform.openai.com/docs/api-reference/responses-streaming) | Responses streams typed, sequenced lifecycle/content/tool events and returns status, reasoning summaries/settings, conversation continuity, and usage. | Native OpenAI Responses adapter normalized into `RunEvent`. |
| [OpenAI API data controls](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint) | Responses application state has provider retention implications; Zero Data Retention changes supported behavior. | Default `store: false` where supported and disclose remote continuity/privacy route. |
| [Claude Messages API](https://platform.claude.com/docs/en/api/messages/create) | Messages is direct model access with client-supplied conversational turns. | Anthropic adapter compiles canonical visible history rather than storing SDK objects. |
| [Claude streaming](https://platform.claude.com/docs/en/build-with-claude/streaming) | SSE includes message/content block lifecycle, partial tool JSON, usage deltas, errors, pings, and future additive event types. | Incremental parser, unknown-event tolerance, and fixture coverage. |
| [Gemini text generation](https://ai.google.dev/gemini-api/docs/text-generation) | Gemini supports multi-turn content and streamed generation through its official SDK/API. | Direct Gemini adapter and provider-native fixture set. |
| [xAI text generation](https://docs.x.ai/developers/model-capabilities/text/generate-text) | xAI documents direct text/chat generation and streaming behavior. | Direct xAI adapter rather than assuming generic compatibility. |
| [Mistral API](https://docs.mistral.ai/api/) | Mistral publishes a first-party chat API contract with streaming/tool fields. | Direct Mistral adapter and normalized capabilities. |
| [Cohere Chat API](https://docs.cohere.com/reference/chat) | Cohere publishes a first-party chat endpoint and response contract. | Direct Cohere adapter and normalized capabilities. |

Provider APIs disagree in event shape, reasoning controls, tool delta encoding, continuity, errors, and retention. The architecture therefore promises a common CUPCAKEAGI event model and honest per-model capability flags—not false feature parity.

## Storage, search, and documents

| Primary source | Material finding | Decision it supports |
|---|---|---|
| [SQLCipher design](https://www.zetetic.net/sqlcipher/design/) | SQLCipher encrypts SQLite pages and WAL pages, authenticates pages, supports raw vaulted keys, and warns that file-backed temporary stores need deliberate handling. | SQLCipher authoritative stores, broker-owned raw keys, encrypted WAL, memory temp policy. |
| [SQLite WAL](https://www.sqlite.org/wal.html) | WAL allows concurrent readers/writer on one host, requires checkpoint management, and the WAL is part of persistent state. | Local WAL configuration, snapshot discipline, and no network-filesystem database. |
| [SQLite FTS5](https://www.sqlite.org/fts5.html) | FTS5 provides full-text virtual tables, tokenization, prefix/phrase queries, ranking hooks, and external-content patterns. | Always-available lexical search baseline. |
| [SQLite Backup API](https://www.sqlite.org/backup.html) | The online backup API copies a consistent live database incrementally. | Consistent backup snapshots instead of copying an active DB file alone. |
| [Docling supported formats](https://docling-project.github.io/docling/usage/supported_formats/) | Docling covers PDF, Office, HTML, images, Markdown, CSV, and other structured formats with format-specific options. | Broad parser worker supplemented by streaming native parsers. |

SQLCipher protects files at rest but cannot protect content after the unlocked runtime decrypts it. It is therefore paired with process boundaries, vault keys, project filters, redaction, and restricted exports rather than presented as a complete privacy solution.

## Local inference

| Primary source | Material finding | Decision it supports |
|---|---|---|
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | Maintained local inference runtime with GGUF, quantization, CPU/GPU backends, and an OpenAI-compatible server mode. | App-managed Cupcake Local runtime and verified acceleration packs. |
| [Ollama API introduction](https://docs.ollama.com/api/introduction) | Ollama exposes a documented local API and model/runtime lifecycle. | Detect/manage Ollama through its API rather than UI automation. |
| [LM Studio developer docs](https://lmstudio.ai/docs/developer) | LM Studio exposes local developer APIs/SDKs and an API server. | Detect/use LM Studio through documented interfaces. |
| [vLLM serve](https://docs.vllm.ai/en/latest/cli/serve/) | vLLM exposes a configurable serving surface and many operational parameters. | Treat vLLM as an external endpoint; do not silently install/administer it. |

No upstream source can guarantee fit from parameter count alone. Quantization, context/KV cache, backend, offload, and concurrent load matter, so hardware recommendations are estimates until a real load/performance probe succeeds.

## MCP, credentials, and native containment

| Primary source | Material finding | Decision it supports |
|---|---|---|
| [MCP transports 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) | Standard transports are stdio and Streamable HTTP; stdout must contain only protocol messages; HTTP requires Origin validation and recommends localhost binding/authentication. | Supported transports, strict logging channels, origin/session/version controls. |
| [MCP authorization 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) | Requires OAuth security practice, PKCE, HTTPS/localhost redirects, resource indicators/audience validation, secure token storage, and forbids unsafe token use. | Remote MCP OAuth/PKCE, audience binding, short-lived vaulted tokens, no passthrough. |
| [MCP tools 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | Tools are discovered through descriptors/schemas and invoked through structured requests/results. | Descriptor/schema pinning and normalized broker contracts. |
| [Windows CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata) | DPAPI normally binds protected data to the same user credentials and computer and adds an integrity check. | Windows per-user vault wrapping; do not use machine-wide protection. |
| [Windows CryptUnprotectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata) | Documents unprotection, integrity caveats, and clearing sensitive memory. | Handle vault errors/tampering defensively and zeroize sensitive buffers where practical. |
| [Windows AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation) | AppContainer applies least-privilege file, network, credential, device, process, and window isolation. | Windows execution sandbox with no ambient capabilities. |
| [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) | Job Objects group process trees, enforce resource/time limits, account usage, and support kill-on-close. | Sandbox resource caps and complete descendant termination. |
| [Apple Keychain Services](https://developer.apple.com/documentation/security/keychain-services) | Keychain is Apple's native secret storage API. | macOS credential backend. |
| [freedesktop Secret Service](https://specifications.freedesktop.org/secret-service-spec/latest/) | Defines D-Bus collections/items, sessions, secret transfer, locking, and prompting; the current document remains a draft. | Linux secret backend, with session-only fallback when unavailable—not plaintext storage. |

The Linux Secret Service specification's draft status and desktop availability mean a universal persistent vault cannot be assumed. Failing to session-only credentials is an explicit product limitation, not an invitation to write a plaintext file.

## Accessibility and release

| Primary source | Material finding | Decision it supports |
|---|---|---|
| [WCAG 2.2](https://www.w3.org/TR/WCAG22/) | Defines testable accessibility success criteria including focus, input, reflow, contrast, target, and status behavior. | WCAG 2.2 AA acceptance and rendered/assistive verification. |
| [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing) | Desktop distribution platforms expect signed applications and macOS also requires notarization for normal distribution. | Signing is a public-release prerequisite, not silently assumed for the local RC. |
| [Microsoft MSIX signing](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview) | Deployable MSIX packages require a trusted signature; timestamping preserves validity and signing enables integrity enforcement. | Separate local test packaging from approved public signing/distribution. |

## Synthesis

The sources converge on a narrow privileged boundary, typed/versioned messages, explicit capability discovery, durable step boundaries, encrypted local canonical data, lexical search independent of embeddings, OS-native credential protection, and deny-by-default tool execution. The main tensions are resolved as follows:

- **SQLite vs “production” PostgreSQL:** DBOS recommends PostgreSQL for distributed production; CUPCAKEAGI is deliberately one local process on one device, so SQLite is the simpler correct boundary. Revisit only if cloud/multi-device execution enters scope.
- **Electron capability vs attack surface:** Electron supplies the required controlled renderer, but only with local content, sandboxing, context isolation, sender validation, restrictive CSP, and no generic bridge.
- **Uniform provider UX vs different APIs:** normalize lifecycle/provenance, expose real capability differences, and never coerce unsupported reasoning/tools.
- **Useful automation vs safe authority:** models propose typed intents; the broker resolves, discloses, authorizes, and executes exact effects.
- **Cross-platform ambition vs sandbox evidence:** build/smoke-test macOS and Linux, but keep arbitrary execution disabled until native containment passes the Windows-equivalent suite.
