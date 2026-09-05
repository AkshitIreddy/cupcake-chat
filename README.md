# CupcakeAI 2.0

![CupcakeAI mark](apps/desktop/public/brand/cupcake-mark.svg)

CupcakeAI is a Windows-first, text-first AI workbench for conversations, files, tools, tasks,
citations, memory, projects, and artifacts. The application uses a React/TypeScript renderer inside
a Tauri 2 host, with product behavior behind narrow versioned contracts.

> **Corrective local candidate, not an accepted release.** The previous desktop baseline was
> rejected by the owner. The Tauri executable, verified sidecars, unsigned NSIS bundle, and fresh
> in-app NVIDIA NIM/Cohere conversations now pass local testing. App-managed local inference,
> clean-machine installer lifecycle, the complete native accessibility/performance matrix, and owner
> acceptance remain governed by the live checklist. Nothing here is approved for distribution.

## Product contract

- Chat remains the primary surface. Voice and automatic model routing are excluded.
- Model choice is explicit. Optional fallbacks are off by default and disclose cost/privacy changes.
- Provider setup stays inside CupcakeAI: key entry, privacy/cost disclosure, connection testing,
  supported-model discovery, saved masked identity, reconnect, and removal.
- Cupcake Local is the only installed local-model manager. It owns a pinned llama.cpp runtime and
  optional downloaded GGUF weights; users do not need Node, Python, Conda, or a separate model
  server.
- OpenAI, Anthropic, Gemini, xAI, Mistral, Cohere, NVIDIA NIM, and generic remote OpenAI-compatible
  endpoints remain explicit hosted routes.
- Home, Chats, Projects, Tasks, Artifacts, Memory, Models, Tools, Search, and Settings remain
  persistent destinations.
- Cupcake Light, Cupcake Dark, Minimal, and Classic remain the four themes.

The corrective Models-screen target is useful before installation: detect the current device, load
verified catalog metadata, rank compatible choices, explain RAM/VRAM/disk/context tradeoffs, and
support download recovery, checksum validation, load/unload, removal, and measured benchmarking.

## Current architecture

```text
React + TypeScript renderer
          │ typed invoke/events; no raw Node, path, process, credential, or network primitive
Tauri 2 Rust host
          │ window/tray/dialog/deep-link policy, capabilities, sidecar supervision
          ├──────── packaged Python runtime
          │         providers, tasks, memory, retrieval, persistence, Cupcake Local
          │
          └──────── Rust ToolBroker
                    DPAPI vault, policy, grants, MCP, sandboxing, audit
```

The Python runtime and ToolBroker remain private child processes, never public localhost services.
The renderer receives opaque handles and canonical events. The main product database and managed
objects support optional at-rest encryption, enabled by default for a persistent Windows profile;
workflow checkpoints and broker policy/audit state are separate plaintext stores. Credentials and
the profile master key remain protected by Windows DPAPI in either content mode. Conversations and
artifacts are immutable revision graphs, and project scope is a privacy boundary.

## Run from source

Prerequisites:

- Windows 10 or 11 x64;
- Node.js 20.19 or newer and pnpm 10.15.1 through Corepack;
- Python 3.12;
- stable Rust using `x86_64-pc-windows-msvc`, with rustfmt and Clippy;
- Visual Studio C++ Build Tools with Desktop development with C++;
- Microsoft Edge WebView2 Runtime.

From Windows PowerShell at the repository root:

```powershell
corepack enable
corepack prepare pnpm@10.15.1 --activate
pnpm install --frozen-lockfile
pnpm --filter @cupcakeagi/desktop dev
```

Development fixtures keep the renderer reviewable without credentials or installed models. Fixture
content is never evidence of a live provider, installed model, durable recovery, or completed task.

## Validation

```powershell
pnpm format:check
node scripts/verify.mjs --lane contracts
node scripts/verify.mjs --lane js
node scripts/verify.mjs --lane python
node scripts/verify.mjs --lane rust
```

The Rust lane covers both `crates/tool-broker/Cargo.toml` and `apps/desktop/src-tauri/Cargo.toml`.
Browser-renderer tests remain useful, but native Tauri behavior, window controls, WebView2
scrollbars, DPI, packaging, and lifecycle require a packaged Windows app plus opened and inspected
screenshots.

## Local unsigned package

These commands are for a disposable local candidate only:

```powershell
node scripts/package-sidecars.mjs
pnpm --filter @cupcakeagi/desktop bundle:nsis
node scripts/smoke-package.mjs --platform win32 --mode bundle
node scripts/release-candidate-audit.mjs --require-artifacts
```

Expected output conventions, which must be verified after a successful build:

- executable: `apps/desktop/src-tauri/target/release/CupcakeAI.exe`;
- installer: `apps/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe`;
- disposable profile: set `CUPCAKE_TEST_DATA_DIR` to an explicitly selected new absolute directory
  below `out/tauri-test-profiles/`.

The commands above currently produce the named executable and one unsigned NSIS installer, and the
package smoke verifies their sidecar/resource digests. Rebuild them after any source, catalog, or
sidecar change; never reuse an older artifact as current Tauri evidence.

## Try before upgrading

Provider terms change. The maintained [provider guide](docs/free-tier-guide.md) distinguishes
published free/trial access from paid access and links to official dashboards. Add keys only through
the in-app provider flow. Never commit keys, place them in `.env`, include them in screenshots, or
paste them into diagnostics.

Protecting a key locally does not keep hosted prompts, selected attachments, retrieved context, or
responses on the device. Those are processed under the selected provider's current terms; the
provider guide records the required route-specific disclosures.

Cupcake Local has no provider API charge after a model is downloaded, but model licenses, storage,
RAM/VRAM use, electricity, and download bandwidth still matter.

NVIDIA NIM is an optional evaluation route, never unlimited or the default. Mistral's optional free
Experiment mode has lower limits and different data-use terms than paid access. Cohere trial keys
are limited to 1,000 calls per month and are not for production.

## Documentation

- [User guide](docs/user-guide.md)
- [Development guide](docs/development.md)
- [Corrective local testing](docs/local-testing.md)
- [Known issues and unfinished gates](docs/known-issues.md)
- [Architecture decisions](docs/architecture/)
- [Product contracts](packages/contracts/README.md)

The historical 1.x source and `write-the` generator remain at the `v1.0.0` tag. They are not a 2.0
dependency, migration target, compatibility target, or packaging path.

## Release policy

Local testing does not authorize a push, package publication, public download, GitHub release,
production signature, updater, or artifact distribution. The owner decides whether a fully tested
corrective build becomes the CupcakeAI 2.0 release candidate.
