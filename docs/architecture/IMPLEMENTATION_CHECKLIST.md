# CUPCAKEAGI 2.0 implementation checklist

This is the live completion ledger for the local 2.0 release candidate. An item
is complete only when its implementation and its relevant verification both
exist. The release candidate is not published or pushed before the owner's
explicit approval.

## 1. Repository and decisions

- [x] Flatten the nested clone without losing Git history.
- [x] Create the local `feat/cupcakeagi-2.0` branch.
- [x] Normalize line endings without accepting semantic legacy changes.
- [ ] Record repository, product, desktop, runtime, model, memory, tool,
  migration, and release decisions.
- [ ] Remove tracked secrets, bytecode, generated state, and unsafe legacy
  runtime code from the active 2.0 tree while preserving Git history.

## 2. Platform and contracts

- [ ] React/TypeScript/Vite renderer and hardened Electron main/preload.
- [ ] Packaged Python runtime boundary and framed protocol.
- [ ] Rust ToolBroker with framed protocol, policy, grants, audit, and vault.
- [ ] Versioned JSON Schemas and generated or equivalent TS/Python/Rust types.
- [ ] Product, runtime, and security persistence with migrations and backups.

## 3. Chat and visual system

- [ ] Home, shelf, chat, composer, model picker, context inspector, and command
  palette.
- [ ] Streaming rich responses, code, math, tables, citations, tools, files,
  tasks, artifacts, message actions, and non-destructive branches.
- [ ] Frosting Thread long-conversation navigation.
- [ ] Cupcake Light, Dark, Minimal, and Classic themes.
- [ ] Responsive, keyboard, reduced-motion, zoom, and WCAG 2.2 AA behavior.

## 4. Models and local inference

- [ ] Direct adapters for OpenAI, Anthropic, Gemini, xAI, Mistral, and Cohere.
- [ ] Generic OpenAI-compatible endpoint support.
- [ ] Explicit model selection, reasoning controls, capability catalog, cost,
  usage, and privacy disclosures; no automatic routing.
- [ ] Cupcake Local llama.cpp management plus Ollama, LM Studio, and external
  vLLM support.
- [ ] Hardware estimates, downloads, verification, load/unload, removal, and
  tokens-per-second reporting.

## 5. Workspace, files, search, and artifacts

- [ ] Conversation lifecycle, immutable DAG branching, projects, and project
  context boundaries.
- [ ] Live read-only repository grants, safe indexing, and approved patch
  application.
- [ ] Structured ingestion, stable citation locators, FTS5 search, and derived
  semantic retrieval.
- [ ] Rich file objects, @ references, artifact preview/edit/revision/export,
  and global search.

## 6. Memory and proactive features

- [ ] Typed/scoped/versioned memories with evidence, conflict, expiry,
  disable, delete, and tombstones.
- [ ] Memory UI and conversational remember, forget, and query flows.
- [ ] Context assembly and inspector with local/cloud destination visibility.
- [ ] Disabled-by-default quiet Thoughts and Dreams.

## 7. Tools, MCP, and security

- [ ] Native file/repository, web, Git, Python, model, and artifact tools.
- [ ] Registry, exact preflight, approval binding, grants, disclosure, audit,
  cancellation, and recovery.
- [ ] Sandboxed staged execution with bounded resources and no raw shell API.
- [ ] Local stdio and remote Streamable HTTP MCP with OAuth/PKCE and SSRF
  defenses.
- [ ] Out-of-process custom tool SDK.

## 8. Durable work and developer experience

- [ ] Automatic long-task promotion, durable checkpoints, restart recovery,
  steering, queued follow-ups, and approvals across restart.
- [ ] Bounded researcher, coder, reviewer, and document-analyst subagents.
- [ ] Tasks and task-detail screens.
- [ ] Redacted Developer Mode events, traces, costs, retrieval, checkpoints,
  subagents, and errors with retention controls.
- [ ] Personality presets and custom controls.

## 9. Migration, docs, packaging, and release-candidate gate

- [ ] Idempotent legacy flat-file importer that never imports old API keys.
- [ ] Full README, architecture docs, local testing guide, known issues, and
  original-project history.
- [ ] Windows installer/package smoke test and macOS/Linux build definitions.
- [ ] Unit, integration, provider, local-model, durability, security,
  accessibility, performance, and end-to-end tests.
- [ ] Playwright interaction checks plus inspected full-frame and close-up
  screenshots for required viewports and themes.
- [ ] Local release-candidate summary and exact owner testing instructions.
- [ ] No push, publish, updater feed, package release, or GitHub release before
  explicit approval.
