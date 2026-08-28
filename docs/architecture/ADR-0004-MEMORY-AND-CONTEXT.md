# ADR-0004: Memory, context, and project isolation

**Status:** Accepted
**Date:** 2026-08-28

## Context

The legacy “state of mind” mixes conversation, personality, emotions, memory, and transient thoughts in prompt-visible files. CUPCAKEAGI 2.0 needs useful persistence without hidden steering, unverifiable claims, or cross-project leakage.

## Decision

Memory is an explicit, typed, versioned product record—not a transcript dump or provider feature. A memory has:

- type: preference, fact, instruction, decision, event, task state, or temporary context;
- scope: global or one project (conversation-only context stays on the conversation and is not memory);
- normalized content and optional structured value;
- provenance: explicit user action, source message/file locator, task, or inference candidate;
- confidence, sensitivity, created/updated/last-used time, optional expiry;
- revision parent and lifecycle state: candidate, active, superseded, expired, or tombstoned.

An explicit “remember” command creates an active record immediately after showing scope. Inferred records begin as candidates. Sensitive facts and all inferred instructions require confirmation before activation. “Forget” creates a tombstone immediately and invalidates derived indexes/context caches; physical encrypted-object compaction follows retention policy.

Conflict handling never silently merges incompatible instructions/facts. The context builder selects the newest applicable confirmed record, marks the conflict for review, and preserves both revisions. User edits create a revision rather than rewriting provenance.

## Context assembly

For every run, Python constructs a deterministic context manifest in this order:

1. product safety and agent contract;
2. user-selected personality preset/sliders and visible custom instructions;
3. active project contract and explicit current references;
4. canonical visible branch history within budget;
5. confirmed, unexpired memories allowed by scope;
6. project-filtered retrieved file/conversation excerpts with locators;
7. enabled tool descriptors and destination disclosures;
8. current user message.

Each component records source ID, scope, revision, token estimate, selection reason, and outbound destination. Budget pressure drops lowest-priority retrieved context first, never system safety or the current message. Summaries are versioned derived artifacts with source coverage; they do not replace canonical messages.

Project isolation is enforced before candidate generation. A project run cannot query global indexes and filter later: SQL/repository access must include `project_id`, with global memories admitted only through a distinct explicit path. No project file, memory, or excerpt crosses to another project or a cloud provider outside the current manifest.

The renderer receives a safe Context Inspector projection: labels, scopes, citations, token contribution, selection reason, model, enabled tools, and Local/Cloud destinations. It does not receive hidden chain-of-thought, provider reasoning internals, raw secrets, or unrestricted native paths.

Thoughts/Dreams are disabled by default. When enabled, a bounded background consolidation workflow proposes at most one quiet suggestion in Home/sidebar. It may create memory candidates but not active instructions, messages, notifications, or tool calls. Dismissal is persisted; sensitive candidates still require confirmation.

## Consequences

- Users can understand and reverse durable personalization.
- Context is reproducible from a manifest even when derived indexes change.
- Explicit project predicates add implementation discipline but make privacy testable.
- Proactive behavior remains a low-noise review queue, not simulated consciousness or hidden autonomy.

## Verification

- Test each type/scope/state, revisions, expiry, tombstones, conflicts, and conversational remember/forget/query commands.
- Generate adversarial same-key memories in two projects and prove no cross-project selection, search result, cache entry, or outbound request.
- Snapshot context manifests under token pressure and verify deterministic ordering/provenance.
- Confirm inferred/sensitive instructions cannot become active without approval and Thoughts/Dreams remains inert when disabled.
