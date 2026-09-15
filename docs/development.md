# Developing Cupcake Chat 1.8

Cupcake Chat is a Windows-only Tauri 2 application. React renders the workbench; the Tauri Rust host
owns native lifecycle and narrow commands/events; the packaged Python runtime owns product behavior;
and the Rust ToolBroker owns credentials, tool policy, MCP, audit, and sandboxing.

This guide covers development and preparation of a reviewable candidate. It does not authorize a
push, tag, GitHub workflow run, signature publication, release publication, or distribution.

## Layout

| Path                        | Responsibility                                                                |
| --------------------------- | ----------------------------------------------------------------------------- |
| `apps/desktop/src/renderer` | React/TypeScript UI, themes, motion, and typed workspace state                |
| `apps/desktop/src-tauri`    | Tauri host, capabilities, updater, lifecycle, and native commands/events      |
| `packages/contracts`        | TypeBox contracts plus checked-in JSON Schema, Pydantic, and Serde output     |
| `services/runtime`          | Providers, persistence, projects, retrieval, memory, tasks, and Cupcake Local |
| `crates/tool-broker`        | DPAPI vault, tool policy, MCP, sandboxing, and audit                          |
| `packaging`                 | Sidecar descriptors and signed Cupcake Local catalog inputs                   |
| `scripts`                   | Verification, staging, packaged acceptance, and release-candidate tools       |

## Windows prerequisites

- Windows 10 or 11 x64 and Windows PowerShell for native validation;
- Node.js 20.19 or newer, Corepack, and pnpm 10.15.1;
- Python 3.12 with `venv`;
- stable `x86_64-pc-windows-msvc` Rust with rustfmt and Clippy;
- Visual Studio C++ Build Tools with **Desktop development with C++**;
- Microsoft Edge WebView2 Runtime and Git.

WSL may inspect the tree and run portable checks, but it does not prove WebView2 rendering, DPAPI,
Windows paths, Job Objects, native DPI, titlebar hit testing, updater behavior, or installer
lifecycle.

## Install and run

From Windows PowerShell at the repository root:

```powershell
corepack enable
corepack prepare pnpm@10.15.1 --activate
pnpm install --frozen-lockfile
pnpm --filter @cupcakeagi/desktop dev
```

The Tauri host starts Vite and opens a custom undecorated window. Only intended empty titlebar
regions may initiate dragging; controls and application content must remain non-draggable.

Use an explicit disposable path in `CUPCAKE_TEST_DATA_DIR` for app and installer testing. Keep large
outputs outside the repository. On the owner's machine, set `TEMP`, `TMP`, and `CARGO_TARGET_DIR` to
directories under `E:\temp`. Before any GPU-heavy test, read and obey
`C:\Users\akshi\Desktop\Code Palace\gpu use.txt`. Start helper processes and test applications
headlessly so terminals do not appear on the desktop.

## Contracts

```powershell
pnpm --filter @cupcakeagi/contracts typecheck
pnpm --filter @cupcakeagi/contracts test
pnpm --filter @cupcakeagi/contracts generate:schemas
pnpm --filter @cupcakeagi/contracts check:schemas
```

Commit declarations and generated JSON Schema, Pydantic, and Serde outputs together. Boundaries
reject unknown versions or properties, oversized frames, expired deadlines, replay, sequence gaps,
and unknown methods. Renderer contracts contain opaque handles rather than raw paths or credentials.

## Python runtime

```powershell
py -3.12 -m venv services\runtime\.venv
services\runtime\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e "services/runtime[documents,durability,packaging,providers,sqlcipher,test]"
python -m pytest services/runtime/tests
```

Tests use temporary profiles. Live provider tests are small, explicit, secret-safe opt-ins that
supplement deterministic fixtures. Never print a key or allow it into Git, environment snapshots,
logs, screenshots, databases, diagnostics, or crash output.

Default Cupcake advisors are seeded by the runtime as durable personas. Treat their stable IDs and
prompts as product data: migration must be idempotent, never overwrite a user's edits, and keep
existing profiles valid.

## Rust broker and host

```powershell
cargo fmt --manifest-path crates/tool-broker/Cargo.toml --all -- --check
cargo clippy --manifest-path crates/tool-broker/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path crates/tool-broker/Cargo.toml --all-features
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --all-features
```

The repository verifier combines the supported lanes:

```powershell
node scripts/verify.mjs --lane all
```

## Provider onboarding

Provider setup is application-owned. The renderer may hold the typed key only for the active form
and passes it once to a trusted Tauri command. The trusted boundary tests and discovers the provider
before storing the credential with per-user DPAPI.

Every direct adapter needs deterministic coverage for discovery, streaming, stop, errors, rate
limits, usage, capability disclosure, and switching. Adding a provider also requires its exact route
identity, setup metadata, current official documentation links, model normalization, UI logo, and a
safe live-smoke path. An OpenAI-shaped API does not make a provider an OpenAI route.

The onboarding tour is a resumable map of real destinations. Keep provider setup, Cupcake Local,
appearance, identity, projects, tools/memory, and optional workspace security independently
skippable. Any setup choice must remain available after the tour closes.

## Cupcake Local

Cupcake Local owns its llama.cpp runtime. Model weights are optional downloads and are never bundled
with the app. Development covers hardware fixtures, signed catalog parsing, fit explanations,
resumable downloads, checksum failure, low disk, atomic promotion, load/unload, benchmark, offline
chat, removal, and restart recovery.

The Windows/NVIDIA pack ladder uses the current signed catalog: CUDA 13.3 for driver 580 or newer,
CUDA 12.4 for older supported drivers, Vulkan fallback, then the bundled CPU baseline. Test both
NVML discovery and the runtime's own `--list-devices` activation probe; catalog compatibility alone
does not prove GPU use.

## Themes, motion, and accessibility

Wallpaper work spans the image asset, renderer registry, settings type, persisted runtime whitelist,
and tests. New scenes need readable theme-token contrast across chat, tasks, artifacts, memory,
dialogs, and hover/focus states. Do not solve a mismatched surface with a fixed color that only
looks right on one wallpaper.

Motion should explain state or add a small moment of personality. Keep transitions smooth and short,
avoid layout movement under the pointer, and disable translations, flourishes, looping indicators,
and smooth scrolling when either the app setting or `prefers-reduced-motion` requests it.

Browser fixtures are useful renderer regression checks. Native claims require the real packaged
Tauri/WebView2 window, exercised headlessly at its real scale. Inspect screenshots for the changed
sections and verify keyboard focus, screen-reader streaming, long code/tables, dialogs, drawers,
scrollbars, titlebar controls, loading, empty, error, and ready states. Repeated zoom testing is not
part of the owner acceptance scope.

## Sidecars and local packaging

```powershell
node scripts/package-sidecars.mjs
node scripts/test-atomic-directory.mjs
node scripts/test-sidecar-protocol.mjs
pnpm --filter @cupcakeagi/desktop tauri:build
node scripts/smoke-package.mjs --platform win32 --mode build
pnpm --filter @cupcakeagi/desktop bundle:nsis
node scripts/smoke-package.mjs --platform win32 --mode bundle
node scripts/release-candidate-audit.mjs --require-artifacts
```

The staging script produces target-triple inputs under `apps/desktop/src-tauri/binaries/` and a
verified self-contained resource set under `apps/desktop/src-tauri/resources/sidecars/`. The Tauri
configuration must declare both external binaries and the resource directory. Rebuild the frozen
Python runtime and ToolBroker whenever their source changes; a newly branded renderer does not make
an old sidecar a current 1.8.0 package.

The local NSIS bundle is review material. Record its exact path, byte size, SHA-256 digest, source
revision, runtime and broker digests, and shutdown result.

## Updater and draft release workflow

The Tauri updater trusts the public key stored in the repository variable
`TAURI_UPDATER_PUBLIC_KEY`. Local updater verification should use a disposable signed feed and a
disposable profile; a successful version check alone does not prove signature rejection,
download/install, retained profile data, restart, or rollback behavior.

`.github/workflows/release-windows.yml` is a manual `workflow_dispatch` protected by the `release`
environment. It validates the 1.8.0 manifests, builds the Windows app, creates the required Tauri
updater signature, generates `latest.json`, and uploads the installer and updater files to a
**draft** GitHub Release. It must not run automatically from a tag or publish that draft.

Authenticode is optional: configure the certificate, password, and timestamp URL together to sign
the Windows installer. Without them, the workflow labels the draft as lacking Authenticode while
still requiring the cryptographic updater signature. The updater-key password is optional too.

Release configuration stays outside source:

| Kind                | Name                                 | Purpose                                        |
| ------------------- | ------------------------------------ | ---------------------------------------------- |
| Repository variable | `TAURI_UPDATER_PUBLIC_KEY`           | Verifies updater payload signatures in the app |
| Repository variable | `WINDOWS_TIMESTAMP_URL`              | Authenticode timestamp service                 |
| Environment secret  | `TAURI_SIGNING_PRIVATE_KEY`          | Signs the Tauri updater payload                |
| Environment secret  | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Unlocks the updater signing key                |
| Environment secret  | `WINDOWS_CERTIFICATE`                | Authenticode certificate material              |
| Environment secret  | `WINDOWS_CERTIFICATE_PASSWORD`       | Unlocks the Windows certificate                |

The Tauri updater signature and Windows Authenticode signature are separate checks. Never put
private signing material in the repository, build logs, test fixtures, screenshots, or release
metadata.

## Release and contribution boundary

Keep every manifest and runtime version synchronized on `1.8.0`. Run source lanes, package smoke,
release audit, secret scan, native visual/functional acceptance, installer lifecycle, and updater
tests from the same source revision. Verify the README screenshots and demo against that exact
package.

Use focused commits, preserve unrelated dirty files, and record unverified gates honestly. Fixtures,
old executables, labels, and green unit tests do not establish live provider, CUDA, updater,
installer, or rendered-app behavior. The owner reviews the local candidate before any push, workflow
run, tag, publication, or distribution.

## Historical companions and workshop

The 24 historical advisors span six eras, four companions each: New Kingdom Egypt, Classical and
Hellenistic Greece, Rome, the Viking Age, the Mongol Empire, and medieval Europe. Filter them by era
in Add Cupcake. Their model, instructions, speaking rules, and portrait remain editable.

Open **Tools → History workshop** for a map-based travel estimate, siege supplies, or horse forage.
Change the inputs and save the resulting explanation to the current project. Coastlines are modern,
settlement coordinates are approximate, and dashed lines are distance guides rather than verified
historical routes. The calculations are transparent teaching scenarios, not campaign
reconstructions. [Asset and map provenance](design/history-companions.md).
