# ADR-0007: One-time legacy migration

**Status:** Accepted
**Date:** 2026-08-28

## Context

The 2023 application stores mutable user state alongside source code. The 2.0 schema cannot safely reuse it, but user-authored conversation, tasks, personality, and provenance should not be discarded. The legacy directory may also contain secrets, generated code, caches, and inconsistent partial writes.

## Decision

Provide an explicit, read-only, idempotent importer. It never runs automatically merely because a legacy directory exists. The user selects the source root, sees a preview, chooses import, and receives a permanent report.

The importer fingerprints the source root and each candidate file using relative path, size, modification time, and content digest. A migration ledger records importer version, source fingerprint, item fingerprint, target ID, disposition, and error. Re-running skips already imported items and can resume after interruption without duplicating messages, tasks, memories, or artifacts.

## Mapping

| Legacy data | 2.0 disposition |
|---|---|
| `state_of_mind/conversation.json` | Immutable imported conversation branch; preserve order and safe attachment references; mark unknown/malformed fields in report |
| `state_of_mind/task_list.json` | Historical tasks; incomplete tasks are imported paused and never auto-executed |
| `personality.txt` | Reviewable imported custom-instruction candidate, inactive until user confirms |
| `thought_bubble.txt` and dream/random-thought output | Optional temporary-context or memory candidates, inactive by default |
| Emotion/sensory scalar text files | Migration-report snapshot only; never active instructions or memory |
| `abilities.json` and ability scripts | Names/descriptions listed as untrusted legacy-tool candidates; code is never registered or executed |
| Referenced user files | Copy through the broker into encrypted objects after containment, size, type, and parser checks |
| `tempfiles/`, generated scripts, requirements, outputs, caches/bytecode | Excluded by default; user may separately import a specific benign output as a file |
| Original mascot/assets | Product build asset provenance, not user-data migration |

The importer categorically ignores `.env`, environment variables, API keys/tokens, credential-looking fields, provider SDK state, Chroma/vector cache data, compiled bytecode, and dependency environments. It does not print possible secret values in preview, reports, or logs. The UI instructs the user to rotate any credential that may have existed in the tracked legacy `.env`.

Malformed data is isolated per item. The importer records validation errors and continues safe items; it never repairs the source. All target writes occur in a transaction plus staged-object protocol. Cancellation leaves the migration ledger and committed items consistent.

## Compatibility and provenance

Imported records carry `source_system = cupcakeagi-v1`, source fingerprint, importer version, original timestamp when trustworthy, import time, and a link to the migration report. Legacy IDs/timestamps are metadata only; new UUIDv7 IDs are primary identities.

Git history and `v1.0.0` remain the authoritative preservation of old source. Migration is not permission to retain the legacy runtime in packaged 2.0.

## Consequences

- Valuable user history is preserved without inheriting execution or credential risk.
- Some legacy “state of mind” data becomes a report/candidate rather than active behavior.
- A user can safely retry an interrupted migration and audit every skipped item.

## Verification

- Golden fixtures for pristine, empty, large, partially written, malformed, duplicate, path-traversal, symlink, missing-attachment, and secret-bearing legacy trees.
- Interrupt at every item/object phase, rerun, and prove exactly-once target records.
- Scan target databases, objects, report, and logs to prove API keys and `.env` values were not imported.
