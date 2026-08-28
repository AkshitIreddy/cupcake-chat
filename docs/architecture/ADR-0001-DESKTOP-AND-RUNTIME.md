# ADR-0001: Desktop and runtime boundaries

**Status:** Accepted
**Date:** 2026-08-28

## Context

CUPCAKEAGI must provide a consistent, highly polished desktop chat surface while packaging model orchestration, durable work, encrypted state, native tools, and OS security without asking users to install Node, Python, Conda, or a server. The legacy browser/server split exposes a localhost API and gives generated code ambient authority.

## Decision

Use four sharply bounded layers:

- **React/TypeScript/Vite renderer:** presentation, accessibility, drafts, navigation, and streamed view state only.
- **Electron main/preload:** windows, tray, native dialogs, lifecycle, sidecar supervision, typed bridge, event routing, and packaging/update hooks.
- **Packaged Python runtime:** Pydantic AI provider mechanics, canonical agent loop, DBOS workflows, context assembly, memory, retrieval, model management, cost accounting, and product persistence.
- **Small Rust broker:** credential vault, filesystem grants, tool policy, approvals, MCP clients, data-flow disclosures, audit, and sandboxed process execution.

The installed application bundles Python and the broker. Main launches each with inherited private pipes; no component listens on a public or loopback product API. The authenticated framing and boot sequence are defined in [System overview](SYSTEM_OVERVIEW.md).

Electron uses only packaged local content and a custom application protocol. Every renderer has `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, a restrictive CSP, blocked unexpected navigation/window creation, explicit permission handlers, and validated IPC senders. Preload exposes one typed method per product operation and never exposes `ipcRenderer` or a generic `send` function.

Main does not open product databases, hold provider credentials, assemble prompts, or execute arbitrary tool calls. Python never reads the OS vault or performs broker-governed effects. The broker never interprets natural language or owns conversation semantics.

## Public contracts

- `ProtocolEnvelope` is the only sidecar envelope and follows the framing/version rules in System overview.
- Renderer bridge methods accept opaque product/resource IDs and serializable product DTOs. Native paths remain outside the renderer.
- Sidecars expose `hello`, `health`, `shutdown`, `cancel`, request/response, and ordered event-stream message families.
- A graceful shutdown gives Python time to checkpoint and the broker time to terminate owned sandboxes; forced shutdown preserves recoverability rather than fabricating completion.

## Consequences

- The app has one controlled Chromium renderer and one installer while using the best-fit language for orchestration and native policy.
- Cross-language schemas and packaging are mandatory engineering work.
- A compromised renderer still reaches privileged functionality only through narrow, validated product commands.
- Main remains restart/supervision infrastructure rather than becoming a second business-logic backend.

## Rejected alternatives

- **Retain Next.js + FastAPI localhost:** larger exposed attack surface, separate launch lifecycle, weak desktop integration.
- **All Electron/Node:** simplifies packaging but concentrates provider, persistence, and native security authority in one runtime and discards the approved Pydantic/DBOS path.
- **All Rust:** strong native boundary but high provider/orchestration cost with no user-visible advantage.
- **Tauri-only UI:** viable, but Electron is selected for consistent Chromium behavior and mature accessibility/automation for this chat-first surface.

## Verification

- Security tests prove no renderer access to Node, raw IPC, credentials, paths, processes, databases, or sidecar handles.
- Fuzz framing, malformed schemas, ordering, replay, deadlines, sidecar crashes, and shutdown races.
- A packaged Windows install starts without system Node/Python and shows an interactive shell within the 3-second reference budget.
