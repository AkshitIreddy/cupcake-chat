# CupcakeAI 2.0 — Tauri overhaul and corrective review handoff

**Updated:** 2026-09-03 IST
**Repository:** `C:\Users\akshi\Desktop\Code Palace\Cupcakeagi`
**Final local branch:** `master` (consolidate locally after verified implementation; do not push)
**Target:** Windows 10/11 x64, local single-user application
**Release policy:** local testing only. Do not push, publish, create a release, distribute an
artifact, or configure an updater without explicit owner approval.

## 2026-09-03 first-run, discovery, and visual continuation

This continuation is implemented locally on `master` and is not pushed. The owner-test launcher
remains `Launch CupcakeAI Test.vbs`; it starts the real `CupcakeAI.exe` without a console and points
it at `E:\temp\cupcakeai-owner-test-20260902`.

Implemented product changes:

- first setup now asks for the user's name and cupcake portrait and offers either Windows-protected
  quick-open or an extra app password. Quick-open still uses DPAPI plus the existing encrypted
  SQLCipher/artifact stores; it only removes the separate password prompt;
- the post-unlock history loader is centered at desktop and narrow sizes and uses randomized
  generated artwork. Optional services remain lazy rather than blocking old-chat access;
- onboarding is now an eight-step, replayable, interactive tutorial with unsquashed square art,
  profile editing, readiness checks for providers/local models/runtimes, and links to unfinished
  setup. Dismissing it no longer lets later configuration updates reopen it during the session;
- Home's assistant portrait, unread treatment, model/provider mark, and local/cloud privacy copy
  were corrected. Appearance includes four generated selectable workspace wallpapers;
- the Models screen requests up to 120 read-only Hugging Face GGUF results, progressively reveals
  them, accepts pasted Hugging Face model URLs, and separately identifies the connected live NVIDIA
  NIM catalog. Live NIM rows without a provider field are normalized at the trusted response
  boundary instead of crashing the page or appearing as `Unknown`;
- large generated Tauri sidecar inputs now live under `E:\temp\cupcakeagi-tauri-inputs` through
  junctions. `scripts/package-sidecars.mjs` resolves junction targets before atomic promotion, and
  the freshly frozen packaged runtime contains the expanded discovery implementation.

Fresh packaged native acceptance against the owner profile reports 65 live NVIDIA NIM models,
120 Hugging Face results, 106 initially rendered model cards, and zero WebView errors. The inspected
native screenshot is `E:\temp\cupcakeai-owner-test-20260903-ui\native-models-nim.png`; broader
visual evidence is under `E:\temp\cupcakeai-visual-20260903`.

Verification for this continuation:

- ESLint and workspace TypeScript typecheck pass;
- Vitest: 10 files, 119 tests pass;
- Python runtime: 390 pass, 1 expected skip;
- Rust host: 26 tests pass; Clippy passes with warnings denied;
- package smoke and frozen-sidecar verification pass;
- Playwright's 44-check desktop/narrow matrix passes after the narrow loader correction;
- CUDA 13 remains the active owner-profile runtime, but no GPU inference was needed for this
  continuation. Recheck `gpu use.txt` and task-owned processes before claiming a clean final state.

## 2026-09-02 owner-ready Windows/NVIDIA continuation

The current owner-test profile is ready for immediate use without a terminal:

- launch `Launch CupcakeAI Test.vbs` from the repository root;
- unlock with the owner-supplied test password;
- the isolated profile is `E:\temp\cupcakeai-owner-test-20260902`, with WebView2 data and the
  4.68 GiB Qwen weight also kept off `C:`;
- Cohere and NVIDIA NIM credentials are connected through DPAPI, the app-managed Qwen3 8B
  Q4_K_M model is installed and selected, and the verified active local runtime is
  `llama.cpp:b10679:windows-x64-cuda-13.3`;
- hosted and local chats both passed against this exact profile. Provision evidence is at
  `E:\temp\cupcakeai-owner-test-20260902-evidence.json`.

This continuation changes startup and product behavior rather than only adding fixtures:

- encrypted history and the shell now open first; hardware inspection, provider hydration, task
  recovery, model loading, and local acceleration wake only when the relevant feature is used;
- selecting an installed local model triggers a just-in-time safe load, idle models can auto-evict,
  and the UI exposes RAM fallback, system-RAM reserve, VRAM reserve, and idle-time controls;
- the Models screen includes a live, read-only Hugging Face GGUF discovery surface and an expanded
  NVIDIA NIM hosted catalog. Discovery results remain outside the checksum-pinned install pipeline;
- the unlock and opening states use randomized generated dreamscapes and meaningful progress,
  onboarding is an interactive six-step spotlight tour, and setup completion is reflected when the
  tour is replayed;
- twenty generated cupcake profile portraits and twenty selectable assistant portraits replaced
  the placeholder avatars. The chosen assistant portrait is used on Home;
- settings navigation is sticky, model license/provider filters were removed, provider cards use
  recognizable marks and connected-state color, and the final dark-theme active-navigation
  contrast passes the shipped WCAG AA gate;
- close now defaults to immediate quit, performs a fast sidecar shutdown, and shows no confirmation
  popup. Close-to-tray remains an explicit setting. Two packaged, CDP-attached acceptance runs
  measured 1.3–3.8 seconds from click to full process exit; the sidecar itself is killed immediately.

Current visual evidence was captured and inspected under `E:\temp\cupcakeai-ui-pass2` and
`E:\temp\cupcakeai-owner-test-20260902-ui`. The native owner profile reached an unlocked ready
workspace with no renderer error and a real SVG settings icon. Generated app art is compressed to
about 1.1 MiB total under `apps/desktop/public/art`; stale sidecar staging directories are now
pruned safely, and only the verified final sidecar set remains under `E:\temp\cupcakeagi-out`.

Final gates for this continuation:

- ESLint and workspace TypeScript typecheck pass;
- Vitest: 10 files, 118 tests pass;
- Python runtime: 389 pass, 1 skip;
- Rust host: 25 tests pass; Clippy passes with warnings denied;
- Playwright Windows desktop: 17 scenarios pass after the dark-theme contrast correction;
- native close acceptance passes with no popup;
- GPU ownership marker is restored to `no`, and no CupcakeAI, runtime, broker, or llama process is
  intentionally left running.

The runtime-selection research and official-source rationale are recorded in
`docs/research/windows-nvidia-model-runtime-20260902.md`. Nothing from this continuation is pushed,
published, or released. Keep subsequent work on local `master` unless the owner explicitly asks for
another branch.

## 2026-09-01 headless continuation

The owner asked that further testing not open the desktop application or visible terminals. The
following current evidence is therefore deliberately split between real headless runtime/provider
calls and headless renderer verification. It does **not** claim fresh installed-app UI acceptance.

- Local CUDA inference is now real and passing after commit `96952bf` fixed the authenticated
  llama.cpp readiness probe. `scripts/accept-headless-local-runtime.py` loaded the verified Qwen3
  8B Q4_K_M weight through the production supervisor at a 4,096-token context, observed 5,894 MiB
  GPU memory and 58% utilization on the RTX 4080 Laptop GPU, measured 65.0 generated tokens/second,
  and received exactly `CUPCAKE LOCAL CUDA HEADLESS ACCEPTED`. Evidence:
  `artifacts/runtime/headless-local-20260901.json`.
- Real hosted onboarding and chat pass headlessly with the authorized Cohere trial credential.
  Live discovery returned 20 models; `command-a-plus-05-2026` repeatedly failed with Cohere HTTP
  422 `INVALID_TOOL_GENERATION`, while discovered `command-a-03-2025` completed normally with usage
  metadata. The built-in catalog/default was corrected to Command A. Evidence:
  `artifacts/runtime/headless-cohere-20260901.json`.
- Secret values were read only in memory and were not printed, copied, committed, or written to
  evidence. The GPU marker was restored to `no`, and no app or llama-server process was left alive.
- Verification passed: 91 focused Python provider/local-model tests, 38 renderer unit tests, the
  focused Rust hidden-window test, TypeScript typecheck, and 28 Playwright tests across desktop and
  narrow headless Chromium. Rendered evidence is under
  `artifacts/screenshots/headless-acceptance-20260901/` and was visually inspected.
- Large generated roots now live on `E:\temp` through local junctions: `out` points to
  `E:\temp\cupcakeagi-out`, and the Tauri target points to
  `E:\temp\cupcakeagi-tauri-target`.
- The headless continuation is saved locally on `master` in `084c058` (hidden packaged test
  sessions), `0ceb4e4` (working Cohere Command A default), and `8d4eaa9` (direct headless
  runtime/provider acceptance harnesses). Nothing was pushed or released.

Still required for the original completion contract: a fresh installed-app UI conversation through
both hosted and local routes, plus visible installed-app lifecycle/restart screenshots. Those checks
were intentionally not run because they require opening a desktop window, which the owner declined.

## Start here

The owner tested the current build and rejected it as a release candidate. Treat the current tree as
an implementation and evidence baseline, not as accepted product work. This handoff supersedes the
release-ready conclusions in `see me`, `docs/PAUSED_HANDOFF.md`, and earlier RC notes.

The corrective task is a **complete Electron-to-Tauri overhaul**, followed by fresh human-style
testing of both a real hosted API and a real app-managed local model. Reusing reviewed React
components, contracts, Python runtime logic, database code, or broker security logic is allowed;
shipping Electron, its native-popup workflow, its window layout, or its packaging is not.

Do not close this task by citing old unit, Playwright, packaged NIM, or LM Studio evidence.
Reproduce the owner's complaints first, implement the new target, then create new Tauri evidence.

## Owner feedback — new source of truth

The following requirements override the current implementation and older architecture documents:

1. Provider setup must happen entirely inside CupcakeAI. The current setup opens an unattractive
   Windows UI. Replace it with an in-app setup sheet/page: provider choice, API-key entry, privacy
   and cost disclosure, connection test, supported-model discovery, success/error states, and
   credential removal. DPAPI may still protect the credential behind the scenes; no provider setup
   prompt may escape into a generic Windows credential dialog.
2. Local Models must present a useful installable catalog filtered or ranked for the detected
   device. The owner currently sees no compatible models to install.
3. Replace native-looking Windows scrollbars with deliberate CupcakeAI scrollbars throughout the
   application, including nested panels, code/table overflow, modals, drawers, and all four themes.
4. Replace Electron completely with Tauri for the Windows desktop host and installer. This is a
   performance and product-quality decision, not a request to put a Tauri wrapper around an
   unchanged, unreviewed UI.
5. Fix the window-control overlap. Minimize, maximize/restore, and close currently cover application
   content. The Tauri build needs an intentional titlebar whose drag region and control reservation
   remain correct across DPI scaling, 100–400% app zoom, maximized/restored states, and narrow
   windows.
6. Remove **LM Studio** support completely.
7. Remove **Ollama** support completely.
8. Re-run real conversations through the finished UI using a hosted provider and an app-managed
   local model. The owner's current assessment is that those paths were not credibly tested.

## Product direction that still applies

CupcakeAI 2.0 is a Windows-first, text-first local AI workbench. Chat is the primary surface for
models, files, tools, tasks, citations, memory, projects, and artifacts. Voice and automatic model
routing remain excluded. Model selection is explicit; optional failure fallbacks are disabled by
default and must disclose any cost/privacy boundary crossing.

Keep the “Quiet Confectionery Workbench” direction:

- persistent navigation for Home, Chats, Projects, Tasks, Artifacts, Memory, Models, Tools, Search,
  and Settings;
- a quiet chat canvas, readable prose, a capable multiline composer, the Frosting Thread, and
  concise expandable tool/task cards;
- Cupcake Light, Cupcake Dark, Minimal, and Classic themes;
- Bricolage Grotesque for restrained display use, Atkinson Hyperlegible for UI/conversation text,
  and IBM Plex Mono for code/data, all packaged locally with licenses;
- the grown CupcakeAI 2.0 mascot in ordinary product surfaces, with the original mascot retained
  only where historically useful, such as About or Classic;
- WCAG 2.2 AA, keyboard operation, visible focus, reduced motion, semantic streaming regions, and
  responsive layouts from 360 px through ultrawide.

Preserve the broader product contracts where they remain useful: canonical run events, immutable
conversation/artifact DAGs, project-scoped retrieval, typed memory, encrypted persistence,
durable/recoverable tasks, narrow tool approvals, redacted developer inspection, and no exposed
chain-of-thought.

The old v1 `write-the` MkDocs generator is historical at the `v1.0.0` tag. It is not a 2.0
dependency, migration target, compatibility target, or packaging system.

## Required Tauri target

Use current stable Tauri 2 for a Windows-only desktop host. The finished product must contain no
Electron runtime or Electron packaging path.

### Host and webview

- Keep the React/TypeScript renderer only after reviewing each reused screen against this handoff.
- Move window lifecycle, tray, protocol supervision, dialogs, deep-link policy, and native event
  routing into the Tauri Rust host.
- Replace Electron main/preload IPC with narrow typed Tauri commands/events and explicit
  capabilities. The renderer receives neither raw Node APIs nor arbitrary filesystem, process, or
  network primitives.
- Keep provider/model/tool traffic behind product-owned versioned contracts. Reject unknown
  versions, invalid or oversized frames, replayed approvals, and sequence errors.
- Preserve the packaged Python runtime if it remains the best home for Pydantic-backed provider
  adapters, retrieval, memory, persistence, and durable workflows. Supervise it as a Tauri
  sidecar—never as a public localhost service.
- Review the separate Rust broker boundary. It may remain a tightly scoped sidecar or be merged into
  the Tauri Rust process only if credential ownership, approval replay protection, path grants,
  process isolation, audit logging, and testability remain at least as strong.
- Use Windows DPAPI for credentials. Secret values may be entered in the in-app form and passed once
  to the trusted Rust boundary; they must not be stored in renderer state longer than necessary,
  written to product databases, returned by bootstrap APIs, included in logs, or captured in test
  artifacts.
- Replace Electron Forge/Squirrel output with Tauri's Windows bundling path. Select and test the
  appropriate local unsigned installer format for this pre-approval candidate. Production signing is
  outside scope until the owner explicitly asks for it.

### Titlebar and window controls

Implement one titlebar layout rather than combining Windows caption overlays with content beneath
them:

- reserve a fixed control zone that application content cannot enter;
- mark only intended empty titlebar regions as draggable;
- make minimize, maximize/restore, and close non-draggable semantic buttons with hover, pressed,
  focus, and high-contrast states;
- reflect maximize/restore state and double-click-to-toggle behavior;
- keep hit targets and content separation correct at common Windows scale factors, with text zoom,
  at the minimum supported window size, and in every theme;
- keep titlebar shortcuts and system-window behavior familiar without exposing a generic Windows
  provider-setup UI.

The completion criterion is rendered evidence showing no overlap at restored, maximized, narrow,
200% zoom, and a high-DPI configuration—not just bounding-box assertions.

## In-app provider setup

Provider onboarding should be an application-owned route or sheet, not an OS credential popup. For
each supported provider, include:

1. plain-language provider and privacy route;
2. a link to obtain a key and accurate free/trial caveats;
3. masked API-key input with paste, reveal, clear, and accessible error behavior;
4. optional endpoint/organization fields only when the adapter genuinely supports them;
5. a “Test connection” action with progress, cancellation, rate-limit/auth/network diagnostics, and
   model discovery where the provider supports it;
6. a review step explaining where prompts/files go and whether a selected model's capabilities are
   verified;
7. success state, saved masked identity, last-tested time, reconnect, and remove actions.

Keep direct adapters for OpenAI, Anthropic, Gemini, xAI, Mistral, and Cohere, plus generic remote
OpenAI-compatible endpoints. NVIDIA NIM is also a first-class hosted option added at the owner's
request. Do not present NIM as “unlimited” or make it the default based only on the owner's signup
message; verify current terms, limits, model compatibility, and tool/stream/usage behavior before
making a recommendation. There is no automatic provider routing.

The owner has a private key file at `C:\Users\akshi\Desktop\Code Palace\Commonly used Keys.txt`
containing test credentials including Cohere trial/production and NVIDIA NIM. The owner previously
authorized using it for local testing and said to **copy, not move**, if a working copy is
necessary. Prefer reading only the named entry at test time, never print the file or key, never add
it to Git, never put it in screenshots/logs, and remove disposable copies when the test is over.
ElevenLabs and AssemblyAI entries do not expand the text-first/no-voice scope.

The README must include a maintained “try before upgrading” provider guide so users can obtain their
own keys and understand likely free/trial limitations. Verify this information close to handoff
because provider plans change frequently.

## App-managed local models

The target local path is **Cupcake Local**, backed by an app-managed llama.cpp runtime. Users must
not need Node, Python, Conda, LM Studio, Ollama, or a separately installed model server. Model
weights remain optional downloads and are never bundled with the installer.

Remove all LM Studio and Ollama UI, discovery, routing, management, documentation, fixtures, and
tests. Preserve generic remote OpenAI-compatible endpoint support only as a clearly separate hosted
or user-managed remote-provider feature. External vLLM may remain only if its UI and documentation
cannot be confused with an installed local manager and its continued value is verified during the
architecture review.

### Model catalog behavior

The Models screen must become useful before any model is installed:

- detect CPU architecture/features, system RAM, available disk, Windows version, NVIDIA GPU/VRAM
  when present, and the installed Cupcake Local acceleration pack;
- load verified, versioned catalog metadata with model source, license, parameter count,
  quantization, file size, checksum, architecture, context choices, capability tags, and known
  runtime requirements;
- rank an installable list for the current device and explain every rating: Recommended, Fits with
  reduced context, CPU-only/slow, Hybrid, or Incompatible;
- show estimated RAM, VRAM, disk, context headroom, likely speed class, and why a model is or is not
  compatible;
- allow filtering by task, size, license, vision/tools capability, and local-only privacy;
- provide install, pause/resume, cancel, retry, checksum validation, version/update, remove,
  load/unload, and a measured post-load benchmark;
- survive restart during download without corrupting an existing model or claiming an incomplete
  object is installed;
- provide a safe CPU baseline and verified NVIDIA acceleration pack in app; arbitrary-code paths
  stay disabled unless the Windows sandbox is proven.

For a machine around 12 GB VRAM, the default recommendations should generally favor 7–9B
`Q4_K_M`-class models, allow selected 12–14B models with explicit context/headroom warnings, and
classify larger choices as hybrid, CPU-heavy, or unsuitable based on measured requirements. Do not
hard-code the owner's device: derive the recommendation and cover multiple hardware fixtures.

The completion criterion is a fresh-profile screenshot that already lists compatible installable
models, followed by a real catalog download, verified load, chat, unload, and restart test.

## Visual corrections

### Scrollbars

Define themed scrollbar tokens and apply them consistently to root navigation, chat, settings, model
grids, code blocks, tables, inspectors, sheets, dialogs, and artifact panes. Cover WebView2's
supported scrollbar pseudo-elements and provide keyboard, wheel, touchpad, page, Home/End, and
visible-focus behavior. Scrollbars need adequate contrast and usable hit areas; “hide every
scrollbar” is not an acceptable fix.

### Provider and model states

Capture and inspect complete rendered states for:

- no providers configured, provider form, invalid key, testing, success, rate-limited, offline, and
  removal confirmation;
- no runtime installed, catalog loading, recommended catalog, incompatible model explanation,
  downloading, paused, checksum failure, installed, loading, loaded, benchmarked, and removing;
- empty, loading, error, offline, narrow, zoomed, high-contrast, and reduced-motion variants.

The UI must not fall back to generic browser controls or Windows-default-looking inputs, menus,
dialogs, scrollbars, or progress elements where the application owns the interaction.

## Security and product boundaries to preserve

- SQLCipher product storage, separate durable-workflow/checkpoint storage, and broker/security audit
  storage remain encrypted and migration-tested.
- Files and artifact revisions remain encrypted immutable content-addressed objects; conversation
  and artifact edits create DAG branches rather than destroying history.
- Project scope is a privacy boundary. Retrieval, memory, files, and tool grants must not leak
  across projects.
- The renderer receives opaque handles instead of unrestricted paths and receives no credential,
  `cmd.exe`, PowerShell, arbitrary shell, raw process, or arbitrary network primitive.
- Generated code runs staged with no credential or network access by default, with resource limits,
  process-tree termination, and fresh approval for dangerous effects.
- MCP remains out of process with schema validation, origin protections, allowed-tool filters, and
  isolated sessions. Third-party code is not loaded into the Tauri host or renderer.
- Developer Mode may expose redacted events, approvals, usage, cost, latency, retrieval provenance,
  checkpoints, failures, and trace identifiers. It never exposes private chain-of-thought.

## Corrective implementation map

Audit before editing; do not assume every item should be preserved.

- React renderer and styles: `apps/desktop/src/renderer/`
- Tauri host, capabilities, commands/events, and bundle configuration: `apps/desktop/src-tauri/`
- Renderer-to-host client/contracts: `apps/desktop/src/shared/`
- Cross-language schemas and generated contracts: `packages/contracts/`, plus generated runtime and
  broker types
- Python runtime/provider/persistence logic: `services/runtime/`
- Rust broker/security/tool boundary: `crates/tool-broker/`
- Test and packaging utilities: `scripts/`, `tests/`, and package scripts
- Product/architecture/release documentation: `docs/`
- Historical screenshots/packages: older paths under `out/` and `apps/desktop/out/`; never current
  Tauri evidence
- Corrective generated package convention: `apps/desktop/src-tauri/target/release/` after a fresh
  successful Windows build

Relevant local commits, newest first:

- `718ddb4 docs(rc): record final local validation`
- `7d5d5e3 test(rc): cover packaged runtime and local model paths`
- `bba6e5d feat(runtime): complete secure local workspace`
- `87907a3 docs(rc): record final local testing evidence`
- `fbe7a7f fix(desktop): recover live NIM workflow`
- `7b4a466 fix(protocol): align canonical desktop envelopes`
- `ef7e848 feat(desktop): add Windows Electron text-first workbench`
- `2ed44d9 feat(runtime): add local providers storage and durable workbench`
- `983b9da feat(broker): add Windows security and native tool boundary`
- `c72df77 feat(contracts): add versioned cross-language product schemas`

Preserve Git history and the existing `v1.0.0` tag. Finish in small, verified commits on local
`master`; do not create or leave additional local branches. Do not rewrite or erase historical
commits; remove rejected code from the active tree through new commits.

## Prior evidence — historical only

The previous work reported green Ruff, strict Pyright, Python tests, Rust formatting/Clippy/tests,
TypeScript/ESLint, 138 unit tests, 22 Playwright tests, package smokes, and an Electron/Squirrel
installer lifecycle. It also retained screenshots of a packaged NVIDIA NIM conversation and a
packaged LM Studio GPU conversation under `out/live-ui/`.

These facts can help locate code paths and regression fixtures. They do **not** accept the Tauri
overhaul, the new provider UI, the installable local catalog, the corrected titlebar/scrollbars, or
the retained live model paths. LM Studio evidence is obsolete because that integration must be
removed. The old Electron installer and ZIP must not be handed back to the owner as the new test
app.

## Corrective execution order and completion criteria

### 1. Reproduce and inventory

Launch the current disposable build and capture the provider popup, empty/unhelpful local-model
screen, native scrollbars, and titlebar overlap. Inventory every Electron, LM Studio, and Ollama
dependency, source route, setting, test, documentation reference, and generated artifact.

**Complete when:** the four complaints have reproducible evidence and every removal target is
accounted for.

### 2. Establish the Tauri host

Create the Tauri 2 Windows host, typed command/event surface, security capabilities, sidecar
supervision, custom titlebar, local dev loop, packaging path, and migration strategy for existing
2.0 test data.

**Complete when:** the application boots without Electron installed or running, can reopen an
existing disposable product database safely, shuts down sidecars cleanly, and produces a local
unsigned Windows package.

### 3. Replace provider onboarding

Build and visually review the in-app setup experience, DPAPI-backed credential lifecycle, model
discovery, connection testing, and failure states for all retained providers.

**Complete when:** a fresh profile can configure, test, use, and remove a real hosted key without
opening any generic Windows credential UI or exposing the secret.

### 4. Replace local-model management

Remove LM Studio/Ollama and finish Cupcake Local hardware detection, catalog recommendation,
download, checksum, load/unload, benchmark, chat, and recovery paths.

**Complete when:** a fresh profile shows device-appropriate choices before installation and a
catalog model completes a real chat entirely through the app-managed runtime.

### 5. Finish visual and interaction corrections

Apply the custom scrollbar system, fix titlebar overlap, inspect every theme and responsive
breakpoint, then correct any reused Electron-era screen that still looks generic or misbehaves.

**Complete when:** new screenshots have been visually inspected at 360, 768, 1024, 1440, and an
ultrawide width for every theme, plus focused titlebar/provider/model/scrollbar evidence at relevant
Windows scale and zoom settings.

### 6. Re-run the whole release gate

Run contracts/storage/provider/local-model/durability/security/UI/accessibility/performance and
installer checks against the Tauri candidate. Update README, architecture decisions, local-testing
instructions, known issues, and the owner handoff to describe only the current architecture.

**Complete when:** all acceptance checks below have evidence, a new disposable local test path is
provided, and no old Electron artifact is represented as current.

## Fresh acceptance checks

### Architecture and removal

- [ ] `rg` and dependency inspection find no active Electron runtime, preload, Forge, or Squirrel
      path.
- [ ] No Electron process is present during the packaged app test.
- [ ] `rg` and runtime/UI inspection find no active LM Studio or Ollama integration, setting, route,
      documentation promise, or test fixture except explicitly labeled historical migration notes.
- [ ] The packaged Windows app installs, launches, updates between two local test versions,
      uninstalls, and follows the documented user-data retention choice.
- [ ] Startup time and steady-state memory are measured on the reference machine and compared with
      the Electron baseline; report numbers rather than assuming Tauri is faster.

### Provider setup and hosted chat

- [ ] Provider setup, key entry, connection test, model discovery, error recovery, and removal all
      remain inside the application.
- [ ] No key reaches logs, screenshots, persisted renderer state, product databases, Git, crash
      reports, or test snapshots.
- [ ] A fresh-profile real hosted conversation streams, can be stopped, can continue/retry, records
      usage when supplied, and survives provider/model switching from canonical visible history.
- [ ] Test at least NVIDIA NIM and one direct adapter such as Cohere when credentials and current
      free/trial limits permit. A live key test supplements deterministic provider fixtures; it does
      not replace them.

### Local models

- [ ] With no model installed, Local Models displays a nonempty device-ranked catalog with clear fit
      explanations and usable install actions.
- [ ] Hardware, RAM/VRAM/disk/context estimates are covered by deterministic fixtures and checked
      against the owner's real device.
- [ ] Download pause/resume/cancel, checksum failure, insufficient resources, load/unload, removal,
      offline chat after download, and measured tokens/second work.
- [ ] A real app-managed llama.cpp model responds through the packaged Tauri UI, with a screenshot
      of the prompt and useful final answer, redacted diagnostic logs, and a recorded benchmark.
- [ ] App restart during download and inference recovery does not duplicate side effects or corrupt
      the model/store.

### UI and accessibility

- [ ] Custom scrollbars are consistent and usable in every scroll container and theme.
- [ ] Minimize, maximize/restore, and close never cover content or become part of the drag region.
- [ ] Titlebar evidence covers restored, maximized, narrow, high-DPI, 200% zoom, keyboard focus, and
      high contrast.
- [ ] Provider forms and model-management controls have polished empty/loading/success/error states
      and do not fall back to generic OS/browser styling.
- [ ] Playwright or an equivalent WebView2-capable harness performs real interactions. Every visual
      claim also has a screenshot that was opened and inspected; DOM assertions alone are not visual
      acceptance.
- [ ] Keyboard-only, screen-reader streaming, focus order, reduced motion, 200–400% zoom/reflow,
      high contrast, long code/tables, and automated WCAG checks pass.

### Core regression and security

- [ ] Wrong/corrupt keys, migrations, backup/restore, object integrity, project isolation,
      branch-DAG properties, FTS-only search, and interrupted indexing pass.
- [ ] Forged commands/events, approval tampering/replay, path traversal, symlink/junction races,
      prompt injection, secret-log scans, sandbox network denial, resource exhaustion, and
      process-tree termination pass.
- [ ] Kill/restart tests cover provider streaming, local inference, downloads, tools, ingestion,
      artifact generation, approvals, tasks, and subagents without duplicated visible events or
      effects.
- [ ] The canonical scenario works: attach a repository, continue chatting during a durable task,
      inspect tools/citations, edit/export an artifact, retain decisions, switch hosted/local
      models, inspect/remove memory, restart, and resume.

## Live testing coordination

Use disposable profiles and never overwrite the owner's ordinary CupcakeAI data. The prior paths
under `out/` may be used as historical fixtures, but the Tauri candidate needs a clearly named new
test profile, new screenshots, and a new executable/installer path.

Before **any NVIDIA GPU work**, inspect `C:\Users\akshi\Desktop\Code Palace\gpu use.txt`. If it says
`yes`, another agent may be using the GPU: work elsewhere and do not take ownership. When it is
available, set it to `yes` immediately before GPU work and restore it to `no` immediately after the
model is unloaded and its server or sidecar has stopped. Never leave the marker at `yes` after a
failed test. Ordinary app rendering does not require GPU-model ownership; local NVIDIA inference,
loading, and benchmarking do.

For conversation quality, act like a person rather than sending only a ping:

- conduct several multi-turn chats with follow-up references, edits, regenerate/branch, stop and
  continue, a long response, Markdown/code/table content, and a deliberately ambiguous request;
- verify useful responses, continuity, model disclosure, latency, cancellation, usage, and error
  recovery in the rendered app;
- compare hosted and local behavior without expecting identical prose;
- tune product prompts or context assembly only from observable failures, and retest after changes;
- retain prompts, model identifiers, app/runtime versions, timing, and redacted evidence so the
  owner can reproduce the result.

## Final handoff to the owner

Do not say “RC ready” until every fresh check above is either passed or listed as a specific known
issue the owner has accepted. The final handoff must lead with:

1. what changed in response to each complaint;
2. the exact new Tauri executable and installer paths;
3. the exact disposable profile/data location;
4. the hosted and app-managed local models actually tested;
5. screenshots/video and redacted logs from real use;
6. measured startup, memory, and local tokens/second;
7. known issues and exact owner testing steps;
8. confirmation that the GPU marker is `no` and no test model/runtime remains loaded;
9. confirmation that nothing was pushed, published, released, or wired to a live updater.

The owner—not an automated test suite—decides whether this corrective Tauri build becomes the
CupcakeAI 2.0 release candidate.

## 2026-09-02 native-Windows customization checkpoint

Commit `bf8827a` on local `master` completes the owner-requested interaction and customization
pass. It adds pinned-to-latest chat scrolling with reader detachment and a Jump to latest control;
moves global search to a real top-of-shelf search field on `Ctrl+F`; provides slim, minimal, and
hidden scrollbar modes; adds a six-stage first-run/replayable onboarding tour; replaces the raw
custom-instructions textarea with a designed editor; adds encrypted local profile fields, four
Cupcake avatar choices, and bounded custom-image upload; and replaces provider initials with local
brand marks plus an explicit connected state.

The same commit adds native Tauri window preferences for Windows sign-in launch, open/minimized/
tray startup, taskbar presence, always-on-top, taskbar/tray minimization, and ask/tray/quit close
behavior. Quit paths stop the sidecar supervisor and clear temporary file grants. The local-model
settings now expose RAM fallback and a RAM ceiling. Loads pass this policy to the app-managed
llama.cpp runtime: VRAM-only requests all accelerated layers with automatic fitting disabled;
hybrid mode allows fitting and rejects model weights already above the configured RAM ceiling. The
Models page states the active policy rather than always promising RAM spill.

Verified headlessly after the change:

- renderer Vitest: 44/44;
- Windows Chromium Playwright: 17/17, including new onboarding/profile/scrollbar/RAM and chat-follow
  interactions, serious/critical axe checks, and all-theme AA checks;
- Rust desktop host: 25/25;
- runtime application plus Cupcake Local tests: 42/42 using `services/runtime/.venv`;
- Tauri package smoke: passed with both sidecars and the Cupcake Local CPU baseline.

The rebuilt test executable is
`apps/desktop/src-tauri/target/release/CupcakeAI.exe` (9,869,824 bytes, SHA-256
`53B976F497CB56CC0455854BE181D7027C115847A3287D9F3D0703317A66620B`). Headless visual-review
frames are under `E:\temp\cupcakeai-ui-qa\` for Profile, Providers, and Window; the onboarding
failure-capture frame was also opened and inspected before its selector-only test failure was fixed.

This checkpoint did not run a new live hosted-provider conversation, download/load a real local
model, exercise GPU inference, build a new NSIS installer, or repeat the complete installer/update/
uninstall and performance matrix above. Do not call the overall handoff RC-ready on the strength of
this checkpoint alone. The GPU marker was not acquired for this work and remained `no`; no model
runtime was launched. Nothing was pushed, published, released, or connected to an updater.
