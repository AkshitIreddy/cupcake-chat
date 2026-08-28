# ADR-0008: Packaging, release, and platform posture

**Status:** Accepted
**Date:** 2026-08-28

## Context

The goal is a Windows-first local release candidate, not a public release. No production signing certificate or update endpoint is assumed. The package must include Electron, Python, Rust broker, schemas, fonts/licenses, and verified runtime assets while preserving user data across upgrades.

## Decision

Produce a Windows x64 per-user installer and unpacked diagnostic build from a reproducible locked build. Bundle the private Python runtime and Rust broker beside the Electron application; main verifies every sidecar against the build manifest before launch. Local RC binaries may be unsigned or test-signed and must be labeled accordingly; trusted OS code signing is a public-release gate. Do not download executable dependencies on first launch. Model weights remain user-selected downloads.

Use separate per-user locations for immutable application files, encrypted product data, models, cache/logs, and temporary sandboxes. Upgrade never migrates in place without a preflight backup and transactional schema migration. Ordinary uninstall removes binaries and offers a separate explicit choice for user data/models; silent uninstall retains user data. Backup/export is the supported portability path.

The RC updater is compiled disabled: no feed URL, background check, download, or install action. Update metadata parsing and replacement are tested only with a local fixture. Public distribution later requires a user-approved channel, signed metadata and assets, rollback protection, SHA-256 verification, code signing, timestamping, and staged rollout.

Windows is the capability-complete target. macOS and Linux CI build native packages and run contract/storage/provider/read-only tool smoke tests. Arbitrary code execution stays disabled on those platforms until their native sandbox meets ADR-0005. This limitation is visible in the tool descriptor and UI rather than failing after approval.

## Release-candidate gate

The local handoff requires:

- clean build, lint, type checks, unit/integration/contract tests, dependency/license/SBOM output, secret scan, and security tests;
- deterministic provider fixtures for six cloud providers plus local/OpenAI-compatible paths; live checks only with user-supplied credentials;
- memory, retrieval, project-isolation, tool approval, sandbox, task persistence, crash recovery, backup/restore, and legacy migration suites;
- Playwright behavior and inspected screenshots at 360, 768, 1024, 1440, and ultrawide in all themes, including keyboard, reduced motion, zoom, high contrast, long chats/code/tables, errors, and recovery;
- packaged-installer install/upgrade/uninstall/data-retention tests on supported Windows VMs and a real reference Windows machine;
- performance evidence for 3-second interactive shell, provider delta rendering within 100 ms of receipt, 500-message responsiveness, FTS 250 ms p95 at 100,000 records, and task recovery within 5 seconds;
- README, architecture summary, screenshots/demo, licenses, SBOM, known issues, checksums, exact local test instructions, and recovery/uninstall guidance.

The canonical end-to-end scenario in the Product proposal must pass from a packaged install, including restart recovery and an offline local-model turn after a verified model download.

## No-publish gate

Until the user tests and explicitly approves the local candidate:

- do not push any branch or tag;
- do not open a pull request or create a GitHub release;
- do not publish installers, packages, containers, update metadata, documentation, telemetry, or screenshots;
- do not configure DNS, distribution, signing, analytics, crash reporting, or a live updater;
- do not move/create a release tag or alter `v1.0.0`.

Local commits and local unsigned/test-signed artifacts are permitted. Handoff must label signing state and provide hashes. Public release approval is separate from approval to build or test.

## Consequences

- The first candidate is testable without pretending to be publicly trusted software.
- macOS/Linux retain core compatibility without overstating sandbox parity.
- Public distribution remains blocked on certificate/update-channel decisions and explicit approval.

## Verification

- Test clean install, upgrade from prior 2.0 schema, rollback refusal, uninstall retain/remove choices, locked files, low disk, corrupted package/runtime, and restored backup.
- Assert packaged builds contain no source `.env`, credentials, legacy mutable state, dev server, public listening socket, updater URL, or unverified executable download path.
- Verify artifact inventory, hashes, licenses, SBOM, and signatures where present before handoff.
