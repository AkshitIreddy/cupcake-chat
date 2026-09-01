# Developing CupcakeAI 2.0

CupcakeAI is a Windows-only Tauri 2 application. React renders the workbench; the Tauri Rust host
owns native lifecycle and narrow commands/events; the packaged Python runtime owns product behavior;
the Rust ToolBroker owns credentials, grants, tool policy, MCP, audit, and sandboxing.

This guide does not authorize publishing, distribution, signing, or updater configuration.

## Layout

| Path                        | Responsibility                                                      |
| --------------------------- | ------------------------------------------------------------------- |
| `apps/desktop/src/renderer` | React/TypeScript renderer                                           |
| `apps/desktop/src-tauri`    | Tauri host, capabilities, window lifecycle, native commands/events  |
| `packages/contracts`        | TypeBox contracts plus checked-in JSON Schema/Pydantic/Serde output |
| `services/runtime`          | Providers, persistence, retrieval, memory, tasks, and Cupcake Local |
| `crates/tool-broker`        | DPAPI vault, policy, grants, tools, MCP, sandbox, and audit         |
| `packaging`                 | Local-candidate sidecar and runtime-catalog inputs                  |

## Windows prerequisites

- Windows 10/11 x64 and Windows PowerShell, not WSL, for native validation;
- Node.js 20.19+, Corepack, and pnpm 10.15.1;
- Python 3.12 with `venv`;
- stable `x86_64-pc-windows-msvc` Rust with rustfmt and Clippy;
- Visual Studio C++ Build Tools with Desktop development with C++;
- WebView2 Runtime and Git.

WSL may inspect the tree and run portable checks, but it does not prove WebView2 rendering, DPAPI,
Windows paths, Job Objects, DPI, titlebar hit testing, or installer behavior.

## Install and run

```powershell
corepack enable
corepack prepare pnpm@10.15.1 --activate
pnpm install --frozen-lockfile
pnpm --filter @cupcakeagi/desktop dev
```

The Tauri host starts the Vite renderer and uses a custom undecorated window. Only intended empty
titlebar regions may initiate dragging. Buttons and application content must remain non-draggable.

## Contracts

```powershell
pnpm --filter @cupcakeagi/contracts typecheck
pnpm --filter @cupcakeagi/contracts test
pnpm --filter @cupcakeagi/contracts generate:schemas
pnpm --filter @cupcakeagi/contracts check:schemas
```

Commit declarations and generated JSON Schema, Pydantic, and Serde outputs together. Boundaries
reject unknown versions/properties, oversized frames, expired deadlines, replay, sequence gaps, and
unknown methods. Renderer contracts contain opaque handles, never raw paths or credentials.

## Python runtime

```powershell
py -3.12 -m venv services\runtime\.venv
services\runtime\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e "services/runtime[documents,durability,packaging,providers,sqlcipher,test]"
python -m pytest services/runtime/tests
```

Tests use temporary profiles. Live provider tests are explicit, secret-safe opt-ins and supplement,
not replace, deterministic fixtures.

## Rust broker and host

```powershell
cargo fmt --manifest-path crates/tool-broker/Cargo.toml --all -- --check
cargo clippy --manifest-path crates/tool-broker/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path crates/tool-broker/Cargo.toml --all-features
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --all-features
```

The repository verifier runs these as the `rust` lane:

```powershell
node scripts/verify.mjs --lane all
```

## Provider onboarding

Provider setup is application-owned. The renderer may hold the typed key only for the active form
and passes it once to a trusted Tauri command. The trusted boundary tests/discovers the provider and
stores the credential with per-user DPAPI. Bootstrap, logs, events, databases, screenshots, crash
output, and diagnostics must never contain the secret.

Every direct adapter requires deterministic tests for discovery, streaming, stop, errors, rate
limits, usage, capability disclosure, and switching. Live checks use small limits and disposable
accounts only.

## Cupcake Local

Cupcake Local owns its llama.cpp runtime. Model weights are optional downloads and are never
bundled. Development covers hardware fixtures, signed catalog parsing, fit explanations, resumable
downloads, checksum failure, low disk, atomic promotion, load/unload, benchmark, offline chat,
removal, and restart recovery. Do not take GPU ownership without following `docs/local-testing.md`.
The Windows/NVIDIA pack ladder is CUDA 13.3 for driver 580+, CUDA 12.4 for older supported drivers,
Vulkan fallback, then the bundled CPU baseline. Test both NVML discovery and the runtime's own
`--list-devices` activation probe; catalog compatibility alone is insufficient.

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
configuration must declare both external binaries and the resource directory. The NSIS bundle is
unsigned, current-user, local-test output.

## Visual and accessibility acceptance

Browser tests are renderer regression checks. Native claims require the real Tauri/WebView2 window.
Capture and open screenshots at 360, 768, 1024, 1440, and ultrawide widths, all themes, restored and
maximized states, 200–400% zoom, common DPI scales, high contrast, and reduced motion. Exercise
keyboard focus, screen-reader streaming, custom scrollbars, titlebar dragging/buttons, long code and
tables, sheets, dialogs, drawers, and nested panes.

## Contribution boundary

Use disposable profiles, preserve unrelated dirty work, update contracts and docs with behavior, and
record unverified gates honestly. Never present fixtures or an old artifact as live Tauri evidence.
