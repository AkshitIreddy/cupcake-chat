# ADR-0002: Optional content encryption, immutable objects, and retrieval

**Status:** Accepted, amended 2026-09-05 **Date:** 2026-08-28

## Context

Flat files cannot atomically represent branching conversations, revisioned artifacts, typed memory,
durable tasks, provenance, or recovery. The application also needs fast offline search and backups
without making an embedding service authoritative.

## Decision

Use separate stores with an explicit, optional protection boundary:

1. The active product database is authoritative CupcakeAI product data. It uses SQLCipher when
   content encryption is on and ordinary SQLite when the owner explicitly turns it off.
2. `cupcake-runtime.db` and `cupcake-dbos-system.db` contain operational, version-bound workflow
   state in ordinary SQLite and are never a product export format.
3. `security.sqlite`: broker-owned grants, approval state, idempotency/effect records, audit
   metadata, and MCP schema digests in ordinary SQLite. The native audit hash chain is plaintext
   JSONL. Neither store contains provider credentials.
4. The active `objects/` generation holds immutable content for imported files and artifact
   revisions. It uses AES-256-GCM when content encryption is on and raw bytes when it is off.

The broker obtains a per-user master key protected by Windows DPAPI (user scope, never machine
scope) and derives independent database and object-encryption keys with explicit domain labels. It
gives the profile key only to the private Python runtime over the authenticated channel, never to
main or renderer. SQLCipher uses WAL, `synchronous=FULL`, foreign keys, bounded busy timeouts,
application-managed checkpoints, and memory-backed temporary storage.

Each object is currently addressed by ordinary `SHA-256(plaintext)`, so equal content deduplicates
but object names reveal equality and are not keyed. Encrypted mode uses a random AES-GCM nonce and
binds the object ID as authenticated data. An object becomes visible only after file sync, atomic
publication, and read-back verification. Garbage collection deletes only objects unreachable from
an authoritative record.

## Product data model

- UUIDv7 product IDs identify conversations, branches, messages, runs, tasks, tools, approvals,
  projects, files, memories, artifacts, and revisions.
- Messages and artifact revisions are immutable DAG nodes with parent IDs; mutable branch heads
  advance transactionally. Edit/regenerate creates a sibling node.
- Canonical `RunEvent` rows are append-only and ordered per run. Provider events/IDs are optional
  provenance metadata.
- Project ownership is non-null for project-scoped rows and enforced in repository methods, SQL
  predicates, and tests.
- Soft deletion creates tombstones immediately; irreversible compaction is a separate retention
  operation.

## Search and parsing

SQLite FTS5 is the always-available lexical index for messages, file chunks, memories, tasks, and
artifacts. Ranking retains stable source locators and record IDs. Embeddings/vector indexes are
derived caches keyed by source revision, embedding model/version, chunker version, and project ID;
deleting them cannot lose product data.

Text/code/log formats use streaming native parsers. Docling handles supported office, PDF, HTML,
image, and structured document formats in a network-disabled worker. Every chunk records a stable
locator—page, heading path, sheet/range, code line range, archive entry, or media time span—plus
content hash and parser version. Parsers enforce byte, page, cell, nesting, expansion-ratio,
wall-time, and child-process limits.

Retrieval is two-stage: project-filtered FTS candidates first, optional project-filtered semantic
candidates second, then deterministic fusion/reranking. Results with missing provenance are
ineligible for citation. Search remains useful while semantic indexing is unavailable or rebuilding.

## Backup and restore

- Pause new writes, checkpoint WAL, use SQLite's online backup/snapshot mechanism for each database,
  then copy exactly the objects reachable from the snapshots.
- An authenticated manifest records format version, app version, store hashes, object addresses/sizes, and
  creation time. Version-2 containers encrypt the complete runtime and broker-security payloads
  with chunked AES-256-GCM under a key derived from the profile key. A portable passphrase wraps
  that profile key; same-user mode retains its DPAPI dependency. Version-1 readers remain for old
  plaintext outer containers.
- Restore validates manifest, authentication tags, schema compatibility, object reachability, and
  free disk space into a new directory, then atomically swaps only after full verification. Never
  restore over the sole readable copy.

## Consequences

- SQLCipher and object encryption protect the selected main content generation at rest. Windows
  per-user DPAPI protects credentials and the profile key. Workflow, policy/audit, and diagnostic
  stores remain plaintext. None of these controls protects data visible to a running, unlocked
  process; least privilege and redaction remain required.
- WAL improves local read/write concurrency but all database users must remain on one host. This
  matches the single-device product boundary.
- DBOS state is intentionally separate because workflow upgrades and retention differ from user
  content.
- Derived indexes can lag, fail, or rebuild without affecting canonical history.

## Verification

- Test wrong/corrupt keys, tampered pages/objects, power loss at every object commit phase, WAL
  recovery, migration rollback, DAG properties, branch conflicts, and tombstones.
- Prove project-filtered queries before ranking and no cross-project result under adversarial
  fixtures.
- Restore backups with missing/extra/corrupt objects and verify refusal without damaging the active
  store.
- Benchmark FTS at 100,000 indexed records against the 250 ms p95 reference budget.
