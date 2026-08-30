# ADR-0005: Tools, MCP, approvals, and sandboxing

**Status:** Accepted (Tauri host revision)

**Date:** 2026-08-29

## Decision

All native, MCP, and custom tools enter one broker-owned versioned registry. A tool intent becomes a
resolved preflight that binds exact resources, destinations, effects, limits, schema digest,
approval digest, user/session, and expiry. Policy precedence is deny, exact grant, scoped grant,
category policy, then ask. Dangerous effects always require fresh exact approval.

The Tauri renderer can request product operations only through explicit typed commands. It receives
opaque handles, never raw paths or generic filesystem/process/network/shell APIs. The host validates
the command and delegates broker-governed effects rather than executing arbitrary renderer input.

Repositories are read-only until an exact patch is staged and freshly approved. Every file access is
canonicalized at use time with traversal, symlink/junction, byte/file/depth/time, and changed-base
defenses.

Generated code runs in a fresh Windows restricted-token/AppContainer-style staging area with no
credentials or network by default. A Job Object owns the process tree and enforces kill-on-close,
time, memory, output, and process-count limits. Failure to establish containment fails closed.

MCP remains out of process. Stdio and Streamable HTTP use version/frame/schema/origin/session
validation, HTTPS except explicit loopback development, safe resolution/redirect policy, OAuth/PKCE
with audience-bound DPAPI tokens, allowed-tool filters, and schema-digest invalidation. Third-party
code never loads into the Tauri host or renderer.

Audit records are structured and redacted. They exclude secrets, full prompts/files, authorization
material, and hidden reasoning.

## Verification

Fuzz commands, schemas, frames, approvals, replay, sequence, and redaction. Test traversal and
junction races, changed Git bases, SSRF/rebinding, OAuth state/audience, schema replacement, prompt
injection, network denial, credential absence, resource exhaustion, and complete process-tree
termination in the packaged Windows app.
