# CupcakeAI 2.0 user guide

This guide describes the intended Tauri candidate. Features still awaiting live or packaged
verification are identified in [known issues](known-issues.md).

## Workbench

Use the persistent shelf for Home, Chats, Projects, Tasks, Artifacts, Memory, Models, Tools, Search,
and Settings. Chat is the primary surface. Choose a model explicitly, review the Local/Cloud route,
attach only the intended context, and use the Frosting Thread to navigate immutable branches.

## Provider setup

Open Settings or Models and choose a hosted provider. CupcakeAI shows where prompts/files go,
current cost/free-trial caveats, and a link to obtain your own key. Enter the key in the
application, test the connection, review discovered models/capabilities, and save only after
success.

The saved card shows a masked identity and last test time. Use Reconnect to replace a key and Remove
to delete it. Provider setup must never escape into a generic Windows credential prompt. A key is
protected for the current Windows user with DPAPI and must not appear in chat, logs, diagnostics, or
the product database.

## Models

Hosted models show provider, capabilities, privacy route, and any unverified capability warning.
There is no automatic routing.

Cupcake Local detects CPU, RAM, disk, Windows version, NVIDIA GPU/VRAM, and installed acceleration
pack. The signed catalog currently offers Qwen3 4B, 8B, and 14B Q4_K_M metadata from immutable
revisions; weights are downloaded only after an explicit install. Before installation it ranks the
verified catalog as Recommended, Fits with reduced context, CPU-only/slow, Hybrid, or Incompatible,
with explanations and estimates. Filter by task, size, license, tools/vision, and local-only
privacy.

On NVIDIA systems, Cupcake recommends CUDA 13.3 only when the installed driver is 580 or newer;
otherwise it can use the compatible CUDA 12.4 pack. Vulkan remains the portable GPU fallback and the
bundled CPU runtime remains the safe baseline. Optional packs show their download size,
requirements, integrity checks, and required license terms before installation.

Install downloads optional model weights with pause/resume/cancel/retry and checksum verification.
Load, benchmark, chat, unload, update, and remove are app-managed. Installed local chat can work
offline. Model licenses and hardware requirements still apply.

## Chat, tasks, and artifacts

Enter sends; Shift+Enter adds a line. Stop, Retry, Continue, edit, regenerate, and sibling-branch
actions preserve canonical visible history. Tool and task activity appears in concise expandable
cards. Longer work may continue durably while you chat and can request narrowly scoped approvals.

Artifacts keep immutable revisions. Preview, edit, export, and inspect provenance without destroying
older versions.

## Projects, files, and memory

Projects scope chats, files, retrieval, memories, tasks, artifacts, and grants. Attachments use
opaque handles; the renderer never receives unrestricted paths. Cloud confirmation reflects the
exact selected provider/model and context.

Memory records show scope, source, confidence, revision, and expiry. Review, correct, pin, disable,
or remove them. Secrets should not become ordinary memory.

## Tools and approvals

File, repository, web, Git, Python, model, artifact, and MCP tools use bounded grants. Deletion,
external communication, financial actions, installation, system changes, and unsandboxed execution
require fresh approval. Generated code starts without credentials or network.

## Accessibility and themes

Cupcake Light, Cupcake Dark, Minimal, and Classic share keyboard operation, visible focus, semantic
streaming regions, reduced motion, high-contrast compatibility, responsive reflow, and deliberate
scrollbars. Report any control overlap, generic control, unreachable region, or unreadable state.

## Privacy

Confirm the destination indicator before sending sensitive context. Local means the installed
Cupcake Local path; Cloud means the selected hosted provider or remote endpoint. Free access does
not mean private. No fallback crosses a privacy or cost boundary silently.
