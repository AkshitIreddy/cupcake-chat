# ADR-0002: Encrypted storage, immutable objects, and retrieval

**Status:** Accepted **Date:** 2026-08-28

## Context

Flat files cannot atomically represent branching conversations, revisioned artifacts, typed memory,
durable tasks, provenance, or recovery. The application also needs fast offline search and backups
without making an embedding service authoritative.

## Decision

Use three independent encrypted stores plus an encrypted object directory:

1. `product.sqlite`: authoritative CUPCAKEAGI product data in SQLCipher SQLite.
2. `workflow.sqlite`: DBOS workflow/step state; operational, version-bound, and never a product
   export format.
3. `security.sqlite`: broker-owned grants, approval state, idempotency/effect records, audit
   metadata, and MCP schema digests.
4. `objects/`: immutable encrypted content for imported files and artifact revisions.

The broker obtains a per-user master key protected by Windows DPAPI (user scope, never machine
scope) and derives independent database, object-encryption, and object-address keys with HKDF and
explicit domain labels. It gives scoped database keys to Python over the authenticated channel,
never to main or renderer. SQLCipher uses WAL, `synchronous=FULL` for authoritative stores, foreign
keys, bounded busy timeouts, application-managed checkpoints, secure-delete policy, and
memory-backed temporary storage.

Each object is addressed by `HMAC-SHA-256(object-address-key, plaintext)` so equal local content
deduplicates without exposing a plain SHA-256 filename. The plaintext is encrypted with a random
data key and AES-256-GCM; the data key is wrapped by the object-encryption key. Header/version,
opaque address, length, MIME, nonce, and associated metadata are authenticated. An object becomes
visible only after ciphertext fsync, integrity verification, and transactional metadata insertion.
Garbage collection deletes only objects unreachable from a committed record and older than a
quarantine interval.

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
  then copy exactly the encrypted objects reachable from the snapshots.
- A signed manifest records format version, app version, store hashes, object addresses/sizes, and
  creation time. Backups are encrypted with a user-supplied passphrase-derived wrapping key or an
  explicitly selected recovery key; they do not depend solely on the current machine vault.
- Restore validates manifest, authentication tags, schema compatibility, object reachability, and
  free disk space into a new directory, then atomically swaps only after full verification. Never
  restore over the sole readable copy.

## Consequences

- SQLCipher protects content at rest, while Windows per-user DPAPI binding protects keys. Neither
  protects data visible to a running, unlocked process; least privilege and redaction remain
  required.
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
