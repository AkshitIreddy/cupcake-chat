# Corrective local-candidate testing

The Tauri overhaul is not accepted yet. This guide defines the fresh evidence required before the
owner receives a new test application. Previous package, provider, local-model, installer, visual,
and performance results are historical only.

## 1. Record the candidate

From Windows PowerShell:

```powershell
git status --short
git branch --show-current
git rev-parse HEAD
node --version
pnpm --version
rustc -Vv
cargo --version
py -3.12 --version
```

Record Windows edition/build, CPU, RAM, disk, GPU/VRAM, WebView2 version, display scale, app zoom,
commit, and exact executable type. Do not test against the owner's ordinary profile.

## 2. Automated source gates

```powershell
corepack enable
corepack prepare pnpm@10.15.1 --activate
pnpm install --frozen-lockfile
pnpm format:check
node scripts/verify.mjs --lane all
node scripts/setup-fixtures.mjs --clean
pnpm test:e2e
```

Browser E2E does not prove native behavior. Run the exact packaged Tauri/WebView2 executable with a
fresh disposable profile and retain its opened screenshots separately. The local-model acceptance
harness is `scripts/accept-packaged-local-model.mjs`; it refuses to start unless the caller supplies
an already-acquired GPU marker whose contents are `yes`.

## 3. Build a local unsigned Tauri candidate

```powershell
node scripts/package-sidecars.mjs
node scripts/test-atomic-directory.mjs
node scripts/test-sidecar-protocol.mjs
pnpm --filter @cupcakeagi/desktop bundle:nsis
node scripts/smoke-package.mjs --platform win32 --mode bundle
node scripts/release-candidate-audit.mjs --require-artifacts
```

After a successful build, record rather than assume the exact paths:

- `apps/desktop/src-tauri/target/release/CUPCAKEAGI.exe`;
- the single `apps/desktop/src-tauri/target/release/bundle/nsis/CUPCAKEAGI 2_*-setup.exe`.

The package smoke currently verifies both paths. Rebuild and rerun it whenever renderer, host,
sidecar, generated contract, or signed catalog input changes.

The 2.0 current-user installer identity is `CUPCAKEAGI 2`, while `mainBinaryName` keeps the product
executable `CUPCAKEAGI.exe`. This deliberately prevents Tauri's default
`%LOCALAPPDATA%\<productName>` install path and uninstall key from colliding with retained 1.x data.
Do not use NSIS `/D` as lifecycle evidence: Tauri's current-user template ignores it. Run
`scripts/test-nsis-lifecycle.mjs`; it reads the registered location, refuses a pre-existing 2.0
record or directory, and never operates on `%LOCALAPPDATA%\CUPCAKEAGI`.

## 4. Disposable profile

Use a new absolute child of:

```text
C:\Users\akshi\Desktop\Code Palace\Cupcakeagi\out\tauri-test-profiles\
```

Set `CUPCAKE_TEST_DATA_DIR` to that absolute, non-root directory before launching the packaged
executable. Record the exact directory in the final handoff. Never reuse an older desktop profile as
acceptance evidence, and never delete the owner's normal application data.

## 5. Reproduce the rejected baseline complaints

Retain the baseline captures made by `scripts/capture-corrective-baseline.mjs` as historical repro
evidence. In the completed Tauri app, prove:

1. provider setup never opens a generic credential window;
2. a fresh Models screen shows compatible installable choices;
3. every scroll container uses intentional themed scrollbars;
4. titlebar controls never overlap content.

## 6. Provider flow and hosted conversations

For no-provider, form, invalid key, testing, success, rate-limited, offline, reconnect, and removal
states, capture and inspect the real app. Confirm paste/reveal/clear, cancellation, accessible
errors, privacy/cost review, model discovery, saved masked identity, and last-tested time.

Run deterministic fixtures for all retained providers. Then, only when authorized credentials and
current terms permit, run NVIDIA NIM and at least one direct adapter such as Cohere through the
finished UI. Conduct several multi-turn chats: follow-up references, edit/branch, regenerate, stop,
continue, long Markdown/code/table output, ambiguity, provider switching, and error recovery.

Record model identifiers, versions, timings, usage, and redacted logs. Secret-pattern scans must
cover logs, events, databases, diagnostics, crash output, screenshots, and Git. Fresh packaged
NVIDIA NIM and Cohere conversations have passed through the application-owned flow; this does not
waive the remaining provider/error matrix or turn evaluation access into a production entitlement.

## 7. Cupcake Local

With no model installed, verify a nonempty device-ranked catalog and explain each fit. Test task,
size, license, tools/vision, and local-only filters. Exercise download, pause/resume, cancel,
restart, retry, checksum failure, insufficient disk/RAM/VRAM, install, load, benchmark, chat, stop,
unload, remove, and version replacement.

Restart during download and inference. An incomplete object must never become installed, and
recovery must not duplicate effects. After one verified download, disconnect the network and
complete a chat. Record measured tokens/second and context settings. No corrective app-managed local
chat or benchmark has been obtained yet.

Before NVIDIA model work, read `C:\Users\akshi\Desktop\Code Palace\gpu use.txt`. If it is `yes`, do
not use the GPU. If available, set it to `yes` immediately before model load and restore `no` after
unload and sidecar shutdown, including failure paths. Ordinary app rendering does not take GPU-model
ownership.

## 8. Native window and visual matrix

Open and inspect every image; DOM assertions are insufficient. Cover all four themes at 360, 768,
1024, 1440, and ultrawide widths. Add restored, maximized, minimum-size, narrow, common Windows DPI,
200% and 400% app zoom, keyboard focus, high contrast, and reduced motion.

Inspect titlebar drag zones and controls, provider sheets, model catalog/states, navigation, chat,
composer, code, tables, artifacts, drawers, dialogs, nested panels, and all custom scrollbars. Test
wheel, touchpad, keyboard, Page Up/Down, Home/End, visible focus, and screen-reader streaming.

## 9. Core/security/durability

Rerun corrupt-key, migration, backup/restore, object integrity, project isolation, DAG, FTS, and
interrupted indexing cases. Exercise forged/oversized commands and events, replay/sequence errors,
approval tampering, traversal and junction races, prompt injection, secret redaction, sandbox
network denial, resource limits, and process-tree termination.

Kill/restart during hosted streaming, local inference, download, tool calls, ingestion, artifact
writes, approvals, tasks, and subagents. Recovery must not duplicate visible events or external
effects.

## 10. Installer and performance

On clean Windows 10 and Windows 11 x64, verify current-user silent/interactive install, first run,
paths with spaces and non-ASCII characters, protocol registration, sidecars, upgrade between two
different local versions, crash recovery, uninstall, and explicit data retention. Do not configure
an update feed.

Measure startup-to-interactive and steady-state working set on the reference machine and compare
with the recorded rejected baseline using the same method. Report numbers; do not assume Tauri is
faster. No corrective installer lifecycle or performance result exists yet.

## Final handoff

Lead with complaint-by-complaint changes, exact verified executable/installer/profile paths, models
actually tested, opened screenshots/video, redacted logs, startup/memory/tokens-per-second numbers,
known issues, owner steps, GPU marker `no`, and confirmation that nothing was pushed, published,
released, distributed, signed for production, or connected to an updater.
