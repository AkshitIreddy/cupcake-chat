# CupcakeAI 2.0 architecture

These records govern the corrective Windows Tauri 2 implementation. An accepted ADR remains binding
unless a later decision replaces it. Historical audits and research are evidence, not current
architecture.

## Current decisions

1. [Desktop and runtime boundaries](ADR-0001-DESKTOP-AND-RUNTIME.md)
2. [Encrypted storage, objects, and retrieval](ADR-0002-STORAGE-AND-RETRIEVAL.md)
3. [Hosted providers and Cupcake Local](ADR-0003-MODELS.md)
4. [Memory, context, and project isolation](ADR-0004-MEMORY-AND-CONTEXT.md)
5. [Tools, MCP, approvals, and sandboxing](ADR-0005-TOOLS-AND-SECURITY.md)
6. [Durable tasks, subagents, and recovery](ADR-0006-DURABLE-TASKS.md)
7. [One-time legacy migration](ADR-0007-MIGRATION.md)
8. [Packaging and local-only release posture](ADR-0008-RELEASE.md)
9. [Attributed Cupcakes and bounded group conversations](ADR-0009-GROUP-CONVERSATIONS.md)

Start with [System overview](SYSTEM_OVERVIEW.md) and the live
[implementation checklist](IMPLEMENTATION_CHECKLIST.md). The [repository audit](REPOSITORY_AUDIT.md)
and [research ledger](RESEARCH_LEDGER.md) contain historical baseline material and must not override
the corrective handoff.

## Non-negotiable boundaries

- Windows 10/11 x64, local single-user, text-first.
- Tauri 2 host; no rejected desktop runtime or packaging path.
- In-app provider setup with DPAPI storage and no generic credential prompt.
- Cupcake Local is the installed local-model manager; no separately installed local server is
  needed.
- Explicit model selection; no silent privacy/cost route crossing.
- Renderer has no raw filesystem, credential, process, shell, or network primitive.
- Project scope is a privacy boundary.
- Generated code is staged, bounded, network/credential-free by default, and process-tree contained.
- No publication, distribution, production signing, release, or updater without owner approval.
