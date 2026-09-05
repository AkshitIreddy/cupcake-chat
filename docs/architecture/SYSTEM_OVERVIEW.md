# CupcakeAI 2.0 system overview

## Topology

```text
[React renderer]
      │ narrow Tauri invoke/events; opaque handles
[Tauri Rust host]
      │ verifies and supervises private child processes
      └── [Rust ToolBroker] ── DPAPI vault, security/audit store, tools/MCP/sandbox
                └── [Python runtime] ── product objects/database and workflow state
```

The renderer is untrusted. The Tauri host owns native window/tray/dialog/deep-link policy and a
custom titlebar, but no provider or product intelligence. The runtime owns canonical product state.
The broker owns credentials and effects. No component exposes a public product localhost service.

## Startup

1. Host resolves a disposable or ordinary per-user data directory.
2. Host canonicalizes the bundled sidecar resource directory.
3. Host verifies schema/protocol, exact binary set, bytes, SHA-256, transport, runtime provenance,
   and absence of model weights.
4. Host launches the broker with private authentication and a minimal environment; the broker
   launches and authenticates the Python runtime when needed.
5. Sidecars handshake before product bootstrap; invalid/tampered/incompatible processes fail closed.
6. Renderer receives redacted bootstrap DTOs and canonical visible events only.

The frozen runtime is a verified executable plus an exact manifest-bound `_internal` support tree.
It does not extract a onefile archive at every opening. The first useful renderer frame applies
saved identity, appearance, onboarding state, and offline preference before becoming interactive;
provider discovery, model hardware, tasks, and diagnostics hydrate afterward. Packaging constructs
all retained provider SDK clients and model adapters without network access to catch frozen-import
incompatibilities before accepting the bundle.

## Commands and events

Each renderer command has a generated Tauri capability and a concrete input/output type. Unknown or
oversized payloads, raw paths, secrets, unknown runtime methods, replay, sequence errors, invalid
deadlines, and forged events are rejected. Events are journaled before broadcast and recover through
canonical sequence identities.

## Provider lifecycle

The in-app form sends a key once to a trusted onboarding command. The trusted boundary tests the
connection, discovers models, stores the secret with per-user DPAPI only after success, and returns
masked non-secret metadata. Chat uses a short-lived memory credential lease behind the boundary.

Persisted output-limit responses remain partial even when their transport has finished. The renderer
preserves their text and offers an explicit continuation on the original provider/model route. A
missing or ambiguous original route fails visibly; the current model selection never silently
replaces it. Known output limits are distinguished from conservative defaults for providers whose
discovery API omits that metadata.

## Cupcake Local lifecycle

Hardware detection and signed catalog metadata produce explainable rankings. NVIDIA discovery uses
in-process NVML before a bounded `nvidia-smi` fallback. Compatible runtimes rank CUDA 13, CUDA 12,
Vulkan, then CPU, with driver and live-device probes preventing silent CPU fallback. Downloads use
partial state, range resume, checksum verification, license acknowledgement, and atomic promotion.
Runtime load/inference is supervised. Restart recovery never promotes an incomplete model or
duplicates visible effects.

## Storage and durability

The main product database and managed immutable objects support optional at-rest encryption, enabled
by default for a persistent Windows profile. Workflow checkpoints, broker security/audit state, and
developer traces remain separate plaintext stores; credentials and the profile key stay protected by
Windows DPAPI in either content mode. Conversation and artifact edits branch DAG heads. Project
scope filters retrieval, memory, files, grants, tools, and outbound context before use.

## Saved-code task execution

The artifact workspace can run embedded tests from a saved Python revision. The task binds the
project, artifact, immutable revision, and object digest before requesting an exact broker intent.
In Guarded mode the user approves that revision once; an explicitly selected Full freedom policy can
permit the same validated operation without a new prompt. Creating a task does not execute it.

The Windows broker stages the verified runtime support files and source in an AppContainer with
network access denied. Its bounded worker runs the module's actual unittest suite and reports
stdout, stderr, exit status, counts, and provenance. Task checkpoints record references and results,
not a plaintext copy of the source. Cancellation targets the live invocation and contained process
tree. Unsupported background delegate kinds fail explicitly rather than returning synthetic success.

## Backup recovery boundary

Backups protect their key with the current Windows user's DPAPI context. They can be verified on
that account and computer. Verification reconstructs an isolated encrypted recovery profile and
checks its database and objects; the current UI does not switch the running workspace into it.

## Failure behavior

The UI distinguishes offline, unavailable, incompatible, cancelled, failed, interrupted, and
recovering states. Graceful shutdown checkpoints durable work and stops child processes; escalation
terminates complete process trees without fabricating completion. Secrets are never used as error
detail.
