# CUPCAKEAGI 2.0 architecture

These records are the implementation contract for the text-first CUPCAKEAGI 2.0 local release
candidate. An ADR marked **Accepted** is binding unless it is replaced by a later ADR. The legacy
implementation remains useful evidence, but it is not an architectural constraint.

## Start here

- [Repository audit](REPOSITORY_AUDIT.md) — what exists, what is retained, and why the 2023
  implementation cannot be extended safely.
- [Product proposal](PRODUCT_PROPOSAL.md) — product behavior, navigation, signature design,
  accessibility, and acceptance boundaries.
- [System overview](SYSTEM_OVERVIEW.md) — trust boundaries, process topology, canonical data flows,
  invariants, and failure behavior.
- [Research ledger](RESEARCH_LEDGER.md) — primary sources and the decisions they support.

## Accepted decisions

1. [ADR-0001: Desktop and runtime boundaries](ADR-0001-DESKTOP-AND-RUNTIME.md)
2. [ADR-0002: Encrypted storage, objects, and retrieval](ADR-0002-STORAGE-AND-RETRIEVAL.md)
3. [ADR-0003: Cloud providers and local models](ADR-0003-MODELS.md)
4. [ADR-0004: Memory, context, and project isolation](ADR-0004-MEMORY-AND-CONTEXT.md)
5. [ADR-0005: Tools, MCP, approvals, and sandboxing](ADR-0005-TOOLS-AND-SECURITY.md)
6. [ADR-0006: Durable tasks, subagents, and recovery](ADR-0006-DURABLE-TASKS.md)
7. [ADR-0007: One-time legacy migration](ADR-0007-MIGRATION.md)
8. [ADR-0008: Packaging, release, and platform posture](ADR-0008-RELEASE.md)

## Non-negotiable release boundaries

- Text is the primary interface. Voice and automatic model routing are absent.
- The application is local, single-user, and usable without a CUPCAKEAGI account.
- Provider and tool framework objects are adapters, never persisted product truth.
- The renderer has no Node.js, filesystem, credential, arbitrary IPC, or process access.
- Windows 10/11 x64 is the sole native target, with per-user DPAPI credential protection.
- Project scope is a privacy boundary applied before retrieval or outbound model calls.
- Generated code never runs outside the broker's restricted-token/AppContainer-style staged sandbox
  and Job Object.
- No push, publication, live update feed, or public release may occur before explicit user approval
  after local RC testing.
