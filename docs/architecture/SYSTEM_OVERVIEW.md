# System overview

## Trust boundaries

```text
Untrusted content and model output
  | files, Markdown, provider streams, MCP schemas/results
  v
[Sandboxed React renderer]
  | narrow typed commands; opaque IDs only
  v
[Electron preload + main] ---- window, tray, dialogs, lifecycle
  | authenticated framed pipes; no listening socket
  +----------------------+----------------------+
  v                      v                      |
[Python runtime]     [Rust broker]              |
 product state       secrets + policy           |
 model adapters      grants + audit             |
 retrieval/tasks     tools + sandboxes           |
  | tool intent           | approved effect       |
  +---------------------->+-----------------------+
                         / \
            local files/models  remote providers/MCP
```

The renderer, imported content, model responses, tool packages, MCP servers, remote providers, and update metadata are untrusted. Electron main is privileged but contains no product intelligence. The Python runtime is trusted with decrypted product data and provider request assembly, but not credential storage or direct side effects. The Rust broker is the only authority for secrets, resource grants, approvals, MCP transport, and process execution.

## Canonical flows

### Chat run

1. Renderer submits an opaque conversation/branch ID, text, attachment handles, explicit model ID, reasoning preset, and enabled tool IDs through one typed preload method.
2. Main validates sender/frame and schema, assigns correlation metadata, and forwards the command to Python.
3. Python opens a transaction, creates immutable user message and run records, resolves project-scoped context, and emits canonical `RunEvent`s.
4. The provider adapter compiles canonical visible history into provider-native input. Provider events are normalized before persistence and display.
5. A proposed tool call becomes `ToolIntent`; Python cannot execute it. The broker resolves paths/destinations, computes `ToolPreflight`, applies policy, and either denies, requests approval, or executes.
6. Tool results and model output append immutable events. Completion atomically moves the branch head and records usage/provenance.

### File and retrieval flow

1. Native file dialogs return broker-owned opaque grant IDs, never raw paths to the renderer.
2. The broker verifies the selected root, canonicalizes each access at use time, blocks symlink/junction escape, and streams bytes to a network-disabled parser.
3. Python stores encrypted immutable objects, structured locators, metadata, and project ownership; FTS rows are authoritative derived indexes.
4. Retrieval applies the active project predicate in SQL before lexical/vector scoring. Only selected excerpts enter the context builder.
5. Context Inspector receives titles, safe display paths, locators, token counts, and destination labels—not secrets or unrestricted native paths.

### Approval and effect flow

1. Broker resolves an intent to exact resources, effects, limits, and outbound destinations.
2. It creates an expiring approval record whose digest binds the run, tool version, normalized arguments, resolved resource IDs, destination, and effect class.
3. Renderer shows that exact preflight. The approval response returns through the narrow bridge.
4. Broker verifies digest, user/session, freshness, state, and sequence, atomically consumes it, then performs the effect once under an idempotency key.
5. Audit events record the decision and redacted result. Retries query the idempotency record instead of repeating the effect.

### Restart recovery

1. Main starts the broker, completes authenticated pipe bootstrap, starts Python, and waits for both health handshakes.
2. Python migrates product storage, validates the application version against DBOS checkpoints, and recovers interrupted workflows from the last completed step.
3. Pending approvals remain pending only if their exact intent is still valid and unexpired; otherwise they become expired and the workflow returns to `input_required` with a new preflight.
4. Renderer replays canonical events from its last acknowledged sequence and deduplicates by event ID.

## Cross-process framing

Main supervises Python and the broker with inherited anonymous pipes. A separate inherited one-shot bootstrap pipe supplies a random 256-bit session key; it is never placed in arguments, environment variables, logs, or renderer memory. Runtime frames are:

```text
4-byte unsigned big-endian payload length
UTF-8 JSON payload bytes
32-byte HMAC-SHA-256(length || payload)
```

Maximum payload is 16 MiB. Every `ProtocolEnvelope` carries protocol version, message ID, correlation ID, monotonic sequence, optional deadline, run/task/parent IDs, message type, and payload. Receivers reject a bad MAC, unsupported version, invalid schema, oversized frame, duplicate message ID, non-monotonic sequence, or expired deadline and then fail the channel closed. Stdout is protocol-only; redacted structured diagnostics use stderr.

JSON Schema Draft 2020-12 files are the source of truth. Build-time generation produces TypeScript, Pydantic, and Serde types. Unknown fields are rejected on security-sensitive commands; additive event payload evolution requires a declared protocol minor version.

## System invariants

- Product UUIDs use UUIDv7. Provider IDs are metadata, never primary keys.
- Canonical messages/events, not SDK objects or DBOS checkpoints, reconstruct user-visible history.
- All persisted user content is encrypted at rest; key material is broker-owned.
- Project ownership is mandatory on project-scoped content and checked before retrieval, tool resolution, and outbound requests.
- Every side effect has a declared effect class, exact resolved target, approval decision, idempotency key, audit event, and terminal result.
- A renderer compromise cannot obtain a secret, raw path, unrestricted IPC primitive, process primitive, or database handle.
- Cancellation is cooperative first and broker-enforced for processes; a cancelled/failed workflow cannot later become completed.
- Logs and telemetry are local, redacted, bounded to 30 days by default, and exclude prompts, file contents, secrets, hidden reasoning, and raw tool output unless the user exports a diagnostic bundle.

## Threat model

| Threat | Required control |
|---|---|
| Renderer XSS or malicious Markdown | Local packaged UI, restrictive CSP, sandbox and context isolation, no Node integration, sanitized rendering, sender validation, per-command preload APIs |
| Prompt injection in files/web/model output | Treat content as data; separate instructions; show provenance; least-privilege tools; broker preflight and fresh approval for consequential effects |
| Path traversal or symlink/junction race | Broker-held directory handles/grants, canonicalize at use, component-wise containment checks, no renderer paths, stage writes then atomic replace |
| Forged/replayed IPC or approval | Private inherited handles, authenticated frames, monotonic sequences, expiring digest-bound one-time approvals, atomic consumption |
| Malicious MCP server or schema replacement | Origin/audience validation, isolated sessions, allowlists, schema digest pinning, reapproval on change, redacted logging, no token passthrough |
| Generated or third-party code | Out-of-process only; staged filesystem; no credentials/network by default; OS sandbox and resource caps; terminate process tree |
| Credential/database theft | OS credential vault, SQLCipher, per-user key binding, encrypted objects/backups, zeroization where practical, no plaintext Linux fallback |
| Parser exploit or decompression bomb | Network-disabled worker, format/size/time/depth limits, archive-entry accounting, process isolation, fail closed |
| Dependency/update compromise | Locked dependencies, provenance/SBOM, checksums, signed catalog/update metadata, code signing before public distribution, no live RC updater |
| Crash/power loss | WAL/checkpoints, transactional branch-head changes, immutable objects, DBOS step recovery, idempotent effects, backup integrity verification |

## Failure posture

- Broker failure stops new privileged operations immediately; chat may show persisted content but cannot claim a tool completed.
- Python failure leaves the UI readable and tasks recoverable; main restarts it with bounded backoff and no implicit effect replay.
- Provider/MCP failures preserve partial events, surface retry metadata, and never trigger cross-provider fallback unless explicitly configured and confirmed.
- Database integrity or key failure opens a recovery screen; the application does not initialize a replacement store over unreadable data.
- Disk-full failures abort before branch-head movement, retain reachable prior revisions, and provide cleanup/backup guidance.
