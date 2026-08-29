# Developing CUPCAKEAGI 2.0

CUPCAKEAGI is a multi-language desktop workspace. The renderer is deliberately untrusted; Electron
owns the desktop lifecycle; the Python runtime owns model and product behavior; the Rust ToolBroker
owns credentials, grants, tool policy, MCP transports, audit, and sandboxed process execution.

This guide covers source development. It does not authorize publishing or distributing a build.

## Repository layout

| Path                         | Responsibility                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/desktop`               | Electron main/preload plus the React/TypeScript/Vite renderer                                        |
| `packages/contracts`         | Product-owned TypeBox contracts and generated versioned JSON Schema                                  |
| `services/runtime`           | Python providers, durable workflows, persistence, retrieval, memory, models, migration, and fixtures |
| `crates/tool-broker`         | Rust security boundary, framed transport, credentials, policy, tools, MCP, audit, and sandboxing     |
| `docs/architecture`          | Decisions, security model, runtime details, migration design, and completion ledger                  |
| Git history and `v1.0.0` tag | Recoverable 1.x implementation; intentionally absent from the active 2.0 tree                        |

Do not restore or add new 2.0 behavior to the legacy backend or frontend. The `v1.0.0` tag remains
the clean historical reference, and the constrained importer reads only an explicitly selected
legacy data folder.

## Prerequisites

Use the versions declared by repository manifests where they are more specific:

- Node.js 20.19 or newer
- Corepack and pnpm 10.15.1 or newer
- Rust stable with Cargo
- Python 3.12 with `venv`
- Git

Windows 10 and Windows 11 on x64 are the only native and release-candidate targets. Run the desktop
and packaging commands from Windows PowerShell, not from WSL, when validating product behavior. WSL
is suitable for repository inspection and portable unit checks but does not prove DPAPI credential
protection, Windows paths, AppContainer/Job Object containment, installer behavior, or graphics
behavior. macOS, Linux, Windows on Arm, and 32-bit Windows are outside the 2.0 support contract.

## Install JavaScript dependencies

From the repository root:

```powershell
corepack enable
corepack prepare pnpm@10.15.1 --activate
pnpm install --frozen-lockfile
```

Do not run `npm install` inside the old `frontend/assistant` directory. It is not part of the 2.0
pnpm workspace.

## Run the desktop

```powershell
pnpm --filter @cupcakeagi/desktop dev
```

Electron Forge starts the main process, narrow preload, and Vite renderer. Development fixtures
should keep the interface navigable when the Python runtime, broker, cloud credentials, and local
model servers are unavailable.

Create a fresh, disposable fixture workspace when an integration test needs files or a repository:

```powershell
node scripts/setup-fixtures.mjs --clean
```

The command writes only beneath `out/test-fixtures` and refuses to clean an unmarked directory.

The production renderer must retain these invariants:

- context isolation and renderer sandbox enabled;
- Node integration disabled;
- no `ipcRenderer`, raw path, credential, arbitrary network, or arbitrary process primitive exposed
  to React;
- navigation, popup, permission, and external-origin requests denied unless explicitly allowlisted;
- CSP enforced from packaged application content;
- desktop actions exposed only as typed, narrow preload methods.

## Work with contracts

TypeBox declarations under `packages/contracts/src` are the canonical TypeScript source. Checked-in
JSON Schemas under `packages/contracts/schema/v1` are the language-neutral boundary for Pydantic and
Serde consumers.

```powershell
pnpm --filter @cupcakeagi/contracts typecheck
pnpm --filter @cupcakeagi/contracts test
pnpm --filter @cupcakeagi/contracts generate:schemas
pnpm --filter @cupcakeagi/contracts check:schemas
```

Generate schemas after a contract change and commit the source and generated output together. The
generation command also refreshes the checked-in Pydantic models at
`services/runtime/src/cupcake_runtime/generated/contracts_v1.py` and Serde models at
`crates/tool-broker/src/generated/contracts_v1.rs`. `check:schemas` fails if any JSON Schema,
manifest, Pydantic model, or Serde model is stale.

Contract rules:

- reject unknown properties at boundaries;
- use UUIDv7 for durable product identities;
- use UTC RFC 3339 timestamps;
- keep the protocol frame at or below 8 MiB;
- enforce version, deadline, authentication, and monotonic per-correlation sequence;
- never persist raw provider objects, credentials, hidden reasoning, framework checkpoints, or raw
  local paths;
- use additive changes within version 1 and a new protocol/schema version for incompatibilities.

## Run the Python runtime checks

The runtime is a Python package under `services/runtime`. Use its checked-in package metadata as the
authority for extras and commands in the build you are testing. A conventional setup is:

```powershell
py -3.12 -m venv services\runtime\.venv
services\runtime\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e "services/runtime[documents,durability,packaging,providers,sqlcipher,test]"
python -m pytest services/runtime/tests
```

If `services/runtime/pyproject.toml` or its `test` extra is absent, the runtime workspace is not
ready for a reproducible standalone setup. Do not invent an ad hoc dependency list or install the
legacy Conda environment; record the missing metadata as a release-candidate blocker.

The runtime writes test databases and object stores only to temporary directories. Never point tests
at a real CUPCAKEAGI profile. Provider tests use deterministic recorded fixtures by default; live
tests require explicit opt-in and user-supplied credentials through the test harness.

## Run the Rust ToolBroker checks

```powershell
cargo fmt --manifest-path crates/tool-broker/Cargo.toml -- --check
cargo clippy --manifest-path crates/tool-broker/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path crates/tool-broker/Cargo.toml --all-features
```

The broker protocol reserves stdout for length-prefixed frames. Send redacted structured logs to
stderr. Never print credentials, approval bearer material, prompt/file contents, or raw environment
values.

Security-sensitive changes require adversarial tests for replay, expiry, payload mismatch,
traversal, symlink/junction replacement, scheme/origin validation, output and time limits,
process-tree termination, and secret redaction.

## Workspace checks

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Or run the JavaScript/TypeScript lint, type, and unit checks together:

```powershell
pnpm check
```

With the Python test dependencies and Rust toolchain installed, the repository-owned cross-language
verifier is:

```powershell
node scripts/verify.mjs --lane all
```

Individual lanes are `contracts`, `js`, `python`, and `rust`. CI uses the same verifier rather than
maintaining a second set of validation commands.

The root `build` runs each workspace package build. Electron packaging and the Windows installer are
separate because they are slower and must be validated from Windows x64.

## Visual and interaction development

Visible work is not accepted from source inspection alone.

1. Start one exclusive desktop development server.
2. Exercise the real interaction with Playwright.
3. Capture the required full frame and a focused close-up.
4. Inspect the rendered images rather than relying only on locators or DOM assertions.
5. Repeat for changed themes, narrow layouts, keyboard flow, reduced motion, error states, and zoom
   where relevant.

Required viewport widths are 360, 768, 1024, 1440, and ultrawide. Required themes are Cupcake Light,
Cupcake Dark, Minimal, and Classic. Test fixtures must cover empty, loading, streaming, complete,
offline, approval, provider error, tool error, task interruption, and cost-warning states.

Accessibility verification includes keyboard-only operation, visible focus, screen-reader
live-region behavior, non-color state indicators, 200% and 400% zoom/reflow, high contrast, reduced
motion, and accessible Markdown structures.

## Persistence and durable-task development

Use separate databases for product state, DBOS/runtime checkpoints, and broker security records. Use
temporary profiles in tests.

- Journal canonical events before broadcasting them.
- Make side-effecting and nondeterministic workflow steps explicit and idempotent.
- Store large outputs as encrypted object references, not checkpoint payloads.
- Pin pending tasks to a compatible runtime revision.
- Treat conversation and artifact edits as append-only revisions with mutable heads.
- Preserve project scope through retrieval, memory, search, tools, and backup/restore.
- Reject corrupt keys, corrupt objects, partial migrations, and incompatible protocol versions
  safely.

Durability acceptance requires killing and restarting the runtime during a model call, tool call,
file ingestion, artifact write, approval pause, and subagent run. Recovery must not duplicate side
effects or UI events.

## Providers and local runtimes

Provider adapters normalize output into CUPCAKEAGI events. Tests must cover streaming, cancellation,
reasoning summaries where available, tools, citations, usage, malformed frames/events, rate limits,
and provider switching.

Keep live-provider tests opt-in. Never store live credentials in the repository, shell history,
screenshots, snapshots, or test output.

Local runtime development must test absent, stopped, starting, ready, degraded, and crashed states.
Download tests cover range resume, cancellation, low disk, checksum mismatch, unexpected content
type, catalog signature, license acknowledgement, atomic promotion, load/unload, removal, and
measured tokens per second.

## Package locally

Install PyInstaller into the active runtime environment, then stage the two native sidecars for the
current host:

```powershell
python -m pip install pyinstaller
node scripts/package-sidecars.mjs
```

Build an unpacked application first and verify its launcher plus sidecar manifest:

```powershell
pnpm --filter @cupcakeagi/desktop package
node scripts/smoke-package.mjs --platform win32 --mode package
```

Create the Windows x64 installer only from Windows x64:

```powershell
pnpm --filter @cupcakeagi/desktop make
node scripts/smoke-package.mjs --platform win32 --mode make
node scripts/release-candidate-audit.mjs --require-artifacts
```

Electron Forge is configured only for Squirrel and ZIP on Windows x64 and rejects every other
platform/architecture. Configuration does not prove the artifacts work. A release-candidate pass
must validate installation on clean Windows 10 and Windows 11 x64 machines, first run, protocol
registration, runtime/broker launch, update from a prior test build, uninstall, and user-data
retention.

Do not add a production update URL, sign for distribution, upload artifacts, publish a package, push
a release branch, or create a GitHub release without explicit owner approval.

## Legacy migration

The legacy importer is one-way and constrained:

- scan known 1.x data locations only after user selection;
- parse data without executing old code;
- produce an import plan and report;
- write idempotently using provenance and stable import keys;
- never import `.env` files, API keys, tokens, bytecode, generated scripts, or unsafe state;
- leave the source untouched until the user chooses to remove it.

Keep migration fixtures synthetic. Never commit a real legacy profile.

## Contribution checklist

Before handing off a change:

- update product-owned contracts when a boundary changes;
- include unit and integration coverage proportionate to the risk;
- test unhappy paths and cancellation, not only success;
- verify privacy route, project scope, approval, and redaction behavior;
- run the relevant TypeScript, Python, and Rust checks;
- capture and inspect rendered evidence for UI changes;
- update user-facing docs and known issues when behavior changes;
- leave unrelated dirty files untouched;
- do not publish or push a release.
