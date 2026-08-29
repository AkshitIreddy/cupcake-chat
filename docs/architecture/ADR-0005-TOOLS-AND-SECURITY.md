# ADR-0005: Tools, MCP, approvals, and sandboxing

**Status:** Accepted **Date:** 2026-08-28

## Context

Agent output, imported content, tool servers, and generated code are untrusted. The legacy runtime
gives generated Python the user's ambient authority. CUPCAKEAGI needs useful native tools and MCP
integrations while making every effect, destination, and grant inspectable.

## Decision

All tools—native, MCP, and custom—enter one broker-owned registry with four versioned contracts:

- `ToolDescriptor`: stable ID/version, owner, description, input/output JSON Schemas, effect
  classes, destinations, required grants, runtime, and schema digest.
- `ToolIntent`: run/tool/version, model-proposed validated arguments, user context, and idempotency
  key.
- `ToolPreflight`: exact resolved resource IDs/safe display paths, effects, data destinations,
  limits, grant match, schema digest, and approval digest/expiry.
- `ToolResult`: status, typed/redacted output references, generated artifacts, timing, error,
  provenance, audit ID, and idempotency outcome.

The broker resolves and validates the intent before policy. Permission precedence is **deny → exact
grant → session/project grant → category policy → ask**. Deny always wins. Deletion, external
communication, money, installation, system configuration, privilege elevation, credential access,
and unsandboxed execution always require a fresh exact approval and cannot be made “always allow.”

Approval digests bind run ID, tool/version/schema digest, normalized arguments, resolved resources,
destinations, effect classes, limits, user/session, and expiry. Approval is one-time, persisted,
atomically consumed with the idempotency record, and invalidated by any change. The UI cannot
approve a wildcard when the preflight showed an exact target.

## Native tools and filesystem safety

Native tools cover scoped file/repository read, search/fetch, Git inspection and patch proposals,
sandboxed Python, local-model management, and artifact operations. Selected repositories are
read-only by default. Grants are broker-owned handles rooted at a user selection; every access
canonicalizes the target at use time, rejects traversal and symlink/junction escape, and applies
byte/file/depth/time limits.

Patch application is separate from patch generation. The user reviews exact hunks and target
repository state; the broker rechecks base hashes immediately before staged write and atomic
replacement. Conflicts return a new preflight rather than applying to changed content.

There is no raw `shell(commandString)`, `shell=True`, ambient package installation, or
renderer/process primitive. Custom tools use an out-of-process SDK with the same
manifest/schema/framing model and never load code into Electron or the broker.

## Sandboxed execution

Windows 10/11 x64 execution uses a fresh staged directory, a restricted token/AppContainer-style
boundary with no ambient file/registry/device access, no network capability by default, and a Job
Object enforcing process-tree ownership, kill-on-close, CPU time, memory, process count, and wall
time. Only explicitly staged inputs are readable; only a declared output directory is writable; no
provider credentials or vault handles enter the environment. Output is size-limited, scanned, and
promoted only through a second broker operation.

The classic Win32 AppContainer launcher must inherit its creator environment. Electron therefore
starts the broker with an allowlist, the broker removes its one-time authentication secret before
serving tools, and the sandbox refuses to launch if any credential-like environment name remains.
Custom environment bindings are rejected. Generated code can still observe non-secret Windows and
packaged-sidecar path metadata; it cannot receive provider keys, vault material, cookies, passwords,
tokens, or arbitrary user shell variables.

If the restricted token/AppContainer-style isolation or any required Job Object limit cannot be
established, execution fails closed. File parsing also runs out of process under the same Windows
security boundary, with network disabled and tighter limits. No alternate operating-system execution
boundary is supported in 2.0.

## MCP

- Support local stdio and remote Streamable HTTP. Stdio stdout is protocol-only and stderr is
  redacted logging.
- Negotiate/pin protocol version, isolate each connection/session, bound frames/events, and
  cancel/close sessions explicitly.
- Remote HTTP requires HTTPS except explicit loopback development, validates redirects and `Origin`,
  rejects private/link-local resolution for remote hosts, and re-resolves safely to mitigate
  SSRF/rebinding.
- OAuth uses authorization code + PKCE, protected-resource/authorization-server discovery, exact
  redirect URIs, audience-bound short-lived tokens, rotation where supported, and per-user
  DPAPI-backed storage. Token passthrough is forbidden.
- Users select allowed tools. Descriptor/schema digests are pinned; added/removed/changed tools
  invalidate affected grants and require review before use.
- Treat MCP descriptions, resource contents, elicitation, and results as untrusted data. They cannot
  modify product instructions or bypass broker preflight.

## Audit and data-flow disclosure

Audit records include actor, time, run/task, tool/version/schema digest, resolved opaque resources,
destination, effect class, policy rule, approval state, idempotency key, redacted outcome, and trace
IDs. Secrets, full prompts, file contents, authorization codes/tokens, and raw sensitive results are
never logged. Normal retention is 30 days; export is explicit and redacted by default.

## Consequences

- Every tool path has consistent approval, provenance, cancellation, and recovery semantics.
- The Rust broker is a small security boundary and must remain free of model/provider business
  logic.
- Windows 10/11 x64 is the only tool and sandbox target in the 2.0 release contract.
- MCP interoperability does not imply trust in an MCP server.

## Verification

- Fuzz manifests, schemas, frames, tool arguments, approval digests, sequence/replay, and redaction.
- Test traversal, alternate path syntax, symlink/junction swaps, archive bombs, changed Git bases,
  staging promotion, disk full, timeouts, and cancellation.
- Test forged renderer IPC, compromised Python requests, MCP schema replacement, token audience
  confusion, OAuth redirect attacks, DNS rebinding/SSRF, and prompt injection.
- Prove network denial, credential absence, AppContainer/restricted-token isolation, Job Object
  resource limits, and complete process-tree termination in the packaged Windows 10/11 x64 sandbox.
