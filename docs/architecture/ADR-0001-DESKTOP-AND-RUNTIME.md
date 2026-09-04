# ADR-0001: Tauri desktop and runtime boundaries

**Status:** Accepted (supersedes the rejected desktop-host decision)

**Date:** 2026-08-29

## Context

CupcakeAI needs a polished Windows 10/11 x64 workbench without requiring users to install Node,
Python, Conda, or a model server. The renderer must remain untrusted while native lifecycle,
credentials, durable state, providers, and tools keep narrow ownership.

## Decision

Use four layers:

- React/TypeScript/Vite renderer for presentation, accessibility, drafts, navigation, and view
  state;
- Tauri 2 Rust host for window/tray/dialog/deep-link policy, typed commands/events, capabilities,
  sidecar verification/supervision, and packaging;
- packaged Python runtime for provider adapters, canonical agent behavior, tasks, retrieval, memory,
  persistence, and Cupcake Local;
- Rust ToolBroker for DPAPI credentials, grants, approvals, native tools, MCP, audit, and
  sandboxing.

The application contains no public localhost product API. Sidecars communicate over authenticated,
bounded, length-prefixed private streams. The renderer receives only serializable DTOs and opaque
handles through explicit Tauri commands/events.

The user-facing workspace password is optional and disabled by default. An absent lock record is an
unlocked profile: fresh and ordinary profiles open directly, while explicitly password-protected
profiles keep sidecars stopped until successful unlock. Credential-vault and encrypted-storage
boundaries remain background implementation safeguards and do not create a first-run security
choice.

The Tauri window is undecorated and implements one custom titlebar. Only intended empty regions are
draggable; minimize, maximize/restore, close, menus, and content are non-draggable semantic
controls. Capabilities are Windows-only, local-only, window-scoped, and generated from the exposed
command set.

## Ownership

- Host does not own provider/product business logic or persist credentials in renderer-readable
  state.
- Runtime does not read the vault or perform broker-governed effects.
- Broker does not interpret prompts or own conversation semantics.
- Renderer has no raw path, credential, sidecar handle, arbitrary command, process, or network API.

## Verification

Test commands/events, capability scope, invalid input, sidecar tamper/replay/sequence/deadline,
navigation/origin policy, graceful/forced shutdown, restart recovery, deep links, tray, custom
titlebar, DPI/zoom, and clean packaged startup. Native claims require the real Tauri/WebView2 app.
