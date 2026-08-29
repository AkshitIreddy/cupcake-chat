# ADR-0006: Durable tasks, subagents, and recovery

**Status:** Accepted **Date:** 2026-08-28

## Context

Users must keep chatting while long work runs and resume after navigation, window close, process
crash, or restart. Retrying nondeterministic model calls or side effects blindly can duplicate cost
and external changes.

## Decision

Use DBOS workflows in the packaged Python runtime, backed by a separate local SQLite system
database. This is intentionally a single-process, single-device deployment; DBOS's recommendation
for PostgreSQL in distributed production does not apply unless the product boundary changes.

A chat run is promoted to a durable task when explicitly requested or preflight detects
repository/document indexing, code execution, artifact generation, multiple dependent tool stages,
or estimated duration over 20 seconds. Promotion keeps the same run lineage and conversation branch;
it does not copy the conversation into a second model of truth.

Checkpoint every nondeterministic or side-effecting boundary:

- provider request/terminal response identity and canonical event append;
- tool preflight and approval/input-required state;
- broker effect idempotency key and terminal result;
- parser/index batch cursor;
- artifact revision commit;
- subagent dispatch/terminal result;
- queued follow-up consumption and cancellation.

Workflow code may replay; effect steps may not. Before executing, the broker atomically claims the
idempotency key. A repeated request returns the recorded terminal result or “in progress,” never
repeats the effect. Provider retry policy distinguishes “not accepted,” “accepted with known
response ID,” and “unknown outcome”; unknown outcome requires reconciliation or user choice before
spending again.

## State machine

Task states are `queued`, `working`, `input_required`, `paused`, `cancelling`, `completed`,
`failed`, and `cancelled`. Completed/failed/cancelled are terminal. Every transition appends one
canonical event and uses optimistic versioning. Progress is stage-based and may be indeterminate; it
is never fabricated from elapsed time.

Steering messages are applied at a declared safe checkpoint. Other follow-ups are queued FIFO with
stable IDs and can be removed before consumption. Cancellation propagates from parent to
subagents/tools; the broker terminates owned process trees after a grace period. Completed effects
remain audited and are not rolled back unless the tool defines an explicit compensating action.

## Subagents

Subagents are registered product roles—researcher, coder, reviewer, and document analyst—not
arbitrary prompts with ambient tools. Each has isolated canonical history, explicit model/tool
allowlist, token/cost/time budget, project scope, parent run/task ID, shared cancellation, and
bounded result schema. Normal chat receives concise stage events; Developer Mode can inspect the
redacted run tree.

No subagent may widen project scope, permissions, destination, budget, or approval. A subagent tool
intent is attributed to both child and parent and follows the same broker policy.

## Recovery and compatibility

Startup recovers interrupted workflows from completed steps and republishes canonical events from
the last acknowledged sequence. Event IDs and broker idempotency keys deduplicate UI and effects.
Pending approvals are revalidated against tool version/schema, resources, policy, and expiry; stale
approvals become `input_required` with a new preflight.

Each checkpoint records application workflow version. Compatible releases provide deterministic
migration/replay tests. An incompatible checkpoint is quarantined and shown as “needs recovery
update”; it is never silently restarted under changed logic. Product history remains readable even
if a workflow cannot resume.

Developer Mode exposes redacted events, approvals, tool payload summaries, usage/cost, latency,
retrieval provenance, checkpoints, subagents, failures, and OpenTelemetry trace/span identifiers. It
never exposes chain-of-thought or secrets.

## Consequences

- Tasks survive UI and process lifecycle without an external orchestrator.
- Side-effect design requires idempotency and explicit unknown-outcome handling.
- Workflow code/version changes need compatibility fixtures before upgrade.
- SQLite is sufficient only while execution is single-host and not horizontally distributed.

## Verification

- Kill main, Python, broker, and the full app at every checkpointed phase; restart and prove
  recovery without duplicated provider charges, effects, or event cards.
- Test cancellation races, stale approvals, queued steering/follow-ups, parent/child failure, budget
  exhaustion, unknown provider outcome, and incompatible workflow versions.
- Recovering tasks appear within 5 seconds of restart on the reference machine.
