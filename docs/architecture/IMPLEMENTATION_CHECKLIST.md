# CUPCAKEAGI 2.0 implementation checklist

This is the live completion ledger for the local 2.0 release candidate. An item is complete only
when its implementation and its relevant verification both exist. The release candidate is not
published or pushed before the owner's explicit approval.

The implementation and automated/local evidence below are complete for the Windows x64 candidate
except for the separately documented strict Python type-check gate. Owner acceptance of the unpacked
app and unsigned installer is still required before this becomes a release. Web search remains an
explicit endpoint opt-in, and voice/automatic routing remain omitted by contract.

## 1. Repository and decisions

- [x] Flatten the nested clone without losing Git history.
- [x] Create the local `feat/cupcakeagi-2.0` branch.
- [x] Normalize line endings without accepting semantic legacy changes.
- [x] Record repository, product, desktop, runtime, model, memory, tool, migration, and release
      decisions.
- [x] Remove tracked secrets, bytecode, generated state, and unsafe legacy runtime code from the
      active 2.0 tree while preserving Git history.

## 2. Platform and contracts

- [x] Windows 10/11 x64-only support gate; non-Windows and non-x64 packaging rejected.
- [x] React/TypeScript/Vite renderer and hardened Electron main/preload.
- [x] Packaged Python runtime boundary and framed protocol.
- [x] Rust ToolBroker with framed protocol, policy, grants, audit, and per-user Windows DPAPI vault.
- [x] Versioned JSON Schemas and deterministic generated TS/Python/Rust types with CI drift checks.
- [x] Product, runtime, and security persistence with migrations and backups.

## 3. Chat and visual system

- [x] Home, shelf, chat, composer, model picker, context inspector, and command palette.
- [x] Streaming rich responses, code, math, tables, citations, tools, files, tasks, artifacts,
      message actions, and non-destructive branches.
- [x] Frosting Thread long-conversation navigation.
- [x] Cupcake Light, Dark, Minimal, and Classic themes.
- [x] Responsive, keyboard, reduced-motion, zoom, and WCAG 2.2 AA behavior.

## 4. Models and local inference

- [x] Direct adapters for OpenAI, Anthropic, Gemini, xAI, Mistral, Cohere, and NVIDIA-hosted NIM.
- [x] Generic OpenAI-compatible endpoint support.
- [x] Explicit model selection, reasoning controls, capability catalog, cost, usage, and privacy
      disclosures; no automatic routing.
- [x] Cupcake Local llama.cpp management plus Ollama, LM Studio, and external vLLM support.
- [x] Hardware estimates, downloads, verification, load/unload, removal, and tokens-per-second
      reporting.

## 5. Workspace, files, search, and artifacts

- [x] Conversation lifecycle, immutable DAG branching, projects, and project context boundaries.
- [x] Live read-only repository grants, safe indexing, and approved patch application.
- [x] Structured ingestion, stable citation locators, FTS5 search, and derived semantic retrieval.
- [x] Rich file objects, @ references, artifact preview/edit/revision/export, and global search.

## 6. Memory and proactive features

- [x] Typed/scoped/versioned memories with evidence, conflict, expiry, disable, delete, and
      tombstones.
- [x] Memory UI and conversational remember, forget, and query flows.
- [x] Context assembly and inspector with local/cloud destination visibility.
- [x] Disabled-by-default quiet Thoughts and Dreams.

## 7. Tools, MCP, and security

- [x] Native file/repository, web, Git, Python, model, and artifact tools.
- [x] Registry, exact preflight, approval binding, grants, disclosure, audit, cancellation, and
      recovery.
- [x] Windows restricted-token/AppContainer-style staged execution with Job Object
      resource/process-tree limits and no raw shell API.
- [x] Local stdio and remote Streamable HTTP MCP with OAuth/PKCE and SSRF defenses.
- [x] Out-of-process custom tool SDK.

## 8. Durable work and developer experience

- [x] Automatic long-task promotion, durable checkpoints, restart recovery, steering, queued
      follow-ups, and approvals across restart.
- [x] Bounded researcher, coder, reviewer, and document-analyst subagents.
- [x] Tasks and task-detail screens.
- [x] Redacted Developer Mode events, traces, costs, retrieval, checkpoints, subagents, and errors
      with retention controls.
- [x] Personality presets and custom controls.

## 9. Migration, docs, packaging, and release-candidate gate

- [x] Idempotent legacy flat-file importer that never imports old API keys.
- [x] Full README, architecture docs, local testing guide, known issues, and original-project
      history.
- [x] Windows 10/11 x64 installer/package smoke tests; Forge and CI reject all other
      platform/architecture targets.
- [x] Unit, integration, provider, local-model, durability, security, accessibility, performance,
      and end-to-end tests.
- [ ] Strict Python type checking. The explicit project configuration exposes existing runtime/test
      debt; see [known issues](../known-issues.md#strict-python-type-check-debt).
- [x] Playwright interaction checks plus inspected full-frame and close-up screenshots for required
      viewports and themes.
- [x] Local release-candidate summary and exact owner testing instructions.
- [x] No push, publish, updater feed, package release, or GitHub release before explicit approval.
