# `@cupcakeagi/contracts`

This package is the product-owned boundary between CUPCAKEAGI's renderer, Electron main process,
Python runtime, and Rust broker. TypeBox declarations in `src/` are the canonical source for
TypeScript types and versioned JSON Schema. Checked-in schemas in `schema/v1/` are generated for
Pydantic, Serde, fixtures, and protocol conformance tests.

## Invariants

- Every domain object is closed: unknown properties are rejected at every declared boundary.
  Explicit JSON payload and metadata maps are the only open extension points.
- Every durable identity is a UUIDv7. IDs are opaque and must never encode filesystem paths.
- Every timestamp is UTC RFC 3339. Byte counts and durations are bounded non-negative integers;
  wire/event sequences are bounded positive integers and begin at 1.
- `ProtocolEnvelope` is the only sidecar wire frame. Frames are authenticated by the private
  transport, capped at 8 MiB, ordered by monotonic sequence per correlation, and rejected if their
  deadline has elapsed.
- `authTag` is an unpadded base64url HMAC-SHA256 over RFC 8785-canonical JSON for all envelope
  fields except `authTag`. Verification uses constant-time comparison; only a successful handshake
  can establish a `sessionId`, and IDs from another session are rejected.
- `RunEvent`, tool intents/results, persisted messages, and artifacts are canonical product records.
  Provider SDK objects, framework messages, hidden reasoning, credentials, and raw local paths are
  never persisted in these contracts.
- Discriminated unions are exhaustive. Lifecycle state is represented by a named state rather than
  combinations of booleans.
- Approval digests bind the normalized preflight, resolved resource handles, destination, effects,
  and expiry. An approval ID is single use.
- Project scope is an authorization boundary. Consumers must not broaden or drop a project filter
  during retrieval.
- Artifact and conversation edits append immutable revisions/nodes and advance a branch head.
- Additive changes stay in `v1`; incompatible changes require a new schema directory and protocol
  version.

## Product tools versus broker wire

`ToolDescriptor`, `ToolIntent`, `ToolPreflight`, and `ToolResult` are camelCase product records.
They are deliberately **not** wire-identical to the privileged runtime-to-broker protocol. The exact
Python-emitted snake_case records live in `broker-wire.ts` and generate `broker-request.schema.json`
and `broker-tool-result.schema.json`.

The adapter must translate effect names through `brokerEffectTranslation`; it must not rename by
heuristic. For example `network-read` becomes runtime `network` and Rust `network_read`, while
`financial-transaction` becomes runtime `money` and Rust `spend_money`. The Python request wrapper
uses `protocol_version`/`request_type`; the authenticated desktop `ProtocolEnvelope` remains
camelCase. Rust `registry.rs` descriptor/intent/preflight/result structs are broker-internal
records, so an adapter must validate the snake_case request first and then construct those native
records explicitly.

Run `pnpm --filter @cupcakeagi/contracts generate:schemas` after changing a schema, then
`pnpm --filter @cupcakeagi/contracts check:schemas` to prove the checked-in output is current. The
same command deterministically regenerates the Pydantic models in
`services/runtime/src/cupcake_runtime/generated/contracts_v1.py` and Serde models in
`crates/tool-broker/src/generated/contracts_v1.rs`; the CI drift check covers all three outputs.
