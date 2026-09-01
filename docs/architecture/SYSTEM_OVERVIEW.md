# CupcakeAI 2.0 system overview

## Topology

```text
[React renderer]
      │ narrow Tauri invoke/events; opaque handles
[Tauri Rust host]
      │ verifies and supervises private child processes
      ├── [Python runtime] ── encrypted product/checkpoint stores
      └── [Rust ToolBroker] ── DPAPI vault, security/audit store, tools/MCP/sandbox
```

The renderer is untrusted. The Tauri host owns native window/tray/dialog/deep-link policy and a
custom titlebar, but no provider or product intelligence. The runtime owns canonical product state.
The broker owns credentials and effects. No component exposes a public product localhost service.

## Startup

1. Host resolves a disposable or ordinary per-user data directory.
2. Host canonicalizes the bundled sidecar resource directory.
3. Host verifies schema/protocol, exact binary set, bytes, SHA-256, transport, runtime provenance,
   and absence of model weights.
4. Host launches broker/runtime with private authentication and a minimal environment.
5. Sidecars handshake before product bootstrap; invalid/tampered/incompatible processes fail closed.
6. Renderer receives redacted bootstrap DTOs and canonical visible events only.

## Commands and events

Each renderer command has a generated Tauri capability and a concrete input/output type. Unknown or
oversized payloads, raw paths, secrets, unknown runtime methods, replay, sequence errors, invalid
deadlines, and forged events are rejected. Events are journaled before broadcast and recover through
canonical sequence identities.

## Provider lifecycle

The in-app form sends a key once to a trusted onboarding command. The trusted boundary tests the
connection, discovers models, stores the secret with per-user DPAPI only after success, and returns
masked non-secret metadata. Chat uses a short-lived memory credential lease behind the boundary.

## Cupcake Local lifecycle

Hardware detection and signed catalog metadata produce explainable rankings. NVIDIA discovery uses
in-process NVML before a bounded `nvidia-smi` fallback. Compatible runtimes rank CUDA 13, CUDA 12,
Vulkan, then CPU, with driver and live-device probes preventing silent CPU fallback. Downloads use
partial state, range resume, checksum verification, license acknowledgement, and atomic promotion.
Runtime load/inference is supervised. Restart recovery never promotes an incomplete model or
duplicates visible effects.

## Storage and durability

SQLCipher product state, workflow checkpoints, and broker security/audit state remain separate.
Encrypted immutable content-addressed objects back files and artifact revisions. Conversation and
artifact edits branch DAG heads. Project scope filters retrieval, memory, files, grants, tools, and
outbound context before use.

## Failure behavior

The UI distinguishes offline, unavailable, incompatible, cancelled, failed, interrupted, and
recovering states. Graceful shutdown checkpoints durable work and stops child processes; escalation
terminates complete process trees without fabricating completion. Secrets are never used as error
detail.
